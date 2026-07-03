"use strict";
require("dotenv").config();

/**
 * All tunables live here. Everything is overridable via environment variables
 * so the same code runs against OpenAI, OpenRouter, Together, Groq, a local
 * Ollama, etc. — anything that speaks the OpenAI /chat/completions format.
 */

const bool = (v, d) => (v === undefined ? d : String(v).toLowerCase() === "true" || v === "1");
const num = (v, d) => (v === undefined || v === "" ? d : Number(v));

const config = {
  port: num(process.env.PORT, 3000),

  // Upstream provider (OpenAI-compatible). Bring your own.
  upstreamBaseUrl: (process.env.UPSTREAM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
  upstreamApiKey: process.env.UPSTREAM_API_KEY || "",

  // The two tiers Joule routes between. Point these at any two models on your provider.
  modelSmall: process.env.MODEL_SMALL || "gpt-4o-mini",
  modelLarge: process.env.MODEL_LARGE || "gpt-4o",

  // Routing
  routingEnabled: bool(process.env.ROUTING_ENABLED, true),
  complexityThreshold: num(process.env.COMPLEXITY_THRESHOLD, 1), // score > threshold => large tier
  cacheTtlMs: num(process.env.CACHE_TTL_MS, 1000 * 60 * 30),

  // Carbon (Electricity Maps free API — https://www.electricitymaps.com/free-tier)
  emToken: process.env.ELECTRICITYMAPS_TOKEN || "",
  gridZone: process.env.GRID_ZONE || "AE", // e.g. AE (UAE), ZA (South Africa), DE, US-CAL-CISO
  fallbackIntensity: num(process.env.FALLBACK_INTENSITY, 450), // gCO2/kWh if the API is unset/unreachable

  // Run without spending money or hitting a provider. Exercises the FULL routing +
  // metering pipeline with a synthesized completion. Records are clearly badged "dry_run".
  dryRun: bool(process.env.DRY_RUN, false),

  /**
   * Pricing — USD per 1,000,000 tokens. Set these to YOUR provider's real prices.
   * Cost is computed from the provider's actual returned token usage, so it is
   * exact given correct prices here.
   */
  pricing: {
    // sensible defaults for the default model choices; override per-model as needed
    "gpt-4o-mini": { in: 0.15, out: 0.60 },
    "gpt-4o": { in: 2.50, out: 10.00 },
    // generic fallbacks used when a model name isn't in the table
    _small: { in: 0.15, out: 0.60 },
    _large: { in: 2.50, out: 10.00 }
  },

  /**
   * Energy model — Wh per request = base[tier] + perKTok[tier] * (totalTokens / 1000).
   * NOTE: energy per inference is an ESTIMATE (no provider exposes measured Wh).
   * Defaults are anchored to public research (IEA "Energy & AI" 2025; Epoch AI):
   * a small model ≈ 0.05 Wh/query, a frontier text query ≈ 2.9 Wh. These are
   * transparent and configurable — swap in measured values when you have them.
   */
  energy: {
    small: { baseWh: 0.05, perKTokWh: 0.03 },
    large: { baseWh: 0.90, perKTokWh: 0.42 }
  }
};

// Helper: look up per-model pricing with graceful fallback by tier.
config.priceFor = (model, tier) => {
  return config.pricing[model] || config.pricing["_" + tier] || config.pricing._large;
};

module.exports = config;
