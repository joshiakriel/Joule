"use strict";
// Offline verification tests. DRY_RUN so the reference/judge run without network.
process.env.DRY_RUN = "true";
delete process.env.UPSTREAM_API_KEY;

const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("../src/store");
const verify = require("../src/verify");
const calibrate = require("../src/calibrate");

let tmpDir;

function smallRec(over = {}) {
  return store.add({
    ts: new Date().toISOString(), mode: "dry_run", cached: false, model: "small-x", tier: "small",
    signals: ["x"], confidence: 80, promptTokens: 5, completionTokens: 20, totalTokens: 25,
    actual: { costUsd: 0.0001, energyWh: 0.1, carbonG: 0.05 },
    baseline: { costUsd: 0.001, energyWh: 1.7, carbonG: 0.8 },
    saved: { costUsd: 0.0009, energyWh: 1.6, carbonG: 0.75 },
    grid: { zone: "AE", gPerKwh: 450, source: "test" }, session: null, ...over
  });
}

before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "joule-verify-")); store.init(tmpDir); calibrate.setDir(tmpDir); });
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });
beforeEach(() => { fs.rmSync(path.join(tmpDir, "log.jsonl"), { force: true }); store.init(tmpDir); verify.reset(); });

test("maybeVerify samples a small answer and scores it offline (no network)", async () => {
  verify.configure({ sampleRate: 1 });
  const rec = smallRec();
  verify.maybeVerify({ rec, userText: "hi there", answer: "hello, you're welcome!", body: {} });
  await verify.whenIdle();
  assert.ok(rec.verification, "verification attached");
  const v = rec.verification;
  assert.ok(v.qualityScore >= 0 && v.qualityScore <= 1);
  assert.equal(typeof v.judgeReason, "string");
  assert.equal(v.checksPassed, true);
  assert.equal(v.referenceModel, require("../src/config").modelLarge);
  assert.ok(v.verifyCost.tokens > 0 && v.verifyCost.costUsd > 0, "verification overhead metered");
});

test("only small, non-cache requests are sampled", async () => {
  verify.configure({ sampleRate: 1 });
  const large = smallRec({ tier: "large" });
  const cached = smallRec({ mode: "cache", cached: true });
  verify.maybeVerify({ rec: large, userText: "x", answer: "y", body: {} });
  verify.maybeVerify({ rec: cached, userText: "x", answer: "y", body: {} });
  await verify.whenIdle();
  assert.equal(large.verification, undefined);
  assert.equal(cached.verification, undefined);
});

test("a failed deterministic check caps the quality score", async () => {
  verify.configure({ sampleRate: 1 });
  verify.setForcedScore(0.95); // judge would say great...
  const rec = smallRec();
  // ...but JSON was requested and the answer is not valid JSON -> capped <= 0.5
  verify.maybeVerify({ rec, userText: "give me json", answer: "not json at all", body: { response_format: { type: "json_object" } } });
  await verify.whenIdle();
  assert.equal(rec.verification.checksPassed, false);
  assert.ok(rec.verification.qualityScore <= 0.5, "capped when a hard check fails");
});

test("rolling low scores engage safety mode; recovery disengages it", () => {
  verify.configure({ minSamples: 3, rollingWindow: 5, qualityThreshold: 0.8, probeRate: 0 });
  assert.equal(verify.safetyMode(), false);
  for (let i = 0; i < 4; i++) verify.pushScore(0.3); // below threshold
  assert.equal(verify.safetyMode(), true, "engages after enough low samples");
  // in safety mode with probeRate 0, small requests escalate to large
  assert.equal(verify.shouldEscalate(NaN), true);
  for (let i = 0; i < 6; i++) verify.pushScore(0.95); // window fills with highs
  assert.equal(verify.safetyMode(), false, "disengages once rolling recovers");
});

test("shouldEscalate honours a caller-supplied quality floor", () => {
  verify.configure({ probeRate: 0 });
  assert.equal(verify.shouldEscalate(0.9), true, "no samples yet -> can't defend floor -> escalate");
  for (let i = 0; i < 5; i++) verify.pushScore(0.95);
  assert.equal(verify.shouldEscalate(0.9), false, "rolling 0.95 meets a 0.9 floor");
  assert.equal(verify.shouldEscalate(0.99), true, "rolling 0.95 fails a 0.99 floor");
});

test("qualityStats reports null rolling score before any samples (no fake 100%)", () => {
  const q = verify.qualityStats();
  assert.equal(q.rollingScore, null);
  assert.equal(q.sampleCount, 0);
  assert.equal(q.safetyMode, false);
  assert.equal(q.guaranteeReady, false, "no guarantee with zero calibration");
  assert.equal(q.calibration.n, 0);
});

test("judge panel: randomises answer order and reports multi-judge agreement", async () => {
  verify.configure({ judgeModels: ["judge-a", "judge-b"] });
  verify.setRng(() => 0.1); // candidate-first
  const p1 = await verify._judgePanel("prompt", "small answer", "reference answer");
  assert.equal(p1.judges.length, 2, "panel runs both judges");
  assert.equal(p1.judges[0].order, "candidate-first");
  assert.ok(p1.agreement >= 0 && p1.agreement <= 1, "agreement is a fraction");
  verify.setRng(() => 0.9); // reference-first
  const p2 = await verify._judgePanel("prompt", "small answer", "reference answer");
  assert.equal(p2.judges[0].order, "reference-first", "order flips with rng");
});

test("gate(): below MIN_CALIBRATION_N it refuses a guarantee and falls back to small", () => {
  verify.configure({ mode: "conformal", minCalibrationN: 50 });
  const g = verify.gate({ score: -3, words: 2 }); // clearly-small prompt, no floor
  assert.equal(g.routeSmall, true, "falls back to routing small");
  assert.equal(g.guaranteed, false, "does not claim a guarantee");
  assert.match(g.reason, /insufficient/);
});

test("gate(): drift biases routing to large", () => {
  verify.configure({ minCalibrationN: 5, driftMinN: 5, driftK: 2 });
  // seed a calibration distribution centred on high routing signals
  for (let i = 0; i < 20; i++) calibrate.add(0.9 + (i % 3) * 0.01, 1);
  calibrate.fit(); verify.recomputeConformal();
  // now feed live traffic with very different (low) routing signals -> drift
  let g;
  for (let i = 0; i < 10; i++) g = verify.gate({ score: 5, words: 40 }); // low routing signal
  assert.equal(verify.driftStatus().drift, true, "drift detected");
  assert.equal(g.routeSmall, false, "escalates to large under drift");
  assert.match(g.reason, /drift/);
});
