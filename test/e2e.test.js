"use strict";
// End-to-end + honesty + resilience seams. DRY_RUN, offline, deterministic. These
// complement integration.test.js by covering the SERVER-LEVEL wiring the unit tests
// can't: the reasoning override header, three-way reconciliation, reservation
// settlement on every exit path, provider-error resilience, and the shipped demo +
// agent scripts run against a live DRY_RUN server.
process.env.DRY_RUN = "true";
process.env.ROUTING_ENABLED = "true";
process.env.VERIFY_SAMPLE_RATE = "0"; // keep verification out of these unless opted in
delete process.env.UPSTREAM_API_KEY;
delete process.env.ELECTRICITYMAPS_TOKEN;

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

// Run a script async (NOT spawnSync — that would block this process's event loop and
// starve the in-process server the child is calling). Resolves with {status,stderr}.
function runScript(scriptRelPath, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, scriptRelPath)], {
      env: { ...process.env, ...extraEnv }, stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
    child.on("close", (status) => { clearTimeout(timer); resolve({ status, stderr }); });
  });
}

const store = require("../src/store");
const verify = require("../src/verify");
const budget = require("../src/budget");
const config = require("../src/config");
const app = require("../src/server");

let server, base, tmpDir;
const ROOT = path.join(__dirname, "..");

const post = (body, headers = {}) =>
  fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const stats = async () => (await (await fetch(base + "/api/stats")).json());

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "joule-e2e-"));
  store.init(tmpDir);
  require("../src/calibrate").setDir(tmpDir);
  verify.reset(); budget.reset();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---- 1) Routing: explicit reasoning-effort header overrides complexity ----
test("reasoning override header wins over complexity end-to-end", async () => {
  store.clear();
  config.setOverrides({ modelLarge: "o3" }); // hard prompts route to a reasoning model
  try {
    const hard = { model: "auto", messages: [{ role: "user", content: "prove and analyse step by step, deriving the architecture trade-offs in depth" }] };
    // default: a hard prompt earns a HIGH thinking budget
    await post(hard);
    const def = (await stats()).recent.find((x) => x.reasoning);
    assert.equal(def.reasoning.model, "o3");
    assert.equal(def.reasoning.effort, "high", "hard prompt defaults to high effort");

    // same hard prompt, caller forces low — the override must win
    store.clear();
    await post(hard, { "x-joule-reasoning-effort": "low" });
    const forced = (await stats()).recent.find((x) => x.reasoning);
    assert.equal(forced.reasoning.effort, "low", "explicit header overrides the complexity-derived effort");
    assert.ok(forced.reasoning.capTokens < def.reasoning.capTokens, "forced-low caps fewer thinking tokens than default-high");
  } finally { config.clearOverrides(); }
});

// ---- 5) Metering & honesty: the three-way reconciliation (the most important test) ----
test("RECONCILIATION: /api/stats totals == /api/report totals == store.aggregate(), field by field", async () => {
  store.clear(); verify.reset();
  // deterministic mixed traffic: smalls, larges, an exact-duplicate (cache hit), a tagged session
  const smalls = ["hi thanks a lot", "summarise this ticket briefly", "classify: login is slow", "translate hello to french", "one short greeting please"];
  const larges = ["Prove step by step and analyse why this algorithm has a race condition and refactor it",
    "Analyse the root cause and evaluate the mitigation trade-offs in depth, step by step"];
  for (const c of smalls) await post({ model: "auto", messages: [{ role: "user", content: c }] });
  for (const c of larges) await post({ model: "auto", messages: [{ role: "user", content: c }] });
  await post({ model: "auto", messages: [{ role: "user", content: smalls[0] }] }); // exact duplicate -> cache hit
  await post({ model: "auto", messages: [{ role: "user", content: "tagged small one" }] }, { "x-joule-session": "recon-run" });

  const s = (await stats()).totals;
  const r = (await (await fetch(base + "/api/report?format=json")).json()).totals;
  const sum = (await (await fetch(base + "/api/summary?range=all")).json()).totals;
  const agg = JSON.parse(JSON.stringify(store.aggregate())); // in-process store — the source of truth the server reads

  // the three API surfaces are byte-identical to each other and to the store
  assert.deepEqual(s, r, "stats totals == report totals");
  assert.deepEqual(s, agg, "stats totals == store.aggregate()");
  assert.deepEqual(sum, agg, "summary totals == store.aggregate()");

  // CSV export has exactly one row per counted request
  const csvRows = (await (await fetch(base + "/api/report?format=csv")).text()).split("\n").filter(Boolean).length - 1;
  assert.equal(csvRows, s.requests, "one CSV row per request");

  // internal identities that must always hold
  assert.equal(s.requests, smalls.length + larges.length + 2);
  assert.equal(s.routedSmall + s.routedLarge, s.requests, "every request routed small or large");
  assert.equal(s.cacheHits, 1, "the exact duplicate is the only cache hit");
  assert.ok(Math.abs((s.routingSavedUsd + s.cacheSavedUsd + s.semantic.netSavedUsd) - s.cost.saved) < 1e-9, "savings lines sum to total saved");
  assert.ok(Math.abs((s.routingEnergy.actual + s.cacheEnergy.actual) - s.energyWh.actual) < 1e-9, "per-lever energy splits sum to total");
  assert.ok(Math.abs(s.net.costSaved - (s.cost.saved - s.verifyCost.costUsd)) < 1e-9, "net = saved - verification overhead");
  assert.ok(s.cost.baseline >= s.cost.actual, "baseline (always-large) >= actual");
});

