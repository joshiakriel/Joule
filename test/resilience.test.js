"use strict";
// Fault injection at the server + durable-layer boundary. DRY_RUN, offline, deterministic.
// For every injected failure we assert: the user gets a correct response-or-clean-error,
// NO budget reservation leaks, NO corrupt stored totals, and the process stays up.
process.env.DRY_RUN = "true";
process.env.ROUTING_ENABLED = "true";
process.env.VERIFY_SAMPLE_RATE = "0";
delete process.env.UPSTREAM_API_KEY;

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const store = require("../src/store");
const verify = require("../src/verify");
const budget = require("../src/budget");
const semcache = require("../src/semcache");
const carbon = require("../src/carbon");
const config = require("../src/config");
const upstream = require("../src/upstream");
const pgstore = require("../src/pgstore");
const app = require("../src/server");

let server, base, tmpDir;
const post = (body, headers = {}) => fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const stats = async () => (await (await fetch(base + "/api/stats")).json());
const reserved = () => budget.stats().reserved.global;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "joule-res-"));
  store.init(tmpDir); require("../src/calibrate").setDir(tmpDir);
  verify.reset(); budget.reset();
  config.upstream.retryBaseMs = 1; config.upstream.retryJitter = false; // keep retries fast + deterministic
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  upstream.setFetch(null); config.clearOverrides();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- 1) provider timeout: retried, clean error, no leak, no phantom record ----
test("provider timeout → clean 502, reservation released, nothing metered, process up", async () => {
  store.clear(); budget.reset();
  const before = (await stats()).totals.requests;
  config.setOverrides({ dryRun: false, upstreamApiKey: "sk-secret-timeout", upstreamBaseUrl: "http://provider.test" });
  let calls = 0;
  upstream.setFetch(async () => { calls++; throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); });
  try {
    const res = await post({ model: "auto", messages: [{ role: "user", content: "force a live call that times out" }] });
    assert.equal(res.status, 502, "clean gateway error");
    const body = await res.json();
    assert.ok(body.error && body.error.message, "OpenAI-shaped error");
    assert.ok(!JSON.stringify(body).includes("sk-secret-timeout"), "key never leaks");
    assert.ok(calls >= 3, "retried before giving up");
    assert.ok(reserved() < 1e-9, "reservation released");
  } finally { upstream.setFetch(null); config.clearOverrides(); }
  assert.equal((await stats()).totals.requests, before, "no corrupt/partial record written");
});

