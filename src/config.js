"use strict";
require("dotenv").config();

/**
 * All tunables live here. Everything is overridable via environment variables
 * so the same code runs against OpenAI, OpenRouter, Together, Groq, a local
 * Ollama, etc. — anything that speaks the OpenAI /chat/completions format.
 *
 * A thin RUNTIME-OVERRIDE layer sits on top: settings can be changed at runtime
 * (via POST /api/config, surfaced in the dashboard) without losing the env-based
 * defaults. Every read resolves to  override ?? env ?? hardcoded-default, so
 * secrets provided by the host (e.g. Render env vars) keep working as the
 * fallback. Overrides live IN MEMORY ONLY — never written to disk, never logged.
 */

const bool = (v, d) => (v === undefined ? d : String(v).toLowerCase() === "true" || v === "1");
const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
const coerceBool = (v) => (typeof v === "boolean" ? v : bool(v, false));

// Fields that may be overridden at runtime. Each knows its env var, hardcoded
// default, and how to coerce an incoming value into its stored form.
const overridable = {
  upstreamBaseUrl: { env: "UPSTREAM_BASE_URL", def: "https://api.openai.com/v1", coerce: (v) => String(v).replace(/\/$/, ""), secret: false },
  upstreamApiKey: { env: "UPSTREAM_API_KEY", def: "", coerce: (v) => String(v), secret: true },
  modelSmall: { env: "MODEL_SMALL", def: "gpt-4o-mini", coerce: (v) => String(v), secret: false },
  modelLarge: { env: "MODEL_LARGE", def: "gpt-4o", coerce: (v) => String(v), secret: false },
  routingEnabled: { env: "ROUTING_ENABLED", def: true, coerce: coerceBool, secret: false },
  emToken: { env: "ELECTRICITYMAPS_TOKEN", def: "", coerce: (v) => String(v), secret: true },
  gridZone: { env: "GRID_ZONE", def: "AE", coerce: (v) => String(v), secret: false },
  dryRun: { env: "DRY_RUN", def: false, coerce: coerceBool, secret: false }
};

const overrides = {}; // runtime, in-memory only — never persisted

const hasEnv = (key) => process.env[key] !== undefined && process.env[key] !== "";

function effective(name) {
  const spec = overridable[name];
  if (Object.prototype.hasOwnProperty.call(overrides, name)) return overrides[name];
  if (hasEnv(spec.env)) return spec.coerce(process.env[spec.env]);
  return spec.def;
}

function sourceOf(name) {
  if (Object.prototype.hasOwnProperty.call(overrides, name)) return "runtime";
  if (hasEnv(overridable[name].env)) return "env";
  return "default";
}