// ---- 4) Budgets: reservations settle on EVERY exit path — no leaks ----
test("no leaked reservations: success, streaming, and client-abort all settle to reserved≈0", async () => {
  store.clear(); budget.reset();
  const reserved = () => budget.stats().reserved.global;

  await post({ model: "auto", messages: [{ role: "user", content: "settle on success please" }] });
  assert.ok(reserved() < 1e-9, "success path commits its reservation");

  const sres = await post({ model: "auto", stream: true, messages: [{ role: "user", content: "settle on a streamed answer" }] });
  await sres.text();
  assert.ok(reserved() < 1e-9, "stream path commits its reservation");

  // client aborts mid-stream: the DRY stream writes+commits synchronously, so nothing dangles
  const ac = new AbortController();
  const p = fetch(base + "/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" }, signal: ac.signal,
    body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "abort me midway" }] })
  }).catch(() => {});
  ac.abort();
  await p;
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(reserved() < 1e-9, "aborted stream leaves no reservation behind");
});

// ---- 7) Resilience seam: a provider error is clean, corrupts nothing, leaks nothing ----
test("provider error: clean error response, totals uncorrupted, reservation released, no secret leak", async () => {
  store.clear(); budget.reset();
  const SECRET = "sk-provider-secret-9999";
  const before = (await stats()).totals.requests;

  // a stub upstream that always 500s
  const upstream = http.createServer((req, res) => { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "upstream is down" } })); });
  await new Promise((r) => upstream.listen(0, r));
  const upBase = `http://localhost:${upstream.address().port}`;
  config.setOverrides({ dryRun: false, upstreamApiKey: SECRET, upstreamBaseUrl: upBase });
  try {
    const res = await post({ model: "auto", messages: [{ role: "user", content: "a fresh uncached prompt to force an upstream call" }] });
    assert.equal(res.status, 500, "provider status is surfaced");
    const body = await res.json();
    assert.ok(body.error, "clean machine-readable error body");
    assert.ok(!JSON.stringify(body).includes(SECRET), "the upstream key never leaks into the error");
    assert.ok(budget.stats().reserved.global < 1e-9, "reservation released on provider error");
  } finally {
    config.clearOverrides();
    await new Promise((r) => upstream.close(r));
  }
  // the failed request was never metered — stored totals are exactly as before
  assert.equal((await stats()).totals.requests, before, "a provider error adds no phantom record");
});

test("provider unreachable (connection refused): 502 clean error, no leaked reservation", async () => {
  store.clear(); budget.reset();
  const before = (await stats()).totals.requests;
  // point at a port with nothing listening -> fetch throws -> caught cleanly
  config.setOverrides({ dryRun: false, upstreamApiKey: "sk-x", upstreamBaseUrl: "http://127.0.0.1:1" });
  try {
    const res = await post({ model: "auto", messages: [{ role: "user", content: "another fresh prompt that cannot be served" }] });
    assert.equal(res.status, 502, "unreachable provider yields a clean 502");
    assert.ok((await res.json()).error, "error body present");
    assert.ok(budget.stats().reserved.global < 1e-9, "reservation released on thrown error");
  } finally { config.clearOverrides(); }
  assert.equal((await stats()).totals.requests, before, "no record written for the failed call");
});

// ---- 6) End-to-end: the shipped demo + agent scripts against a DRY_RUN server ----
test("scripts/demo.js runs against the DRY_RUN server and produces internally consistent stats", async () => {
  store.clear();
  const run = await runScript("scripts/demo.js", { DEMO_TARGET: base, DEMO_COUNT: "16" });
  assert.equal(run.status, 0, `demo exited cleanly:\n${run.stderr}`);

  const t = (await stats()).totals;
  assert.ok(t.requests >= 16, "demo drove real traffic");
  assert.equal(t.routedSmall + t.routedLarge, t.requests, "small + large == total");
  assert.ok(t.cost.baseline >= t.cost.actual && t.energyWh.baseline >= t.energyWh.actual, "savings = baseline - actual, never negative");
  assert.ok(Math.abs((t.routingSavedUsd + t.cacheSavedUsd + t.semantic.netSavedUsd) - t.cost.saved) < 1e-9, "savings lines reconcile");

  // sessions partition the log exactly: their calls sum to the total
  const sum = await (await fetch(base + "/api/summary?range=all")).json();
  assert.equal(sum.sessions.reduce((n, x) => n + x.calls, 0), t.requests, "sessions sum to total requests");
});

test("examples/agent-workload.js runs as one tagged session and reconciles with the server", async () => {
  store.clear();
  const run = await runScript("examples/agent-workload.js", { DEMO_TARGET: base });
  assert.equal(run.status, 0, `agent example exited cleanly:\n${run.stderr}`);

  const sum = await (await fetch(base + "/api/summary?range=all")).json();
  assert.ok(sum.totals.requests > 0, "agent drove traffic");
  assert.equal(sum.totals.routedSmall + sum.totals.routedLarge, sum.totals.requests);
  const tagged = sum.sessions.filter((s) => s.tagged);
  assert.ok(tagged.length >= 1, "the agent run is a tagged session");
  // every session's small+large accounts for all its calls
  for (const s of sum.sessions) assert.equal(s.small + s.large, s.calls, `session ${s.id} tiers sum to calls`);
});
