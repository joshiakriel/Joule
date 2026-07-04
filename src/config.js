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
   * Energy model — Wh per request = base[tier] + perKTok[tier] * (totalTokens / 1000).
   * NOTE: energy per inference is an ESTIMATE (no provider exposes measured Wh).
   * Anchored to public research (IEA "Energy & AI" 2025; Epoch AI).
   */
  energy: {
    small: { baseWh: 0.05, perKTokWh: 0.03 },
    large: { baseWh: 0.90, perKTokWh: 0.42 }
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
