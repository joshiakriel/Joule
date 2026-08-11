"use strict";
// Load local secrets/overrides first (.env.local, git-ignored), then .env. dotenv
// never overwrites an already-set var, so precedence is: real environment (Render,
// shell, or a test that sets process.env before require) > .env.local > .env.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env.local") });
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

  /**
   * Weekly value digest — keeps savings visible when nobody is on the dashboard.
   * Provider-agnostic HTTP JSON email (Resend by default; any compatible endpoint via
   * DIGEST_API_URL). With no DIGEST_API_KEY the digest still renders IN-APP at
   * /api/digest and sending simply no-ops — nothing on the serving path depends on it.
   */
  digest: {
    enabled: bool(process.env.DIGEST_ENABLED, true),
    apiUrl: process.env.DIGEST_API_URL || "https://api.resend.com/emails",
    apiKey: process.env.DIGEST_API_KEY || "",
    from: process.env.DIGEST_FROM || "Joule <digest@joule.local>"
  },

  /**
   * Multi-tenant auth (Phase 1.1). Two entry points:
   *   - /v1/*  (the OpenAI-compatible proxy): a customer's JOULE API KEY (Bearer jk_...)
   *     resolves to their tenant; that tenant's encrypted upstream key makes the real call.
   *   - /api/* (dashboard): a Supabase Auth JWT (HS256, verified locally against
   *     SUPABASE_JWT_SECRET — password/session logic stays managed by Supabase).
   * EVERY stored row, cache key, budget and metric query is scoped to the resolved tenant.
   * `required` defaults ON in production and OFF in DRY_RUN so offline tests run within the
   * default tenant; the isolation tests flip it on and mint per-tenant keys.
   */
  auth: {
    required: bool(process.env.AUTH_REQUIRED, !bool(process.env.DRY_RUN, false)),
    jwtSecret: process.env.SUPABASE_JWT_SECRET || "",     // Supabase project JWT secret (HS256)
    // AES-256-GCM key for encrypting per-tenant upstream keys at rest. In DRY_RUN a
    // deterministic dev key is derived so offline tests work; set a real 64-hex key in prod.
    encKey: process.env.JOULE_ENC_KEY || "",
    keyPrefix: process.env.JOULE_KEY_PREFIX || "jk_live_", // customer key prefix
    defaultTenantId: process.env.DEFAULT_TENANT_ID || "00000000-0000-0000-0000-000000000001",
    // PUBLIC (browser) Supabase values — served to the dashboard by GET /api/auth-config so
    // they come from env, not hardcoded HTML. The anon key is DESIGNED to be public (it grants
    // nothing without a valid session). The SERVICE-ROLE key must never appear client-side.
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
    /**
     * OPERATORS — the people who run this deployment. Only they may edit
     * deployment-wide settings (models, grid region, routing, dry-run) via /api/config.
     * Normal tenants get a READ-ONLY view of those and manage only their own
     * per-workspace provider connection. Comma-separated email allowlist; a `role:
     * "operator"` claim on the JWT also works. Empty list + auth off (dev/DRY_RUN)
     * means the single local user is treated as the operator.
     */
    operatorEmails: String(process.env.OPERATOR_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    // Temporary auth diagnostics. Logs the SHAPE of a rejected token (alg/kid/iss/aud/role,
    // lengths, and the precise failure reason) — never the token, signature or secret.
    debug: bool(process.env.DEBUG_AUTH, false)
  },

  /**
   * Persistence backend. The store keeps an in-memory record mirror either way;
   * this only chooses where records are DURABLY written so they survive a restart.
   *   - "memory"   : append-only JSONL on local disk (single node, ephemeral hosts).
   *   - "postgres" : durable Postgres (Supabase etc.) via DATABASE_URL, JSONL role dropped.
   * Default: postgres when DATABASE_URL is set, else memory — so DRY_RUN/offline
   * tests keep working with no database. SSL is required by Supabase.
   */
  store: {
    backend: (["memory", "postgres"].includes(process.env.STORE_BACKEND)
      ? process.env.STORE_BACKEND
      : (process.env.DATABASE_URL ? "postgres" : "memory")),
    databaseUrl: process.env.DATABASE_URL || "",
    // Supabase (and most managed PG) require SSL; certs are provider-managed.
    ssl: bool(process.env.DATABASE_SSL, true) ? { rejectUnauthorized: false } : false,
    poolMax: num(process.env.DATABASE_POOL_MAX, 5),
    // Resilience: bound how long we wait for a pooled connection / a single query so a
    // DB outage or pool exhaustion fails fast instead of hanging the (off-path) write.
    connectTimeoutMs: num(process.env.DATABASE_CONNECT_TIMEOUT_MS, 5000),
    statementTimeoutMs: num(process.env.DATABASE_STATEMENT_TIMEOUT_MS, 8000),
    // Failed metering writes buffer in memory and replay when the DB recovers, up to
    // this cap (then the oldest are dropped with a logged warning). The in-memory
    // record mirror is unaffected, so /api/stats stays correct throughout an outage.
    maxBufferedWrites: num(process.env.DATABASE_MAX_BUFFERED_WRITES, 10000)
  },

  /**
   * Upstream provider resilience (the primary path). Every live model call goes
   * through src/upstream.js: one attempt per try with a hard timeout, exponential
   * backoff retries on TRANSIENT failures only (429 / 5xx / network), an optional
   * fallback model, and finally a clean OpenAI-shaped error. Never retries other 4xx
   * (client errors) — they won't succeed on retry. All config-driven.
   */
  upstream: {
    timeoutMs: num(process.env.UPSTREAM_TIMEOUT_MS, 120000),   // per-attempt hard timeout
    maxRetries: num(process.env.UPSTREAM_MAX_RETRIES, 2),      // additional attempts after the first
    retryBaseMs: num(process.env.UPSTREAM_RETRY_BASE_MS, 250), // backoff = base * 2^attempt (+ jitter)
    retryJitter: bool(process.env.UPSTREAM_RETRY_JITTER, true),
    fallbackModel: process.env.FALLBACK_MODEL || ""            // tried once after the primary exhausts; "" => none
  },

  /**
   * Batch processing — savings-hierarchy #2. Latency-tolerant work submitted to
   * `/v1/batch` is processed asynchronously at the provider's batch discount
   * (OpenAI/Anthropic ~50% off). ZERO quality risk — same model, same output, just
   * async. The discount reflects provider batch-API pricing and is reported on its
   * own line; net cost paid = metered cost − batch discount.
   */
  batch: {
    discount: num(process.env.BATCH_DISCOUNT, 0.5), // fraction off vs the sync price
    maxSize: num(process.env.BATCH_MAX_SIZE, 1000)
  },

  /**
   * Reasoning-budget control (savings-hierarchy #3, the routing tier). Reasoning
   * models (o-series, R1, extended-thinking Claude, Gemini thinking) emit 5–50×
   * more tokens; accuracy has diminishing returns past a depth, so CAPPING the
   * thinking budget usually preserves quality while cutting cost. Downgrading a
   * reasoning model to a standard one for simple prompts is a QUALITY-RISK decision
   * and is verified through the same conformal path as tier routing.
   * Table-driven: each entry maps a model-name pattern to its thinking-budget param.
   */
  reasoning: {
    defaultEffort: (["low", "medium", "high"].includes(process.env.REASONING_DEFAULT_EFFORT) ? process.env.REASONING_DEFAULT_EFFORT : "medium"),
    maxThinkingTokens: num(process.env.REASONING_MAX_THINKING_TOKENS, 4000),
    downgradeEnabled: bool(process.env.REASONING_DOWNGRADE_ENABLED, false),
    standardModel: process.env.REASONING_STANDARD_MODEL || "gpt-4o-mini",
    effortTokens: { low: 1000, medium: 4000, high: 12000 }, // effort -> nominal thinking-token cap
    models: [
      { match: "^o[134]", family: "openai", param: "reasoning_effort" },      // o1/o3/o4
      { match: "gpt-5", family: "openai", param: "reasoning_effort" },
      { match: "deepseek-r", family: "open", param: "max_thinking_tokens" },   // R1
      { match: "qwq", family: "open", param: "max_thinking_tokens" },
      { match: "thinking|extended-thinking", family: "anthropic", param: "budget_tokens" },
      { match: "gemini.*thinking", family: "google", param: "thinking_budget" }
    ]
  },

  /**
   * OpenTelemetry GenAI interop. `/metrics` (Prometheus) is always available and
   * dependency-free. OTLP/HTTP JSON span export (GenAI semantic conventions) is
   * opt-in: set OTEL_EXPORTER_OTLP_ENDPOINT (+ OTEL_ENABLED) and each request emits
   * a span to your collector. No OTel SDK dependency — spans are hand-built JSON.
   */
  otel: {
    enabled: bool(process.env.OTEL_ENABLED, false),
    endpoint: (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "").replace(/\/$/, ""),
    serviceName: process.env.OTEL_SERVICE_NAME || "joule"
  },

  /**
   * Budget enforcement — metering REPORTS; enforcement PREVENTS. A request's cost
   * is estimated and RESERVED against hierarchical budgets BEFORE the model is
   * called; if a cap would be exceeded and enforcement is on, the request is
   * rejected (HTTP 402) and no model call is made. Default is metering-only
   * (enforce=false): caps that would be breached are flagged, not blocked. 0 = no cap.
   */
  budget: {
    enforce: bool(process.env.BUDGET_ENFORCE, false),
    globalUsd: num(process.env.BUDGET_GLOBAL_USD, 0),
    dailyUsd: num(process.env.BUDGET_DAILY_USD, 0),
    // per X-Joule-Session (agent-run) caps — cost and/or call count. Breaching a
    // block cap TERMINATES the session (further calls rejected).
    sessionUsd: num(process.env.BUDGET_SESSION_USD, num(process.env.MAX_COST_PER_SESSION, 0)),
    maxCallsPerSession: num(process.env.MAX_CALLS_PER_SESSION, 0),
    assumedCompletionTokens: num(process.env.BUDGET_ASSUMED_COMPLETION_TOKENS, 500),
    // fail-open (default): if the budget engine errors, ALLOW traffic and log loudly —
    // a store hiccup must not take down a customer's production. fail-closed rejects.
    failMode: (process.env.BUDGET_FAIL_MODE === "fail_closed" ? "fail_closed" : "fail_open"),
    // Optional named budgets: JSON array of {id,scope,key?,limitUsd,window,action}.
    defs: (() => { try { return process.env.BUDGET_DEFS ? JSON.parse(process.env.BUDGET_DEFS) : []; } catch { return []; } })()
  },

  // Routing tunables (not runtime-configurable via the UI)
  complexityThreshold: num(process.env.COMPLEXITY_THRESHOLD, 1), // score > threshold => large tier
  cacheTtlMs: num(process.env.CACHE_TTL_MS, 1000 * 60 * 30),

  /**
   * Caching economics — Layer 1: exact + provider-native PREFIX caching. Prefix/
   * exact caching is ZERO quality risk (the model recomputes nothing; output is
   * unchanged). Cached INPUT tokens cost `readMultiplier` of the input price; some
   * providers charge a `writeMultiplier` premium to populate the cache (Anthropic
   * ~1.25; OpenAI ~1.0). Savings are reported NET of that write premium.
   */
  cache: {
    readMultiplier: num(process.env.CACHE_READ_MULTIPLIER, 0.5),   // OpenAI 0.5; Anthropic ~0.1
    writeMultiplier: num(process.env.CACHE_WRITE_MULTIPLIER, 1.0),  // OpenAI 1.0; Anthropic ~1.25
    dryRunPrefixRate: num(process.env.CACHE_DRYRUN_PREFIX_RATE, 0.5), // synthetic cached-prefix fraction in DRY_RUN (demo only)
    maxEntries: num(process.env.CACHE_MAX_ENTRIES, 10000)          // bound the exact-cache Map (LRU eviction) so memory can't grow unbounded
  },

  /**
   * Layer 2 — SEMANTIC cache (OPT-IN, default OFF). Unlike prefix/exact caching it
   * can return a DIFFERENT question's answer, so it IS a genuine quality risk. We
   * bound it: per-entry learned similarity thresholds (vCache-style) targeting a
   * configurable error rate, the realised error rate tracked and reported, and
   * savings reported NET of embedding spend. Runs ONLY on a Layer-1 miss.
   */
  semanticCache: {
    enabled: bool(process.env.SEMANTIC_CACHE_ENABLED, false),
    baseThreshold: num(process.env.SEMANTIC_CACHE_BASE_THRESHOLD, 0.92), // conservative cosine start
    targetError: num(process.env.SEMANTIC_CACHE_TARGET_ERROR, 0.05),      // bound on served-answer error rate
    verifyRate: num(process.env.SEMANTIC_CACHE_VERIFY_RATE, 0.25),         // fraction of hits sampled to learn thresholds
    maxEntries: num(process.env.SEMANTIC_CACHE_MAX_ENTRIES, 500),
    embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
    embedPricePerM: num(process.env.EMBEDDING_PRICE_PER_M, 0.02),         // USD per 1M embedding tokens
    // ---- SAFETY (semantic cache fails SILENTLY; these make it fail loudly) ----
    minSimilarity: num(process.env.SEMANTIC_CACHE_MIN_SIMILARITY, 0.85),   // hard floor: never serve below this, whatever the target
    ttlSec: num(process.env.SEMANTIC_CACHE_TTL, 86400),                    // per-entry staleness cap (~24h); never serve past it
    version: process.env.SOURCE_VERSION || process.env.SEMANTIC_CACHE_VERSION || "1", // bump to invalidate all entries (version-tagged keys)
    maxInputChars: num(process.env.SEMANTIC_CACHE_MAX_INPUT_CHARS, 8000),  // adversarial guard: don't embed oversized/crafted input
    disableErrorRate: num(process.env.SEMANTIC_CACHE_DISABLE_ERROR_RATE, 0.15), // realised error above this (after minSamples) auto-DISABLES the layer + alerts
    disableMinSamples: num(process.env.SEMANTIC_CACHE_DISABLE_MIN_SAMPLES, 20),
    // sensitive-query bypass: these prompts skip the semantic layer entirely (prefix cache may still apply)
    bypassPatterns: (process.env.SEMANTIC_CACHE_BYPASS_PATTERNS
      ? String(process.env.SEMANTIC_CACHE_BYPASS_PATTERNS).split(",").map((s) => s.trim()).filter(Boolean)
      : ["\\b(diagnos|prescription|dosage|symptom)\\b", "\\b(invoice|balance|account number|wire transfer|iban)\\b", "\\b(lawsuit|contract clause|liability|legal advice)\\b", "\\b(password|api[_ -]?key|ssn|passport)\\b"])
  },

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
    // Adaptive Conformal Inference (Gibbs & Candès): update the threshold ONLINE so the
    // coverage guarantee holds THROUGH drift instead of going stale. "static" = the prior
    // full-set CRC refit (reversible / A/B-able); "adaptive" = online alpha_t + recent window.
    conformalMode: (["static", "adaptive"].includes(process.env.CONFORMAL_MODE) ? process.env.CONFORMAL_MODE : "adaptive"),
    aciGamma: num(process.env.ACI_GAMMA, 0.01),                       // learning rate
    aciGammaDrift: num(process.env.ACI_GAMMA_DRIFT, 0.05),            // boosted rate while drift is active
    aciWindow: num(process.env.ACI_WINDOW, 500),                     // recent-sample window
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
