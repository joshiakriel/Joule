"use strict";
// Offline integration test: DRY_RUN, no API key, no external network. Must be set
// BEFORE requiring any src module (config reads env once at require time).
process.env.DRY_RUN = "true";
process.env.ROUTING_ENABLED = "true";
process.env.VERIFY_SAMPLE_RATE = "0"; // off by default here; verify-specific tests opt in explicitly
delete process.env.UPSTREAM_API_KEY;
delete process.env.ELECTRICITYMAPS_TOKEN;

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("../src/store");
const verify = require("../src/verify");
const semcache = require("../src/semcache");
const budget = require("../src/budget");
const config = require("../src/config");
const app = require("../src/server");

let server, base, tmpDir;

const post = (body, headers = {}) =>
  fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "joule-int-"));
  store.init(tmpDir); // isolate: server + store now write here, not data/log.jsonl
  require("../src/calibrate").setDir(tmpDir);
  verify.reset(); budget.reset(); // clean verification + budget state for the early tests
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("non-streaming returns OpenAI-shaped JSON and all eight x-joule-* headers", async () => {
  const res = await post({ model: "auto", messages: [{ role: "user", content: "hi thanks" }] });
  assert.equal(res.status, 200);
  const headers = ["mode", "tier", "model", "cost-usd", "energy-wh", "co2-g", "saved-usd", "saved-co2-g"];
  for (const h of headers) assert.ok(res.headers.get("x-joule-" + h) !== null, `missing x-joule-${h}`);
  const body = await res.json();
  assert.equal(body.object, "chat.completion");
  assert.ok(body.choices?.[0]?.message?.content, "has an assistant message");
  assert.ok(body.usage?.total_tokens > 0, "reports token usage");
});

test("streaming (stream:true) returns SSE chunks ending in [DONE]", async () => {
  const res = await post({ model: "auto", stream: true, messages: [{ role: "user", content: "stream me a short answer please" }] });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /^data: /m, "has SSE data lines");
  assert.match(text, /"delta"/, "has chat.completion.chunk deltas");
  assert.ok(text.trimEnd().endsWith("data: [DONE]"), "stream ends in [DONE]");
});

test("both paths increment /api/stats totals and appear in /api/report", async () => {
  const before = (await (await fetch(base + "/api/stats")).json()).totals.requests;
  await post({ model: "auto", messages: [{ role: "user", content: "one non streaming request" }] });
  await post({ model: "auto", stream: true, messages: [{ role: "user", content: "one streaming request" }] });

  const totals = (await (await fetch(base + "/api/stats")).json()).totals;
  assert.equal(totals.requests, before + 2, "stats counts both requests");

  const reportJson = await (await fetch(base + "/api/report?format=json")).json();
  assert.ok(reportJson.totals.requests >= before + 2);
  assert.ok(reportJson.methodology, "report carries the methodology block");

  const csv = await (await fetch(base + "/api/report?format=csv")).text();
  const rows = csv.split("\n").filter(Boolean);
  assert.ok(rows[0].startsWith("timestamp,mode,model,tier,cached,"));
  assert.equal(rows.length - 1, totals.requests, "one CSV row per logged request");
});

test("a repeated identical request reports mode:cache and increments cacheHits", async () => {
  const msg = [{ role: "user", content: "identical prompt used twice for cache" }];
  const hitsBefore = (await (await fetch(base + "/api/stats")).json()).totals.cacheHits;

  const first = await post({ model: "auto", messages: msg });
  assert.notEqual(first.headers.get("x-joule-mode"), "cache", "first call is not a cache hit");
  const second = await post({ model: "auto", messages: msg });
  assert.equal(second.headers.get("x-joule-mode"), "cache", "second identical call hits cache");

  const hitsAfter = (await (await fetch(base + "/api/stats")).json()).totals.cacheHits;
  assert.equal(hitsAfter, hitsBefore + 1);
});