// ---- 1b) provider 5xx that recovers on retry: user still gets a real answer ----
test("provider 500 then 200 on retry → user gets a correct response", async () => {
  store.clear(); budget.reset();
  config.setOverrides({ dryRun: false, upstreamApiKey: "sk-x", upstreamBaseUrl: "http://provider.test" });
  let calls = 0;
  upstream.setFetch(async () => {
    calls++;
    if (calls < 2) return { ok: false, status: 500, json: async () => ({ error: { message: "boom" } }), body: null };
    return { ok: true, status: 200, json: async () => ({ choices: [{ index: 0, message: { role: "assistant", content: "recovered answer" } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), body: null };
  });
  try {
    const res = await post({ model: "auto", messages: [{ role: "user", content: "transient then ok please" }] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.choices[0].message.content, "recovered answer");
    assert.ok(reserved() < 1e-9, "reservation committed, not leaked");
  } finally { upstream.setFetch(null); config.clearOverrides(); }
  assert.equal((await stats()).totals.requests, 1, "exactly one metered record for the eventual success");
});

// ---- 3) embeddings endpoint down → semantic layer skipped, request still served ----
test("embeddings down → semantic cache skipped, request served normally", async () => {
  store.clear(); semcache.reset(); semcache.configure({ enabled: true, minSimilarity: 0.5 });
  semcache.setEmbedder(() => { throw new Error("embeddings endpoint down"); });
  try {
    const res = await post({ model: "auto", messages: [{ role: "user", content: "answer me even though embeddings are down" }] });
    assert.equal(res.status, 200, "request succeeds");
    assert.notEqual(res.headers.get("x-joule-mode"), "semantic_cache", "did not use the semantic layer");
  } finally { semcache.reset(); }
});

// ---- 3b) grid/carbon API down → labelled fallback, request still completes with carbon ----
test("grid API down → fallback intensity (marked estimated), request still metered with carbon", async () => {
  const origFetch = global.fetch;
  config.setOverrides({ emToken: "tok" }); carbon.invalidate();
  global.fetch = async () => { throw new Error("grid unreachable"); };
  try {
    const g = await carbon.getIntensity();
    assert.equal(g.live, false, "not live");
    assert.match(g.source, /fallback/i, "source labelled as fallback/estimated");
    assert.ok(g.gPerKwh > 0, "still returns a usable intensity");
  } finally { global.fetch = origFetch; config.clearOverrides(); carbon.invalidate(); }
  // and a normal request still carries a carbon number
  store.clear();
  await post({ model: "auto", messages: [{ role: "user", content: "carbon still computed please" }] });
  assert.ok((await stats()).totals.carbonG.actual >= 0, "carbon still metered");
});

// ---- 4) database down mid-run → keep serving, buffer writes, reconcile on recovery ----
test("DB killed mid-run: writes buffer, proxy keeps serving, reconciles when the DB is back", async () => {
  const tableIds = []; let down = false;
  const fakePool = {
    on() {},
    async end() {},
    async query(sql, params) {
      if (/CREATE TABLE|SELECT 1/.test(sql)) { if (down) throw new Error("ECONNREFUSED"); return { rows: [{ ok: 1 }] }; }
      if (down) throw new Error("ECONNREFUSED");
      if (/^\s*INSERT/.test(sql)) { tableIds.push(params[0]); return { rows: [] }; }
      if (/TRUNCATE/.test(sql)) { tableIds.length = 0; return { rows: [] }; }
      if (/SELECT data/.test(sql)) return { rows: [] };
      return { rows: [] };
    }
  };
  const pg = pgstore.create({ _pool: fakePool, maxBufferedWrites: 100 });
  await pg.ensureSchema();

  pg.persistAdd({ id: "a", ts: new Date().toISOString(), tier: "small", mode: "dry_run", cached: false }, '{"id":"a"}');
  await pg.flush();
  assert.deepEqual(tableIds, ["a"], "healthy write persisted");
  assert.equal(pg.health().status, "ok");

  // --- DB goes down mid-run ---
  down = true;
  pg.persistAdd({ id: "b", ts: new Date().toISOString(), tier: "small", mode: "dry_run", cached: false }, '{"id":"b"}');
  pg.persistAdd({ id: "c", ts: new Date().toISOString(), tier: "large", mode: "dry_run", cached: false }, '{"id":"c"}');
  await pg.flush();
  assert.equal(pg.health().status, "degraded", "outage detected");
  assert.ok(pg.health().pendingWrites >= 2, "writes buffered, not lost");
  assert.deepEqual(tableIds, ["a"], "nothing written to the DB while down");

  // meanwhile the SERVER keeps serving from the in-memory mirror (durable write is off-path)
  store.clear();
  const res = await post({ model: "auto", messages: [{ role: "user", content: "served during a DB outage" }] });
  assert.equal(res.status, 200, "proxy still serves the user while the DB is down");

  // --- DB comes back: recover replays buffered writes in order ---
  down = false;
  const rec = await pg.recover();
  assert.equal(rec.ok, true);
  assert.equal(rec.pending, 0, "buffer drained");
  assert.deepEqual(tableIds, ["a", "b", "c"], "buffered writes replayed in order — DB reconciles with the mirror");
  assert.equal(pg.health().status, "ok");
  await pg.close();
});

// ---- 4b) provider stream breaks mid-response → partial recorded, reservation settled ----
test("provider stream breaks mid-response → response ends cleanly, reservation settled, process up", async () => {
  store.clear(); budget.reset();
  const stub = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"partial "}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"answer"}}]}\n\n');
    setTimeout(() => res.destroy(), 20); // kill the socket mid-stream (no [DONE], no usage)
  });
  await new Promise((r) => stub.listen(0, r));
  config.setOverrides({ dryRun: false, upstreamApiKey: "sk-stream", upstreamBaseUrl: `http://localhost:${stub.address().port}` });
  try {
    const res = await post({ model: "auto", stream: true, messages: [{ role: "user", content: "stream that will break" }] });
    assert.equal(res.status, 200, "headers already flushed with 200");
    let text = ""; try { text = await res.text(); } catch { /* connection cut — expected */ }
    assert.match(text, /partial/, "client received the partial delivery");
    assert.ok(reserved() < 1e-9, "reservation settled, not leaked, after the break");
  } finally { config.clearOverrides(); await new Promise((r) => stub.close(r)); }
  // process still healthy: a normal request still works
  assert.equal((await post({ model: "auto", messages: [{ role: "user", content: "still serving after a stream break" }] })).status, 200);
});

// ---- 5) malformed input → clean 400/413, never a crash ----
test("malformed JSON body → clean 400; oversized body → 413", async () => {
  const bad = await post("{ not valid json ", {});
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.type, "invalid_request_error");

  const huge = JSON.stringify({ model: "auto", messages: [{ role: "user", content: "x".repeat(3 * 1024 * 1024) }] });
  const big = await post(huge, {});
  assert.equal(big.status, 413, "oversized body rejected cleanly");
  // server is still healthy afterwards
  assert.equal((await post({ model: "auto", messages: [{ role: "user", content: "still alive" }] })).status, 200);
});

// ---- 6) health endpoint exposes component status ----
test("/api/health reports db / provider / grid component status", async () => {
  const h = await (await fetch(base + "/api/health")).json();
  assert.equal(h.ok, true);
  assert.ok(h.components, "components block present");
  assert.ok(["ok", "degraded"].includes(h.components.db.status), "db status");
  assert.equal(h.components.db.backend, "memory");
  assert.ok("status" in h.components.provider, "provider status");
  assert.ok(["live", "fallback", "unknown"].includes(h.components.grid.status), "grid status");
});
