"use strict";
// Correctness UNDER CONCURRENCY (the real load test, not just speed). DRY_RUN, offline,
// in-process. Fires many parallel requests and asserts: conservation (nothing lost or
// double-counted), reconciliation (/api/stats == /api/report == store), cache integrity,
// budget integrity (exactly K, never K+1 — no reservation race), and no leaked reservations.
process.env.DRY_RUN = "true";
process.env.ROUTING_ENABLED = "true";
process.env.VERIFY_SAMPLE_RATE = "0"; // isolate OUR request-path concurrency from background verify
delete process.env.UPSTREAM_API_KEY;

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("../src/store");
const verify = require("../src/verify");
const budget = require("../src/budget");
const config = require("../src/config");
const app = require("../src/server");

let server, base, tmpDir;
const post = (body, headers = {}) => fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const stats = async () => (await (await fetch(base + "/api/stats")).json());

// run `jobs` through `width` concurrent workers; collect status + timing
async function runPool(jobs, width) {
  const q = jobs.slice(), out = { statuses: [], errors: 0, latencies: [] };
  await Promise.all(Array.from({ length: width }, async () => {
    let j; while ((j = q.pop())) {
      const t0 = performance.now();
      try { const r = await post(j.body, j.headers); out.statuses.push(r.status); await r.text(); }
      catch { out.errors++; }
      out.latencies.push(performance.now() - t0);
    }
  }));
  return out;
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "joule-load-"));
  store.init(tmpDir); require("../src/calibrate").setDir(tmpDir);
  verify.reset(); budget.reset();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); fs.rmSync(tmpDir, { recursive: true, force: true }); });

test("CONSERVATION + RECONCILIATION under concurrent load (no lost/double-counted requests)", async () => {
  store.clear();
  const N = 1200;
  const jobs = [];
  for (let i = 0; i < N; i++) {
    const r = i % 10;
    if (r < 3) jobs.push({ body: { model: "auto", messages: [{ role: "user", content: "a repeated cacheable prompt" }] } });                 // concurrent identical -> cache
    else if (r < 7) jobs.push({ body: { model: "auto", messages: [{ role: "user", content: `simple hi thanks #${i}` }] } });                    // small, distinct
    else if (r < 9) jobs.push({ body: { model: "auto", messages: [{ role: "user", content: `Prove step by step and analyse the race condition and refactor #${i}` }] } }); // large
    else jobs.push({ body: { model: "auto", messages: [{ role: "user", content: `agent step ${i}` }] }, headers: { "x-joule-session": `agent-${i % 20}` } });
  }
  const res = await runPool(jobs, 100); // 100 concurrent workers

  assert.equal(res.errors, 0, "no network errors");
  assert.equal(res.statuses.length, N, "every request completed");
  assert.ok(res.statuses.every((s) => s === 200), "all 200 (no enforcement here)");

  const t = (await stats()).totals;
  // CONSERVATION: every request picked exactly one tier; none lost or double-counted
  assert.equal(t.requests, N, "store counted every request exactly once");
  assert.equal(t.routedSmall + t.routedLarge, t.requests, "small + large == total");
  assert.ok(t.cacheHits > 0, "concurrent identical prompts produced cache hits without corruption");

  // RECONCILIATION: three surfaces byte-identical after thousands of concurrent writes
  const report = (await (await fetch(base + "/api/report?format=json")).json()).totals;
  const agg = JSON.parse(JSON.stringify(store.aggregate()));
  assert.deepEqual(t, report, "/api/stats totals == /api/report totals");
  assert.deepEqual(t, agg, "/api/stats totals == store.aggregate()");
  // CSV export has exactly one row per counted request
  const csvRows = (await (await fetch(base + "/api/report?format=csv")).text()).split("\n").filter(Boolean).length - 1;
  assert.equal(csvRows, N, "one CSV row per request");
});

test("BUDGET call-cap respects IN-FLIGHT reservations before any commit (reservation race)", () => {
  // Models concurrency directly: many requests RESERVE before any COMMITs settle. The cap
  // must count in-flight reservations, else it admits K+N. (Pre-fix this returned all 25.)
  budget.reset();
  const saved = { ...config.budget };
  config.budget.enforce = true; config.budget.maxCallsPerSession = 20;
  try {
    const rvs = [];
    let ok = 0, rejected = 0;
    for (let i = 0; i < 25; i++) {
      const r = budget.reserve({ sessionId: "race", estCostUsd: 0.0001 }); // NB: no commit between reserves
      if (r.ok) { ok++; rvs.push(r); } else rejected++;
    }
    assert.equal(ok, 20, "exactly the cap is admitted while in-flight (never K+N)");
    assert.equal(rejected, 5, "the rest are rejected");
    // settle them; the in-flight call count must return to zero (no leak)
    rvs.forEach((r) => budget.commit(r, 0.0001));
    assert.equal(budget.stats().reserved.calls, 0, "no leaked in-flight call reservations");
    assert.ok(budget.stats().reserved.global < 1e-9, "no leaked cost reservations");
  } finally { Object.assign(config.budget, saved); budget.reset(); }
});

test("BUDGET integrity end-to-end: exactly K concurrent requests succeed, rest 429, none leak", async () => {
  store.clear(); budget.reset();
  const saved = { ...config.budget };
  const K = 15;
  config.budget.enforce = true; config.budget.maxCallsPerSession = K;
  try {
    // fire K*4 fully-concurrent requests on ONE session — launch all before any settles
    const total = K * 4;
    const statuses = await Promise.all(Array.from({ length: total }, (_, i) =>
      post({ model: "auto", messages: [{ role: "user", content: `budgeted ${i}` }] }, { "x-joule-session": "cap-session" })
        .then(async (r) => { await r.text(); return r.status; }).catch(() => 0)));
    const ok200 = statuses.filter((s) => s === 200).length;
    const got429 = statuses.filter((s) => s === 429).length;
    assert.equal(ok200, K, `exactly ${K} succeed — never ${K}+1 (that would be a reservation race)`);
    assert.equal(got429, total - K, "the rest are cleanly rejected with 429");

    // a DIFFERENT session is unaffected (isolation) even under the same load
    const other = await post({ model: "auto", messages: [{ role: "user", content: "other session ok" }] }, { "x-joule-session": "free-session" });
    assert.equal(other.status, 200);

    // no leaked reservations: reserved cost and in-flight calls both back to zero
    const b = (await stats()).budget;
    assert.ok(Math.abs(b.reserved.global) < 1e-9, "no leaked cost reservation");
    assert.equal(b.reserved.calls || 0, 0, "no leaked in-flight call reservation");

    // conservation still holds: only the admitted calls were metered
    const t = (await stats()).totals;
    assert.equal(t.requests, K + 1, "only the K admitted + the isolated request were metered");
  } finally { Object.assign(config.budget, saved); budget.reset(); }
});

test("no unhandled promise rejections fire during a concurrent burst", async () => {
  store.clear();
  const seen = [];
  const onRej = (e) => seen.push(e);
  process.on("unhandledRejection", onRej);
  try {
    const jobs = Array.from({ length: 300 }, (_, i) => ({ body: { model: "auto", messages: [{ role: "user", content: `burst ${i}` }] } }));
    await runPool(jobs, 80);
    await new Promise((r) => setTimeout(r, 50)); // let any stray microtasks flush
    assert.equal(seen.length, 0, `no unhandled rejections (saw ${seen.length})`);
  } finally { process.removeListener("unhandledRejection", onRej); }
});