test("routing: trivial prompt logs tier small, reasoning prompt logs large", async () => {
  const trivial = await post({ model: "auto", messages: [{ role: "user", content: "hey there thanks" }] });
  assert.equal(trivial.headers.get("x-joule-tier"), "small");

  const reasoning = await post({
    model: "auto",
    messages: [{ role: "user", content: "Prove step by step and analyse why this algorithm has a race condition and refactor it" }]
  });
  assert.equal(reasoning.headers.get("x-joule-tier"), "large");
});

test("/api/summary returns filtered aggregates that match the server, plus series/perModel", async () => {
  store.clear();
  await post({ model: "auto", messages: [{ role: "user", content: "hi thanks a lot" }] });          // small
  await post({ model: "auto", messages: [{ role: "user", content: "Prove and analyse step by step this proof and evaluate the trade-offs" }] }); // large

  const all = await (await fetch(base + "/api/summary?range=all")).json();
  assert.equal(all.totals.requests, 2);
  assert.equal(all.series.length, 24);
  assert.equal(all.perModel.reduce((n, m) => n + m.calls, 0), 2);
  assert.ok(all.window.from && all.window.to, "reports its time window");

  // tier filter must agree with /api/report for the same params
  const small = await (await fetch(base + "/api/summary?tier=small")).json();
  assert.equal(small.totals.routedLarge, 0);
  assert.ok(small.totals.routedSmall >= 1);
  const csv = await (await fetch(base + "/api/report?tier=small&format=csv")).text();
  const rows = csv.split("\n").filter(Boolean).length - 1; // minus header
  assert.equal(rows, small.totals.requests, "filtered export matches filtered summary");
});

test("a session-tagged run groups into one labelled session with correct totals", async () => {
  store.clear();
  const sid = "test-agent-run-1";
  await post({ model: "auto", messages: [{ role: "user", content: "classify priority: login slow" }] }, { "x-joule-session": sid });
  await post({ model: "auto", messages: [{ role: "user", content: "summarize this ticket briefly" }] }, { "x-joule-session": sid });
  await post({ model: "auto", messages: [{ role: "user", content: "Analyse the root cause step by step and evaluate mitigation trade-offs" }] }, { "x-joule-session": sid });

  const sum = await (await fetch(base + "/api/summary?range=all")).json();
  const sess = sum.sessions.find((s) => s.id === sid);
  assert.ok(sess, "session present");
  assert.equal(sess.tagged, true);
  assert.equal(sess.calls, 3);
  assert.equal(sess.large, 1);
  assert.equal(sess.small, 2);
  assert.ok(sess.carbonG.actual > 0);
});

test("/api/stats + /api/report expose a cache block (separate line, advisory, zero-risk note)", async () => {
  store.clear();
  await post({ model: "auto", messages: [{ role: "user", content: "summarise this ticket in one line" }] });          // benign
  await post({ model: "auto", messages: [{ role: "user", content: "request id 123456789 at 2026-07-25T10:00 do it" }] }); // hostile
  const c = (await (await fetch(base + "/api/stats")).json()).cache;
  assert.ok(c, "stats has a cache block");
  assert.ok("prefixCache" in c && "netSavedUsd" in c.prefixCache, "prefix-cache savings line present");
  assert.ok("routingSavedUsd" in c && "exactCacheSavedUsd" in c, "routing vs cache savings kept separate");
  assert.ok(c.hostileRate > 0, "cache-hostile prompt detected");
  assert.ok(Array.isArray(c.tips) && c.tips.length > 0, "advisory tips produced");
  assert.match(c.note, /zero quality risk/i);
  const rep = await (await fetch(base + "/api/report?format=json")).json();
  assert.match(rep.methodology.cache, /separate line/i);
  assert.ok(rep.cache && "prefixCache" in rep.cache);
});