const config = {
  port: num(process.env.PORT, 3000),

  // ---- deployment mode & data residency (regional/compliance posture) ----
  // We DESCRIBE residency; we do NOT certify legal compliance.
  deploymentMode: (["cloud", "self_hosted"].includes(process.env.DEPLOYMENT_MODE) ? process.env.DEPLOYMENT_MODE : "cloud"),
  dataRegion: process.env.DATA_REGION || "AE",       // where Joule runs / data is handled
  providerRegion: process.env.PROVIDER_REGION || "US", // where the upstream model endpoint lives

  // ---- privacy by configuration (safe-by-default retention) ----
  logPrompts: bool(process.env.LOG_PROMPTS, false),  // default OFF: never persist prompt/response text
  piiRedact: bool(process.env.PII_REDACT, false),    // redact emails/phones/long digit runs before logging

  // ROI view — monthly subscription used for net-of-fees + payback (0 => not shown)
  subscriptionCostMonthly: num(process.env.SUBSCRIPTION_COST_MONTHLY, 0),

  // Routing tunables (not runtime-configurable via the UI)
  complexityThreshold: num(process.env.COMPLEXITY_THRESHOLD, 1), // score > threshold => large tier
  cacheTtlMs: num(process.env.CACHE_TTL_MS, 1000 * 60 * 30),

  // Carbon fallback (used when no EM token / API unreachable)
  fallbackIntensity: num(process.env.FALLBACK_INTENSITY, 450), // gCO2/kWh

  /**
   * Pricing — USD per 1,000,000 tokens. Set these to YOUR provider's real prices.
   * Cost is computed from the provider's actual returned token usage, so it is
   * exact given correct prices here.
   */
  pricing: {
    "gpt-4o-mini": { in: 0.15, out: 0.60 },
    "gpt-4o": { in: 2.50, out: 10.00 },
    _small: { in: 0.15, out: 0.60 },
    _large: { in: 2.50, out: 10.00 }
  },

  /**
   * Energy model — DECODE-WEIGHTED (measurement literature):
   *   Wh = base[tier] + perKTokOut[tier]*(completion_tokens/1000)
   *                   + perKTokIn[tier]*(prompt_tokens/1000)
   * Inference energy is dominated by the DECODE phase; it barely correlates with
   * prompt length and scales with tokens GENERATED — so `perKTokIn` is set an order
   * of magnitude below `perKTokOut`. Still an ESTIMATE (no provider exposes measured
   * Wh). Anchored to GPU characterisation studies (ML.ENERGY / Zeus / TokenPowerBench)
   * with IEA "Energy & AI" for order-of-magnitude sanity. All three are configurable.
   */
  energy: {
    small: { baseWh: 0.05, perKTokOutWh: 0.03, perKTokInWh: 0.003 },
    large: { baseWh: 0.90, perKTokOutWh: 0.42, perKTokInWh: 0.042 }
  },

  /**
   * Quality verification — the differentiator. A SAMPLE of small-tier answers is
   * re-checked against the large model (off the serving path) and scored, so we
   * can prove the cheap answer held quality — and only bill on savings we can
   * defend. Verification is STATISTICAL SAMPLING, not exhaustive, and the judge
   * is itself a fallible model. All knobs are env-configurable.
   */
  verify: {
    enabled: bool(process.env.VERIFY_ENABLED, true),
    sampleRate: num(process.env.VERIFY_SAMPLE_RATE, 0.1),       // fraction of small-tier requests sampled to LABEL
    qualityThreshold: num(process.env.QUALITY_THRESHOLD, 0.8),  // rolling judge score below this => v1 safety mode
    rollingWindow: num(process.env.VERIFY_ROLLING_WINDOW, 20),  // N most-recent verified samples
    minSamples: num(process.env.VERIFY_MIN_SAMPLES, 3),         // don't engage safety on too-few samples
    probeRate: num(process.env.VERIFY_PROBE_RATE, 0.2),         // in safety mode, still send this fraction small to allow recovery

    // ---- calibrated + conformal gating (evolution of the naive judge) ----
    // The judge is DEMOTED to a labeller; live routing is gated by a calibrated
    // probability + a distribution-free (marginal, NOT per-query) risk bound.
    mode: (["judge", "conformal"].includes(process.env.VERIFICATION_MODE) ? process.env.VERIFICATION_MODE : "conformal"),
    targetRiskAlpha: num(process.env.TARGET_RISK_ALPHA, 0.05),        // bound on P(unacceptable | routed small)
    calibrationRefitEvery: num(process.env.CALIBRATION_REFIT_EVERY, 200), // refit isotonic every N new labels
    minCalibrationN: num(process.env.MIN_CALIBRATION_N, 50),          // below this: refuse to state a guarantee, fall back
    judgeModels: (process.env.JUDGE_MODELS ? String(process.env.JUDGE_MODELS).split(",").map((s) => s.trim()).filter(Boolean) : null), // null => [modelLarge]
    judgeAcceptThreshold: num(process.env.JUDGE_ACCEPT_THRESHOLD, 0.6), // judge score >= this (and hard checks pass) => acceptable
    judgeAgreementThreshold: num(process.env.JUDGE_AGREEMENT_THRESHOLD, 0.67), // panel agreement below this => low-confidence, excluded
    driftK: num(process.env.DRIFT_K, 3),                              // |live mean - cal mean| > K*calStd => drift
    driftMinN: num(process.env.DRIFT_MIN_N, 30),                      // min live samples before drift can trigger

    // Test/demo hook: force the judge score (0..1). Unset in production.
    forceScore: (process.env.VERIFY_FORCE_SCORE === undefined || process.env.VERIFY_FORCE_SCORE === "") ? null : num(process.env.VERIFY_FORCE_SCORE, null)
  }
};

// Expose each overridable field as a live getter → override ?? env ?? default.
// Secrets are non-enumerable so an accidental JSON.stringify(config) can't leak them.
for (const name of Object.keys(overridable)) {
  Object.defineProperty(config, name, {
    get: () => effective(name),
    enumerable: !overridable[name].secret,
    configurable: false
  });
}

// Helper: look up per-model pricing with graceful fallback by tier.
config.priceFor = (model, tier) => {
  return config.pricing[model] || config.pricing["_" + tier] || config.pricing._large;
};

// ---- runtime-override API (used by POST /api/config) ----
config.overridableKeys = Object.keys(overridable);
config.isSecret = (name) => Boolean(overridable[name] && overridable[name].secret);
config.sourceOf = sourceOf;
// Apply a partial of already-validated values; coerces to each field's stored form.
config.setOverrides = (partial) => {
  for (const [k, v] of Object.entries(partial || {})) {
    if (!overridable[k]) continue; // whitelist enforced by caller, belt-and-braces here
    overrides[k] = overridable[k].coerce(v);
  }
};
config.clearOverrides = () => { for (const k of Object.keys(overrides)) delete overrides[k]; };

module.exports = config;
