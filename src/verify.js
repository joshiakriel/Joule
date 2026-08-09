"use strict";
const config = require("./config");
const { compute } = require("./metrics");
const store = require("./store");
const signals = require("./signals");
const calibrate = require("./calibrate");
const conformal = require("./conformal");
const tenancy = require("./tenancy");

/**
 * Quality verification — Joule's differentiator, EVOLVED from a naive LLM judge to
 * a calibrated + conformal design.
 *
 *   routing signal (router margin, no extra call)
 *     → isotonic CALIBRATION (raw → P(acceptable))
 *       → CONFORMAL threshold (distribution-free bound on degradation ≤ alpha)
 *         → route small only when the calibrated score clears the threshold.
 *
 * The LLM judge is DEMOTED to a labeller: for a sampled fraction of small answers
 * it produces an acceptable/not label (panel + de-biased) that feeds the
 * calibration set. It NEVER gates live traffic. Everything runs OFF the serving
 * path (the response has already returned). Below MIN_CALIBRATION_N we refuse to
 * state a guarantee and fall back to the v1 classifier/safety behaviour.
 *
 * HONESTY: the conformal guarantee is MARGINAL (population-level), not per-query;
 * distribution shift can violate it — always report n and alpha. Verification
 * costs real tokens (tracked as overhead so NET savings stay honest).
 */

const estTokens = (text) => Math.max(1, Math.round((text || "").length / 4));
const clamp01 = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- runtime state — PER-TENANT (Phase 1.1). Each tenant has its own calibration
// (via calibrate.for), conformal threshold, ACI controller, rolling scores, safety mode
// and verification overhead — one tenant's quality signal never leaks into another's. ----
const DEFAULT_TENANT = config.auth.defaultTenantId;
let opts = { ...config.verify };               // config is global; STATE is per-tenant
let inFlight = 0;                              // global in-flight verification counter (idle waiters)
let idleWaiters = [];
let forcedScore = opts.forceScore;
let testDelayMs = 0;
let rng = Math.random;                          // injectable for tests (order randomisation)

function makeAci() { return conformal.createAci({ alpha: opts.targetRiskAlpha, gamma: opts.aciGamma, gammaDrift: opts.aciGammaDrift, window: opts.aciWindow }); }

const tstate = new Map();                       // tenantId -> verify state
function S(tenant) {
  const id = tenant || DEFAULT_TENANT;
  if (!tstate.has(id)) tstate.set(id, {
    scores: [], verifiedCount: 0, sampledCount: 0, lowAgreementCount: 0, safety: false,
    overhead: { tokens: 0, costUsd: 0, energyWh: 0, carbonG: 0 },
    conf: { threshold: 1.01, coverage: null, riskBound: null, n: 0, alpha: opts.targetRiskAlpha, ready: false },
    aci: opts.conformalMode === "adaptive" ? makeAci() : null,
    liveRaw: []
  });
  return tstate.get(id);
}
const cal = (tenant) => calibrate.for(tenant || DEFAULT_TENANT);

function reset() {
  opts = { ...config.verify };
  tstate.clear();
  forcedScore = opts.forceScore; testDelayMs = 0; rng = Math.random;
  calibrate.reset();
}
function configure(partial) {
  const prevMode = opts.conformalMode;
  opts = { ...opts, ...partial };
  // switching mode rebuilds each tenant's controller so static never reads a stale ACI window
  if (opts.conformalMode !== prevMode) tstate.clear();
}
function setForcedScore(x) { forcedScore = x; }
function setTestDelay(ms) { testDelayMs = ms; }
function setRng(fn) { rng = fn || Math.random; }

const judgeModelList = () => (opts.judgeModels && opts.judgeModels.length ? opts.judgeModels : [config.modelLarge]);
const rollingScore = (tenant) => { const s = S(tenant).scores; return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null; };
const safetyMode = (tenant) => S(tenant).safety;
const inFlightCount = () => inFlight;
function whenIdle() { return inFlight === 0 ? Promise.resolve() : new Promise((r) => idleWaiters.push(r)); }
function settleIdle() { if (inFlight === 0) idleWaiters.splice(0).forEach((r) => r()); }