// NOTE: the server's in-memory exact cache persists across tests, so each semantic
// test uses a UNIQUE base phrase (and distinct near-dups) to avoid exact-cache cross-talk.
test("semantic cache (opt-in) serves a near-duplicate and reports safety metrics on its own line", async () => {
  store.clear(); semcache.reset(); semcache.configure({ enabled: true, baseThreshold: 0.8, minSimilarity: 0.5, verifyRate: 1 });
  try {
    const first = await post({ model: "auto", messages: [{ role: "user", content: "summarise the annual revenue memo briefly" }] });
    assert.notEqual(first.headers.get("x-joule-mode"), "semantic_cache", "first is a miss (stored)");
    const second = await post({ model: "auto", messages: [{ role: "user", content: "summarise the annual revenue memo briefly please" }] });
    assert.equal(second.headers.get("x-joule-mode"), "semantic_cache", "near-duplicate served from semantic cache");
    await new Promise((r) => setTimeout(r, 10));
    const c = (await (await fetch(base + "/api/stats")).json()).cache;
    assert.equal(c.semantic.enabled, true);
    assert.ok(c.semantic.hits >= 1, "semantic hit counted");
    assert.ok("netSavedUsd" in c.semantic && "realisedErrorRate" in c.semantic, "savings + realised error reported together");
    for (const k of ["namespaces", "minSimilarity", "ttlSec", "version", "bypassCount", "similarityDistribution", "autoDisabled"]) assert.ok(k in c.semantic, "safety metric " + k);
    assert.match(c.semantic.note, /namespace-isolated/i);
    const rep = await (await fetch(base + "/api/report?format=json")).json();
    assert.ok("semantic" in rep.cache);
  } finally { semcache.reset(); }
});

test("semantic cache ISOLATION: tenant B never gets tenant A's cached answer (over HTTP)", async () => {
  store.clear(); semcache.reset(); semcache.configure({ enabled: true, baseThreshold: 0.8, minSimilarity: 0.5, verifyRate: 1 });
  try {
    await post({ model: "auto", messages: [{ role: "user", content: "outline the regional logistics plan briefly" }] }, { "x-joule-tenant": "tenant-A" }); // store under A
    const b = await post({ model: "auto", messages: [{ role: "user", content: "outline the regional logistics plan briefly now" }] }, { "x-joule-tenant": "tenant-B" });
    assert.notEqual(b.headers.get("x-joule-mode"), "semantic_cache", "tenant B must NOT get A's cached answer");
    const a2 = await post({ model: "auto", messages: [{ role: "user", content: "outline the regional logistics plan briefly please" }] }, { "x-joule-tenant": "tenant-A" });
    assert.equal(a2.headers.get("x-joule-mode"), "semantic_cache", "same-tenant near-duplicate hits");
  } finally { semcache.reset(); }
});

test("sensitive-query bypass: X-Joule-Cache-Bypass skips the semantic layer, still metered", async () => {
  store.clear(); semcache.reset(); semcache.configure({ enabled: true, baseThreshold: 0.8, minSimilarity: 0.5, verifyRate: 1 });
  try {
    await post({ model: "auto", messages: [{ role: "user", content: "recap the vendor onboarding notes briefly" }] });
    const bypassed = await post({ model: "auto", messages: [{ role: "user", content: "recap the vendor onboarding notes briefly please" }] }, { "x-joule-cache-bypass": "true" });
    assert.notEqual(bypassed.headers.get("x-joule-mode"), "semantic_cache", "bypassed request hits the model, not the semantic cache");
    const c = (await (await fetch(base + "/api/stats")).json()).cache;
    assert.ok(c.semantic.bypassCount >= 1, "bypass logged");
    assert.ok((await (await fetch(base + "/api/stats")).json()).totals.requests >= 2, "still metered");
  } finally { semcache.reset(); }
});

test("/api/roi reconciles with /api/summary and renders an empty state with no data", async () => {
  store.clear();
  // empty state
  let roi = await (await fetch(base + "/api/roi")).json();
  assert.equal(roi.empty, true);
  assert.equal(roi.series.length, 0);
  // with data: cumulative saved reconciles with /api/summary for all time
  for (let i = 0; i < 5; i++) await post({ model: "auto", messages: [{ role: "user", content: `roi check ${i} please` }] });
  roi = await (await fetch(base + "/api/roi")).json();
  assert.equal(roi.empty, false);
  const sum = await (await fetch(base + "/api/summary?range=all")).json();
  const cum = roi.series[roi.series.length - 1].cumSavedCost;
  assert.ok(Math.abs(cum - sum.totals.cost.saved) < 1e-9, "cumulative ROI saved == summary saved");
  assert.ok(Math.abs(roi.lifetime.savedCost - sum.totals.cost.saved) < 1e-9, "lifetime reconciles");
  assert.ok("netAfterFees" in roi.net, "net-of-fees exposed");
});

