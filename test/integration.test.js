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
  verify.reset(); // clean verification/calibration state for the early tests
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