// ---- init: load calibration + migrate existing judge scores (per tenant) ----
function init(dir) {
  calibrate.setDir(dir);
  calibrate.load();
  migrateFromStore(store.all());
  for (const tid of store.tenants()) recomputeConformal(tid);
}

// Existing logged judge scores are readable — seed each tenant's calibration set from
// its own records (raw from stored routing signal, else a confidence proxy).
function migrateFromStore(records) {
  let seeded = 0;
  const touched = new Set();
  for (const r of records || []) {
    if (!r.verification) continue;
    const raw = (r.routing && Number.isFinite(r.routing.raw)) ? r.routing.raw : (Number.isFinite(r.confidence) ? r.confidence / 100 : null);
    if (raw == null) continue;
    const label = (r.verification.checksPassed && r.verification.judgeScore >= opts.judgeAcceptThreshold) ? 1 : 0;
    cal(r.tenant).add(raw, label); touched.add(r.tenant || DEFAULT_TENANT); seeded++;
  }
  for (const tid of touched) cal(tid).fit();
  if (seeded) calibrate.persist();
  return seeded;
}

function recomputeConformal(tenant) { S(tenant).conf = conformal.compute(cal(tenant).calibrationPoints(), opts.targetRiskAlpha); }

// Fold one verified outcome into the tenant's threshold. Adaptive nudges alpha_t online;
// static re-solves the full-set CRC bound.
function applyVerifiedSample(raw, label, tenant) {
  const st = S(tenant);
  if (opts.conformalMode === "adaptive") {
    if (!st.aci) st.aci = makeAci();
    const p = cal(tenant).predict(raw);
    st.aci.update({ p, label: label ? 1 : 0, drift: driftStatus(tenant).drift });
    const s = st.aci.state();
    st.conf = { threshold: s.threshold, coverage: s.rollingCoverage, riskBound: null, n: cal(tenant).size(), alpha: opts.targetRiskAlpha, ready: cal(tenant).ready(opts.minCalibrationN) && s.threshold <= 1, aci: s };
  } else {
    recomputeConformal(tenant);
  }
}

// ---- rolling judge score + v1 safety-mode transitions (per tenant) ----
function pushScore(score, tenant) {
  const st = S(tenant);
  st.scores.push(score);
  while (st.scores.length > opts.rollingWindow) st.scores.shift();
  st.verifiedCount++;
  const r = rollingScore(tenant);
  if (r == null || st.scores.length < opts.minSamples) return;
  if (!st.safety && r < opts.qualityThreshold) {
    st.safety = true;
    console.log(`[verify] SAFETY MODE ON (tenant ${tenant || DEFAULT_TENANT}) — rolling quality ${r.toFixed(3)} < ${opts.qualityThreshold}; biasing to large.`);
  } else if (st.safety && r >= opts.qualityThreshold) {
    st.safety = false;
    console.log(`[verify] safety mode OFF (tenant ${tenant || DEFAULT_TENANT}) — rolling quality ${r.toFixed(3)} recovered.`);
  }
}

// ---- drift: compare a tenant's live routing-signal mean to its calibration distribution ----
function trackLive(tenant, raw) { const lr = S(tenant).liveRaw; lr.push(raw); while (lr.length > 200) lr.shift(); }
function driftStatus(tenant) {
  const cs = cal(tenant).rawStats();
  const lr = S(tenant).liveRaw;
  const n = lr.length;
  if (n < opts.driftMinN || cs.n < opts.minCalibrationN || cs.std <= 1e-9) {
    return { status: n < opts.driftMinN ? "warming-up" : "ok", drift: false, liveMean: n ? lr.reduce((a, b) => a + b, 0) / n : null, calMean: cs.mean, liveN: n };
  }
  const liveMean = lr.reduce((a, b) => a + b, 0) / n;
  const z = Math.abs(liveMean - cs.mean) / cs.std;
  const drift = z > opts.driftK;
  return { status: drift ? "drift" : "ok", drift, z, liveMean, calMean: cs.mean, liveN: n };
}