test("POST /v1/batch processes async at the batch discount (zero quality risk, separate line)", async () => {
  store.clear();
  const submit = await fetch(base + "/v1/batch", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ requests: [
      { custom_id: "a", messages: [{ role: "user", content: "summarise item one briefly" }] },
      { custom_id: "b", messages: [{ role: "user", content: "analyse and evaluate this design deeply step by step" }] }
    ] })
  });
  assert.equal(submit.status, 202, "submission accepted");
  const { id, status, count } = await submit.json();
  assert.equal(status, "queued"); assert.equal(count, 2);
  // poll to completion
  let job;
  for (let i = 0; i < 20; i++) {
    job = await (await fetch(base + "/v1/batch/" + id)).json();
    if (job.status === "completed") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(job.status, "completed");
  assert.equal(job.completed, 2);
  assert.equal(job.results.length, 2);
  assert.ok(job.results.find((r) => r.custom_id === "b").tier === "large", "complex item routed large");
  assert.ok(job.totals.savedUsd > 0, "batch discount saved money");
  // surfaced on its own line, flagged zero quality risk
  const b = (await (await fetch(base + "/api/stats")).json()).batch;
  assert.equal(b.count, 2);
  assert.ok(b.savedUsd > 0);
  assert.match(b.note, /zero quality risk/i);
  const missing = await fetch(base + "/v1/batch/does-not-exist");
  assert.equal(missing.status, 404);
});