// ---- routing gate: called for every small-CLASSIFIED request (tenant-scoped) ----
function gate(decision, floor, tenant) {
  const st = S(tenant);
  const raw = signals.routingSignal(decision);
  trackLive(tenant, raw);
  const calReady = cal(tenant).ready(opts.minCalibrationN);
  const p = calReady ? cal(tenant).predict(raw) : null;
  const drift = driftStatus(tenant).drift;
  let routeSmall, reason, guaranteed = false;

  if (drift) { routeSmall = false; reason = "drift-escalate"; }
  else if (Number.isFinite(floor)) { routeSmall = p != null && p >= floor; reason = routeSmall ? "floor-pass" : "floor-escalate"; }
  else if (opts.mode === "conformal" && calReady && st.conf.ready) { routeSmall = p >= st.conf.threshold; reason = routeSmall ? "conformal-pass" : "conformal-escalate"; guaranteed = true; }
  else if (st.safety) { routeSmall = false; reason = "safety-escalate"; }
  else { routeSmall = true; reason = calReady ? "insufficient-conformal-fallback" : "insufficient-data-fallback"; }

  return { raw, calibratedP: p, threshold: st.conf.threshold, ready: calReady && st.conf.ready, guaranteed, drift, routeSmall, reason };
}

// ---- deterministic checks (guardrails; part of the label) ----
function hardChecks(ctx) { return signals.responseSignals(ctx); }

// ---- judge (labeller only) — de-biased: order randomised, reference included, panel ----
function dryJudge(model, seed) {
  let h = 0; const s = model + "|" + seed; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 0.82 + (h % 14) / 100; // 0.82..0.95, varies per model+prompt so a panel has spread
}
async function judgeUpstream(model, userText, first, second, whichIsCandidate, apiKey) {
  const res = await fetch(config.upstreamBaseUrl + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + (apiKey || config.upstreamApiKey) },
    body: JSON.stringify({
      model, temperature: 0, response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `You are a strict evaluator. Two answers (A and B) respond to the prompt; a REFERENCE full-marks answer is given. Score how acceptable answer ${whichIsCandidate} is vs the reference on correctness/completeness. Reply STRICT JSON: {"score": <0..1>, "reason": "<short>"}.` },
        { role: "user", content: `PROMPT:\n${userText}\n\nANSWER A:\n${first}\n\nANSWER B:\n${second}` }
      ]
    }),
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) throw new Error("judge upstream " + res.status);
  const data = await res.json();
  const raw = data.choices && data.choices[0] && data.choices[0].message ? (data.choices[0].message.content || "") : "";
  let score = 0.5; try { const o = JSON.parse(raw); if (Number.isFinite(o.score)) score = clamp01(o.score); } catch { /* fallback */ }
  return { score, usage: data.usage || null };
}