test("POST /v1/batch rejects an empty request list", async () => {
  const res = await fetch(base + "/v1/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requests: [] }) });
  assert.equal(res.status, 400);
});

test("GET /api/advisory returns quantified cache findings; X-Joule-Latency-Tolerant credits the batch line", async () => {
  store.clear();
  await post({ model: "auto", messages: [{ role: "user", content: "request id 123456789 at 2026-07-25T10:00 summarise" }] }); // hostile
  const adv = await (await fetch(base + "/api/advisory")).json();
  assert.ok(adv.requests >= 1);
  assert.ok(adv.findings.find((f) => f.pattern === "dynamic-content-before-static"), "hostile finding present");
  // latency-tolerant header records batch-eligible savings on the batch line
  const before = (await (await fetch(base + "/api/stats")).json()).batch.count;
  await post({ model: "auto", messages: [{ role: "user", content: "a latency tolerant job" }] }, { "x-joule-latency-tolerant": "true" });
  const after = (await (await fetch(base + "/api/stats")).json()).batch.count;
  assert.equal(after, before + 1, "batch-eligible request counted");
});

test("reasoning-budget control: caps a reasoning model and meters thinking tokens separately", async () => {
  store.clear();
  config.setOverrides({ modelLarge: "o3" }); // route complex prompts to a reasoning model
  try {
    const res = await post({ model: "auto", messages: [{ role: "user", content: "prove and analyse step by step, deriving the architecture trade-offs in depth" }] });
    assert.equal(res.headers.get("x-joule-model"), "o3");
    const r = (await (await fetch(base + "/api/stats")).json()).reasoning;
    assert.equal(r.requests, 1, "reasoning request metered");
    assert.ok(r.reasoningTokens > 0, "thinking tokens counted separately");
    assert.ok(r.savedUsd >= 0);
    assert.ok(r.avgThinkingBudget > 0);
    const rec = (await (await fetch(base + "/api/stats")).json()).recent.find((x) => x.reasoning);
    assert.equal(rec.reasoning.model, "o3");
    assert.ok(rec.reasoning.capTokens <= config.reasoning.maxThinkingTokens, "budget capped");
  } finally { config.clearOverrides(); }
});

test("reasoning->standard downgrade (opt-in) routes a simple prompt off the reasoning model", async () => {
  store.clear();
  config.setOverrides({ modelSmall: "o3" }); // small tier is a reasoning model
  const savedDown = config.reasoning.downgradeEnabled, savedStd = config.reasoning.standardModel;
  config.reasoning.downgradeEnabled = true; config.reasoning.standardModel = "gpt-4o-mini";
  try {
    const res = await post({ model: "auto", messages: [{ role: "user", content: "hi thanks" }] }); // simple -> small
    assert.equal(res.headers.get("x-joule-model"), "gpt-4o-mini", "downgraded off the reasoning model");
    const rec = (await (await fetch(base + "/api/stats")).json()).recent.find((x) => x.reasoning);
    assert.equal(rec.reasoning.downgraded, true);
    assert.ok(rec.reasoning.savedTokens > 0, "downgrade avoids reasoning tokens");
    assert.equal(rec.reasoning.reasoningTokens, 0, "no thinking tokens on the standard model");
  } finally { config.reasoning.downgradeEnabled = savedDown; config.reasoning.standardModel = savedStd; config.clearOverrides(); }
});

test("GET /metrics exposes Prometheus/OTel-compatible metrics from the real log", async () => {
  store.clear();
  await post({ model: "auto", messages: [{ role: "user", content: "summarise this briefly" }] });
  const res = await fetch(base + "/metrics");
  assert.match(res.headers.get("content-type") || "", /text\/plain/);
  const text = await res.text();
  assert.match(text, /# TYPE joule_requests_total counter/);
  assert.match(text, /joule_requests_total\{model=".+",tier=".+"\} \d+/);
  assert.match(text, /joule_cost_usd_total/);
  const health = await (await fetch(base + "/api/health")).json();
  assert.ok(health.otel && "otlpExport" in health.otel, "health reports otel status");
});

test("budget enforcement rejects an over-cap request (429) before any model call", async () => {
  store.clear(); budget.reset();
  const saved = { ...config.budget };
  config.budget.enforce = true; config.budget.sessionUsd = 0.0001; // estimate exceeds this
  try {
    const capped = await post({ model: "auto", messages: [{ role: "user", content: "hello there please" }] }, { "x-joule-session": "cap-test" });
    assert.equal(capped.status, 429, "over-cap session request is blocked");
    const body = await capped.json();
    assert.equal(body.error.budget.scope, "session");
    const before = (await (await fetch(base + "/api/stats")).json()).totals.requests;
    // a request WITHOUT that session is not affected by the per-session cap
    const ok = await post({ model: "auto", messages: [{ role: "user", content: "hello there please" }] });
    assert.equal(ok.status, 200);
    // the blocked request never reached metering (no store record for it)
    const stats = await (await fetch(base + "/api/stats")).json();
    assert.ok(stats.budget.rejected >= 1, "rejection counted");
    assert.equal(stats.budget.enforce, true);
    assert.equal(stats.totals.requests, before + 1, "only the allowed request was metered");
  } finally { Object.assign(config.budget, saved); budget.reset(); }
});

test("per-session call cap terminates a runaway session; other sessions are unaffected (isolation)", async () => {
  store.clear(); budget.reset();
  const saved = { ...config.budget };
  config.budget.enforce = true; config.budget.maxCallsPerSession = 2;
  try {
    const msg = [{ role: "user", content: "hi thanks" }];
    assert.equal((await post({ model: "auto", messages: msg }, { "x-joule-session": "runaway" })).status, 200);
    assert.equal((await post({ model: "auto", messages: msg }, { "x-joule-session": "runaway" })).status, 200);
    const blocked = await post({ model: "auto", messages: msg }, { "x-joule-session": "runaway" }); // 3rd call -> over cap
    assert.equal(blocked.status, 429, "runaway session blocked after its call cap");
    // a DIFFERENT session still works — isolation
    assert.equal((await post({ model: "auto", messages: msg }, { "x-joule-session": "other" })).status, 200);
    // and the runaway session is marked terminated
    const b = await (await fetch(base + "/api/budgets")).json();
    assert.ok(b.terminatedSessions.find((t) => t.id === "runaway"), "runaway session terminated");
    assert.ok(b.events.length >= 1, "audit trail records the block");
  } finally { Object.assign(config.budget, saved); budget.reset(); }
});

test("GET /api/budgets exposes definitions, spend and fail mode", async () => {
  const b = await (await fetch(base + "/api/budgets")).json();
  assert.ok("definitions" in b && "terminatedSessions" in b && "events" in b);
  assert.ok(["fail_open", "fail_closed"].includes(b.failMode));
});

test("metering-only budget (enforce=false) flags would-be breaches but never blocks", async () => {
  store.clear(); budget.reset();
  const saved = { ...config.budget };
  config.budget.enforce = false; config.budget.sessionUsd = 0.0001;
  try {
    const res = await post({ model: "auto", messages: [{ role: "user", content: "hello there please" }] }, { "x-joule-session": "flag-test" });
    assert.equal(res.status, 200, "not blocked when enforcement is off");
    const b = (await (await fetch(base + "/api/stats")).json()).budget;
    assert.equal(b.rejected, 0);
    assert.ok(b.wouldReject >= 1, "would-be breach flagged for reporting");
  } finally { Object.assign(config.budget, saved); budget.reset(); }
});

test("POST /api/clear truly empties the store", async () => {
  store.clear();
  await post({ model: "auto", messages: [{ role: "user", content: "something to log" }] });
  assert.ok((await (await fetch(base + "/api/stats")).json()).totals.requests >= 1);
  const cleared = await (await fetch(base + "/api/clear", { method: "POST" })).json();
  assert.equal(cleared.cleared, true);
  assert.equal((await (await fetch(base + "/api/stats")).json()).totals.requests, 0);
});

test("verification runs OFF the serving path — response returns before it completes", async () => {
  store.clear(); verify.reset(); verify.configure({ sampleRate: 1 }); verify.setTestDelay(400);
  const t0 = Date.now();
  const res = await post({ model: "auto", messages: [{ role: "user", content: "hi thanks so much" }] }); // small
  const dt = Date.now() - t0;
  assert.equal(res.status, 200);
  await res.json();
  assert.ok(dt < 300, `response must not wait for the 400ms verification (took ${dt}ms)`);
  assert.ok(verify.inFlightCount() >= 1, "verification is still running after the response returned");
  await verify.whenIdle();
  verify.setTestDelay(0);
});

test("/api/stats + /api/summary expose quality; a sampled small request gets verified", async () => {
  store.clear(); verify.reset(); verify.configure({ sampleRate: 1 });
  await post({ model: "auto", messages: [{ role: "user", content: "hey there, thank you" }] }); // small -> sampled
  await verify.whenIdle();

  const stats = await (await fetch(base + "/api/stats")).json();
  assert.ok(stats.quality, "stats has a quality block");
  assert.equal(stats.quality.verified, 1);
  assert.ok(stats.quality.score > 0 && stats.quality.score <= 1);
  assert.ok(stats.quality.overhead.tokens > 0, "verification overhead exposed");
  assert.ok("net" in stats.quality, "net-of-verification savings exposed");

  const sum = await (await fetch(base + "/api/summary?range=all")).json();
  assert.equal(sum.quality.verified, 1);
  assert.ok(sum.recent[0].verification, "verified record carries its verification");

  const report = await (await fetch(base + "/api/report?format=json")).json();
  assert.equal(report.verification.sampled, true);
  assert.ok(/sampled/i.test(report.methodology.verification), "report states sampling + fallible judge");
});

test("quality never shows a fake 100% before any samples", async () => {
  store.clear(); verify.reset(); verify.configure({ sampleRate: 0 }); // never sample
  await post({ model: "auto", messages: [{ role: "user", content: "hi" }] });
  const stats = await (await fetch(base + "/api/stats")).json();
  assert.equal(stats.quality.score, null, "null, not 100%, when nothing verified");
  assert.equal(stats.quality.rollingScore, null);
});

test("safety mode (low quality) biases routing to the large model", async () => {
  store.clear(); verify.reset();
  verify.configure({ minSamples: 2, rollingWindow: 5, qualityThreshold: 0.8, probeRate: 0 });
  for (let i = 0; i < 3; i++) verify.pushScore(0.2); // force rolling below threshold
  assert.equal(verify.safetyMode(), true);
  assert.equal((await (await fetch(base + "/api/stats")).json()).quality.safetyMode, true);

  // a normally-small prompt must now be escalated to large
  const res = await post({ model: "auto", messages: [{ role: "user", content: "hi thanks" }] });
  assert.equal(res.headers.get("x-joule-tier"), "large", "escalated under safety mode");
  await verify.whenIdle();
  verify.reset();
});

test("calibrated + conformal: samples accumulate, a guarantee forms, /api/stats exposes it", async () => {
  store.clear(); verify.reset();
  verify.configure({ sampleRate: 1, minCalibrationN: 20, mode: "conformal" });
  // drive distinct small prompts (avoid cache) so labels accumulate past MIN_CALIBRATION_N
  for (let i = 0; i < 30; i++) {
    await post({ model: "auto", messages: [{ role: "user", content: `hi thanks number ${i} kindly` }] });
  }
  await verify.whenIdle();
  const q = (await (await fetch(base + "/api/stats")).json()).quality;
  assert.ok(q.calibration.n >= 20, `calibration grew (n=${q.calibration.n})`);
  assert.equal(q.calibration.ready, true);
  assert.equal(q.mode, "conformal");
  assert.equal(q.conformal.ready, true, "conformal threshold computed");
  assert.ok(q.conformal.coverage >= 1 - q.conformal.alpha - 0.1, "empirical coverage near (1-alpha)");
  assert.equal(q.guaranteeReady, true);
  assert.ok(q.conformal.alpha === 0.05, "alpha reported alongside the claim");
  // report states the marginal, sampled, fallible-judge caveats
  const rep = await (await fetch(base + "/api/report?format=json")).json();
  assert.match(rep.methodology.verification, /marginal/i);
  assert.match(rep.methodology.verification, /conformal/i);
  verify.reset();
});

test("LOG_PROMPTS=false (default): no prompt/response text is persisted anywhere", async () => {
  store.clear();
  const secret = "reach me at alice@example.com or 0501234567 about invoice 123456789";
  await post({ model: "auto", messages: [{ role: "user", content: secret }] });
  // not in the API response
  const stats = await (await fetch(base + "/api/stats")).json();
  assert.ok(!JSON.stringify(stats).includes("alice@example.com"), "no prompt text in /api/stats");
  assert.equal(stats.recent[0].prompt, undefined, "record carries no prompt text");
  assert.equal(stats.recent[0].completion, undefined, "record carries no completion text");
  // not on disk
  const disk = fs.readFileSync(path.join(tmpDir, "log.jsonl"), "utf8");
  assert.ok(!disk.includes("alice@example.com") && !disk.includes("0501234567"), "no prompt text on disk");
  // deployment posture reports metadata-only
  assert.equal(stats.deployment.promptTextRetained, false);
});

test("/api/stats exposes deployment posture with a cross-border flag", async () => {
  const dep = (await (await fetch(base + "/api/stats")).json()).deployment;
  assert.ok(["cloud", "self_hosted"].includes(dep.mode));
  assert.equal(typeof dep.crossBorder, "boolean");
  assert.equal(dep.crossBorder, String(dep.dataRegion).toUpperCase() !== String(dep.providerRegion).toUpperCase());
  // report carries the same block a risk officer can file
  const rep = await (await fetch(base + "/api/report?format=json")).json();
  assert.equal(rep.deployment.promptTextRetained, dep.promptTextRetained);
});

test("below MIN_CALIBRATION_N the API refuses to state a guarantee", async () => {
  store.clear(); verify.reset();
  verify.configure({ sampleRate: 1, minCalibrationN: 1000, mode: "conformal" });
  await post({ model: "auto", messages: [{ role: "user", content: "hi thanks a bunch" }] });
  await verify.whenIdle();
  const q = (await (await fetch(base + "/api/stats")).json()).quality;
  assert.equal(q.guaranteeReady, false, "no guarantee below MIN_CALIBRATION_N");
  assert.equal(q.calibration.ready, false);
  verify.reset();
});