// Panel of judges with order randomisation + agreement. Returns a label decision.
async function judgePanel(userText, answer, referenceAnswer, apiKey) {
  const models = judgeModelList();
  const offline = config.dryRun || forcedScore != null;
  const judges = [];
  let usageTokens = 0;
  for (const model of models) {
    const candidateFirst = rng() < 0.5;                 // de-bias: randomise presentation order
    const order = candidateFirst ? "candidate-first" : "reference-first";
    let score, usage = null;
    if (offline) {
      score = forcedScore != null ? clamp01(forcedScore) : dryJudge(model, userText);
      usage = { prompt_tokens: estTokens(userText + answer + referenceAnswer), completion_tokens: 24 };
    } else {
      const first = candidateFirst ? answer : referenceAnswer;
      const second = candidateFirst ? referenceAnswer : answer;
      const which = candidateFirst ? "A" : "B";
      const r = await judgeUpstream(model, userText, first, second, which, apiKey);
      score = r.score; usage = r.usage || { prompt_tokens: estTokens(userText + answer + referenceAnswer), completion_tokens: 24 };
    }
    usageTokens += (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
    judges.push({ model, score, order, accept: score >= opts.judgeAcceptThreshold });
  }
  // pairwise agreement on the accept/not decision
  let agree = 1;
  if (judges.length > 1) {
    let pairs = 0, agrees = 0;
    for (let i = 0; i < judges.length; i++) for (let j = i + 1; j < judges.length; j++) { pairs++; if (judges[i].accept === judges[j].accept) agrees++; }
    agree = pairs ? agrees / pairs : 1;
  }
  const meanScore = judges.reduce((s, j) => s + j.score, 0) / judges.length;
  return { judges, agreement: agree, meanScore, lowConfidence: agree < opts.judgeAgreementThreshold, usageTokens };
}

// ---- the verification itself (background) ----
async function runVerification(ctx) {
  const { rec, userText, answer, body, completion } = ctx;
  const tenant = rec.tenant || DEFAULT_TENANT;
  const st = S(tenant);
  const referenceModel = config.modelLarge;
  const gPerKwh = rec.grid.gPerKwh;
  if (testDelayMs) await sleep(testDelayMs);

  // verification bills to the SAME tenant whose request is being verified — their own
  // provider key, never another tenant's (falls back to the global env key in dev).
  const providerKey = tenancy.getUpstreamKey(tenant) || config.upstreamApiKey;

  // reference (full-marks) answer + token usage
  let referenceAnswer, refUsage;
  if (config.dryRun || forcedScore != null) {
    referenceAnswer = `【reference from ${referenceModel}】 ${(answer || "").slice(0, 200)}`;
    refUsage = { prompt_tokens: estTokens(userText), completion_tokens: estTokens(referenceAnswer) };
  } else {
    const res = await fetch(config.upstreamBaseUrl + "/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + providerKey },
      body: JSON.stringify({ model: referenceModel, messages: [{ role: "user", content: userText }] }), signal: AbortSignal.timeout(120000)
    });
    if (!res.ok) throw new Error("reference upstream " + res.status);
    const data = await res.json();
    referenceAnswer = data.choices && data.choices[0] && data.choices[0].message ? (data.choices[0].message.content || "") : "";
    refUsage = data.usage || { prompt_tokens: estTokens(userText), completion_tokens: estTokens(referenceAnswer) };
  }

  const checks = hardChecks({ completion, answer, body });
  const panel = await judgePanel(userText, answer, referenceAnswer, providerKey);
  // Label = hard checks pass AND the panel accepts. Low-agreement samples are
  // low-confidence: kept for the rolling score, EXCLUDED from calibration.
  const acceptable = checks.hardPass && panel.meanScore >= opts.judgeAcceptThreshold ? 1 : 0;
  const qualityScore = checks.hardPass ? clamp01(panel.meanScore) : Math.min(clamp01(panel.meanScore), 0.5);

  // meter verification overhead (reference + judge panel, large tier)
  const judgeTokensPerCall = Math.round(panel.usageTokens);
  const refM = compute({ model: referenceModel, tier: "large", promptTokens: refUsage.prompt_tokens, completionTokens: refUsage.completion_tokens, gPerKwh, cached: false });
  const judgeM = compute({ model: referenceModel, tier: "large", promptTokens: judgeTokensPerCall, completionTokens: 0, gPerKwh, cached: false });
  const verifyCost = {
    tokens: refUsage.prompt_tokens + refUsage.completion_tokens + judgeTokensPerCall,
    costUsd: refM.actual.costUsd + judgeM.actual.costUsd,
    energyWh: refM.actual.energyWh + judgeM.actual.energyWh,
    carbonG: refM.actual.carbonG + judgeM.actual.carbonG
  };
  st.overhead.tokens += verifyCost.tokens; st.overhead.costUsd += verifyCost.costUsd;
  st.overhead.energyWh += verifyCost.energyWh; st.overhead.carbonG += verifyCost.carbonG;

  store.addVerification(rec.id, {
    qualityScore, judgeScore: clamp01(panel.meanScore), judgeReason: `panel(${panel.judges.length}) agreement ${(panel.agreement * 100).toFixed(0)}%${panel.lowConfidence ? " — low-confidence" : ""}`,
    checksPassed: checks.hardPass, checks: checks.checks, acceptable: Boolean(acceptable), lowConfidence: panel.lowConfidence,
    agreement: panel.agreement, judges: panel.judges.map((j) => ({ model: j.model, score: j.score })),
    referenceModel, verifiedAt: new Date().toISOString(), verifyCost
  });

  pushScore(qualityScore, tenant);
  if (panel.lowConfidence) { st.lowAgreementCount++; }
  else {
    // feed the tenant's CALIBRATION set with (routing raw signal → acceptable label)
    const raw = (rec.routing && Number.isFinite(rec.routing.raw)) ? rec.routing.raw : signals.routingSignal({ score: 0 });
    cal(tenant).add(raw, acceptable);
    cal(tenant).fit();               // cheap for MVP-scale sets; refit-every still persists periodically
    applyVerifiedSample(raw, acceptable, tenant); // adaptive (online) or static conformal update
  }
}

// Sample this request and verify in the BACKGROUND. Never blocks the response.
function maybeVerify(ctx) {
  const rec = ctx && ctx.rec;
  if (!opts.enabled || !rec || rec.tier !== "small" || rec.mode === "cache" || rec.mode === "semantic_cache") return;
  const sample = opts.sampleRate >= 1 || rng() < opts.sampleRate;
  if (!sample) return;
  S(rec.tenant).sampledCount++; inFlight++;
  Promise.resolve().then(() => runVerification(ctx))
    .catch((err) => console.error("[verify] verification error:", err.message))
    .finally(() => { inFlight--; settleIdle(); });
}

function qualityStats(tenant) {
  const st = S(tenant);
  const conf = st.conf;
  const c = cal(tenant);
  const calN = c.size();
  const useAci = opts.conformalMode === "adaptive" && st.aci;
  const drift = driftStatus(tenant);
  const guaranteeReady = opts.mode === "conformal" && c.ready(opts.minCalibrationN) && conf.ready && !drift.drift;
  return {
    enabled: opts.enabled, mode: opts.mode, sampleRate: opts.sampleRate, threshold: opts.qualityThreshold,
    rollingScore: rollingScore(tenant), sampleCount: st.scores.length, verifiedCount: st.verifiedCount, sampledCount: st.sampledCount, lowAgreementCount: st.lowAgreementCount,
    safetyMode: st.safety, referenceModel: config.modelLarge, judgeModels: judgeModelList(), overhead: { ...st.overhead },
    calibration: { n: calN, ready: c.ready(opts.minCalibrationN), minN: opts.minCalibrationN, ece: c.ece() },
    conformal: {
      alpha: conf.alpha, threshold: conf.threshold, coverage: conf.coverage, riskBound: conf.riskBound, n: conf.n, ready: conf.ready,
      conformalMode: opts.conformalMode,
      workingAlpha: useAci ? st.aci.state().alphaT : conf.alpha,
      rollingCoverage: useAci ? st.aci.state().rollingCoverage : conf.coverage,
      targetCoverage: 1 - conf.alpha,
      adaptationRate: useAci ? (drift.drift ? opts.aciGammaDrift : opts.aciGamma) : null,
      driftBoosted: Boolean(useAci && drift.drift)
    },
    drift,
    guaranteeReady
  };
}

// Backward-compat wrapper used by the older escalation tests/paths.
function shouldEscalate(floor, tenant) {
  const r = rollingScore(tenant);
  if (Number.isFinite(floor) && (r == null || r < floor)) return true;
  if (S(tenant).safety) return rng() >= opts.probeRate;
  return false;
}

module.exports = {
  init, migrateFromStore, recomputeConformal,
  maybeVerify, gate, shouldEscalate, safetyMode, rollingScore, driftStatus, qualityStats,
  whenIdle, inFlightCount,
  // test/demo hooks
  reset, configure, setForcedScore, setTestDelay, setRng, pushScore, _judgePanel: judgePanel
};
