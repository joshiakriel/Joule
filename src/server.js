"use strict";
const path = require("path");
const express = require("express");
const config = require("./config");
const { classify, selectModel, tierForModel } = require("./router");
const { getIntensity, invalidate: invalidateIntensity } = require("./carbon");
const { compute, prefixCacheSavings } = require("./metrics");
const store = require("./store");
const verify = require("./verify");
const { redact } = require("./redact");
const containsPII = (text) => redact(text) !== text; // PII signal: never semantic-cache these
const cacheadvice = require("./cacheadvice");
const semcache = require("./semcache");
const budget = require("./budget");
const otel = require("./otel");
const batch = require("./batch");
const reasoning = require("./reasoning");
const upstream = require("./upstream");
const tenancy = require("./tenancy");
const digest = require("./digest");
const reportpdf = require("./reportpdf");

// Fill in reasoning-token counts + capping/downgrade savings (labelled estimates).
function finalizeReasoning(info, tier, usage) {
  if (!info) return null;
  const outPrice = config.priceFor(info.model, tier).out;
  let reasoningTokens, savedTokens;
  if (config.dryRun) {
    reasoningTokens = info.downgraded ? 0 : Math.round(info.capTokens * 0.6);
    savedTokens = info.downgraded ? Math.round(info.capTokens * 0.6) : Math.max(0, (info.uncappedTokens || 0) - info.capTokens);
  } else {
    reasoningTokens = info.downgraded ? 0 : reasoning.reasoningTokens(usage);
    savedTokens = info.downgraded ? info.capTokens : Math.max(0, (info.uncappedTokens || 0) - info.capTokens);
  }
  return { ...info, reasoningTokens, savedTokens, savedUsd: (savedTokens / 1e6) * outPrice };
}

// Estimate a request's cost BEFORE calling the model (prompt tokens + an assumed
// completion length at the routed tier's price) — used for budget reservation.
function estimateRequestCost(model, tier, userText) {
  const p = config.priceFor(model, tier);
  return (estTokens(userText) / 1e6) * p.in + (config.budget.assumedCompletionTokens / 1e6) * p.out;
}

// Live correctness probe for a served semantic hit: does a fresh answer to the NEW
// prompt agree with the cached answer? (sampled, off the serving path)
async function liveSemanticCorrect(userText, model, cachedAnswer) {
  try {
    const res = await fetch(config.upstreamBaseUrl + "/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + config.upstreamApiKey },
      body: JSON.stringify({ model, messages: [{ role: "user", content: userText }] }), signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) return true; // can't tell -> don't penalise
    const data = await res.json();
    const fresh = data.choices?.[0]?.message?.content || "";
    const [a, b] = await Promise.all([semcache.embed(cachedAnswer), semcache.embed(fresh)]);
    return semcache.cosine(a, b) >= 0.85;
  } catch { return true; }
}

// Provider PREFIX-cache usage — read the REAL cached vs cache-creation input tokens
// from the upstream usage object. Supports OpenAI (prompt_tokens_details.cached_tokens)
// and Anthropic-style (cache_read_input_tokens / cache_creation_input_tokens) shapes.
function extractCacheUsage(usage) {
  if (!usage) return { cachedInputTokens: 0, writeInputTokens: 0 };
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  return { cachedInputTokens: Number(cached) || 0, writeInputTokens: Number(write) || 0 };
}

// Replace any live secret value with *** before a string leaves the process
// (error messages, etc.). Secrets are never logged or returned by any endpoint.
function scrub(s) {
  let out = String(s == null ? "" : s);
  for (const secret of [config.upstreamApiKey, config.emToken]) {
    if (secret && secret.length >= 4) out = out.split(secret).join("***");
  }
  return out;
}

store.init();
// The Postgres backend loads the log asynchronously; seed budget only once it's in
// memory. Memory backend resolves immediately, so this is a no-op wait there.
const storeReady = store.ready().then(async () => {
  // identity (tenants, API keys, encrypted provider keys) is durable on the postgres
  // backend — load it back BEFORE accepting traffic so keys survive a restart/redeploy.
  tenancy.usePersistence(store.durable());
  try {
    const h = await tenancy.hydrate();
    if (h.keys || h.secrets) console.log(`  identity restored: ${h.tenants} tenant(s), ${h.keys} key(s), ${h.secrets} provider secret(s)`);
  } catch (e) { console.error("identity hydrate error:", e && e.message); }
  verify.init();            // load calibration + migrate existing judge scores
  budget.init(store.all()); // seed committed spend from the log
});

// Backstop: a stray background promise (a secondary task) must never crash the process.
// Log it loudly and keep serving — the user's request path is sacred.
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason && reason.message ? reason.message : reason));

// When the durable store is degraded, periodically try to reconnect + replay buffered
// writes so the DB reconciles with the in-memory mirror once it recovers. Timer is
// unref'd so it never keeps the process alive on its own.
if (require.main === module && store.backend() === "postgres") {
  const t = setInterval(() => { store.recover().catch(() => {}); }, 15000);
  if (t.unref) t.unref();
}
const app = express();
app.use(express.json({ limit: "2mb" }));
// Malformed / oversized / non-JSON bodies must never crash — return a clean, OpenAI-shaped
// error. body-parser throws a typed error (SyntaxError, or status 413 for entity.too.large)
// which lands here before any route runs.
app.use((err, _req, res, next) => {
  if (!err) return next();
  const tooLarge = err.type === "entity.too.large" || err.status === 413;
  const status = tooLarge ? 413 : 400;
  console.warn(`[input] rejected malformed request body: ${err.type || err.message}`);
  return res.status(status).json({ error: { message: tooLarge ? "request body too large" : "invalid JSON in request body", type: "invalid_request_error", code: null } });
});
app.use(express.static(path.join(__dirname, "..", "public")));

// ---- authentication + tenant resolution (Phase 1.1) ------------------------
// EVERY /v1 and /api request is scoped to a tenant. /v1 authenticates with a customer
// Joule API key; /api (dashboard) with a Supabase JWT. When auth is not required
// (DRY_RUN/dev), unauthenticated requests fall back to the default tenant so the
// single-tenant demo + offline tests keep working — still fully tenant-scoped.
function proxyAuth(req, res, next) {
  const t = tenancy.resolveFromApiKey(req.get("authorization"));
  if (t) { req.tenant = t; return next(); }
  if (!config.auth.required) { req.tenant = tenancy.defaultTenant(); return next(); }
  return res.status(401).json({ error: { message: "missing or invalid Joule API key", type: "invalid_request_error", code: "unauthenticated" } });
}
// Is this identity an OPERATOR of the deployment (may edit instance-wide settings)?
// Email allowlist or a role claim. With auth off (dev/DRY_RUN) the single local user is
// the operator, so the existing single-tenant workflow keeps working.
function isOperator(ident) {
  if (!config.auth.required) return true;
  if (!ident) return false;
  if (ident.role === "operator" || ident.role === "admin") return true;
  const email = String(ident.email || "").toLowerCase();
  return Boolean(email && config.auth.operatorEmails.includes(email));
}

function dashAuth(req, res, next) {
  // Public by design: liveness, and the browser bootstrap values the login screen needs
  // before anyone is signed in (Supabase URL + ANON key — never the service-role key).
  if (req.path === "/health" || req.path === "/auth-config") return next();
  const t = tenancy.resolveFromJwt(req.get("authorization"));
  if (t) { req.tenant = t; req.isOperator = isOperator(t); return next(); }
  if (!config.auth.required) { req.tenant = tenancy.defaultTenant(); req.isOperator = true; return next(); }
  if (config.auth.debug) console.warn("[auth] 401 on " + req.method + " /api" + req.path + " " + JSON.stringify(tenancy.diagnoseJwt(req.get("authorization"))));
  return res.status(401).json({ error: { message: "authentication required", type: "invalid_request_error", code: "unauthenticated" } });
}
app.use("/v1", proxyAuth);
app.use("/api", dashAuth);

// The provider key used for a tenant's real model calls: THEIR OWN encrypted key when
// they've onboarded one, else the global env key (single-tenant/dev path). Returned for
// immediate use as a bearer token — never logged, never returned over the API.
function providerKeyFor(tenantId) {
  return tenancy.getUpstreamKey(tenantId) || config.upstreamApiKey || "";
}

// ---- tiny normalized cache (exact-match after normalization) ----
const cache = new Map(); // key -> { completion, ts }
const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > config.cacheTtlMs) { cache.delete(key); return null; }
  // touch for LRU recency (Map preserves insertion order; re-insert moves to newest)
  cache.delete(key); cache.set(key, hit);
  return hit.completion;
}
function cacheSet(key, completion) {
  cache.delete(key); cache.set(key, { completion, ts: Date.now() }); // newest last
  // bound memory: evict the oldest entries once over the cap (LRU)
  while (cache.size > config.cache.maxEntries) cache.delete(cache.keys().next().value);
}

const lastUserText = (messages) => {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user") {
      const c = messages[i].content;
      return typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text || "").join(" ") : "";
    }
  }
  return "";
};

// estimate tokens when a provider doesn't return usage (~4 chars/token)
const estTokens = (text) => Math.max(1, Math.round((text || "").length / 4));

// build a full (non-stream) completion object — used to warm the cache from a
// streamed answer so later identical requests (stream or not) can hit the cache.
const buildCompletion = ({ id, created, model, content, promptTokens, completionTokens }) => ({
  id, object: "chat.completion", created, model,
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
});

// A client may tag a run of calls with an X-Joule-Session header so they group
// into one "session" in the dashboard. Sanitised so it's safe in CSV/JSON.
const sessionOf = (req) => {
  const raw = String(req.get("x-joule-session") || "").replace(/[",\r\n]/g, "").trim();
  return raw ? raw.slice(0, 64) : null;
};

// meter + log a request identically for streaming and non-streaming paths.
// Returns the compute result with the stored record attached as `.rec` (so the
// caller can hand it to the background verifier).
function meterAndLog({ started, tenant, mode, model, tier, decision, grid, promptTokens, completionTokens, session, qualityEscalated, routing, promptText, completionText, prefixCache, semantic, batch, reasoning }) {
  // A semantic hit serves a stored answer, so the model recompute is avoided (cache-like);
  // its embedding cost is tracked separately on the semantic savings line.
  const m = compute({ model, tier, promptTokens, completionTokens, gPerKwh: grid.gPerKwh, cached: mode === "cache" || mode === "semantic_cache" });
  const rec = {
    ts: new Date().toISOString(), tenant: tenant || tenancy.DEFAULT_TENANT_ID, mode, cached: mode === "cache",
    model, tier, signals: decision.signals, confidence: decision.confidence,
    promptTokens, completionTokens, totalTokens: m.totalTokens,
    actual: m.actual, baseline: m.baseline, saved: m.saved,
    grid, latencyMs: Date.now() - started, session: session || null,
    qualityEscalated: Boolean(qualityEscalated), routing: routing || null,
    // Layer-1 cache: provider prefix-cache savings (from real usage) + hostile-structure flag
    prefixCache: prefixCache || null,
    cacheHostile: cacheadvice.analyzePrompt(promptText || "").hostile,
    // Layer-2 semantic cache (quality risk — separate line)
    semantic: semantic || null,
    // Batch discount (zero quality risk — separate line)
    batch: batch ? { discount: batch.discount, savedUsd: m.actual.costUsd * batch.discount } : null,
    // Reasoning-budget control (thinking-token capping / downgrade — separate line)
    reasoning: reasoning || null
  };
  if (semantic) rec.semantic.netSavedUsd = m.saved.costUsd - (semantic.embedCostUsd || 0);
  // Retention is OFF by default: prompt/response TEXT is persisted only when
  // LOG_PROMPTS=true, and PII-redacted first when PII_REDACT=true.
  if (config.logPrompts) {
    rec.prompt = config.piiRedact ? redact(promptText || "") : (promptText || "");
    rec.completion = config.piiRedact ? redact(completionText || "") : (completionText || "");
  }
  m.rec = store.add(rec);
  otel.emit(m.rec); // OTLP GenAI span (off-path, no-op unless configured)
  return m;
}

// ---- SSE helpers (OpenAI chat.completion.chunk shape) ----
const sseSend = (res, obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");
const sseHeaders = (res) => {
  res.set({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  if (res.flushHeaders) res.flushHeaders();
};
// synthesize an SSE stream for a known answer (dry-run + cache-hit paths)
function streamText(res, { id, created, model, content }) {
  const base = { id, object: "chat.completion.chunk", created, model };
  sseSend(res, { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  const parts = String(content).match(/\S+\s*/g) || [String(content)]; // word-ish chunks
  for (const p of parts) sseSend(res, { ...base, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
  sseSend(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}

// ---------------------------------------------------------------------------
// Streaming path (body.stream === true). Emits an OpenAI-style SSE stream while
// still routing, metering and logging. NOTE: metrics can't ride on response
// headers here (they're flushed before usage is known) — streamed requests are
// metered via the store, so they still appear in /api/stats and /api/report.
// ---------------------------------------------------------------------------
async function handleStreaming({ res, started, tenant, body, userText, decision, tier, model, cacheKey, grid, session, qualityEscalated, routing, reservation, reasoningInfo, reasoningPlan }) {
  const id = "joule-stream-" + started;
  const created = Math.floor(started / 1000);

  // cache hit — replay the cached answer as an SSE stream
  const cached = cacheGet(cacheKey);
  if (cached) {
    const content = cached.choices?.[0]?.message?.content || "";
    sseHeaders(res);
    streamText(res, { id, created, model, content });
    const promptTokens = cached.usage?.prompt_tokens ?? estTokens(userText);
    const completionTokens = cached.usage?.completion_tokens ?? estTokens(content);
    const mCache = meterAndLog({ started, tenant, mode: "cache", model, tier, decision, grid, promptTokens, completionTokens, session, qualityEscalated, routing, promptText: userText, completionText: content });
    budget.commit(reservation, mCache.actual.costUsd); if (reservation) reservation.committed = true;
    return;
  }

  // dry-run — synthesize a streamed answer, no external call
  if (config.dryRun) {
    const answer = `【dry-run】 streamed from ${model} (${tier}). Set DRY_RUN=false and UPSTREAM_API_KEY to make real calls.`;
    sseHeaders(res);
    streamText(res, { id, created, model, content: answer });
    const promptTokens = estTokens(userText);
    const completionTokens = estTokens(answer);
    cacheSet(cacheKey, buildCompletion({ id, created, model, content: answer, promptTokens, completionTokens }));
    const dryPrefix = prefixCacheSavings({ model, tier, cachedInputTokens: Math.round(promptTokens * config.cache.dryRunPrefixRate), writeInputTokens: 0 });
    const mDry = meterAndLog({ started, tenant, mode: "dry_run", model, tier, decision, grid, promptTokens, completionTokens, session, qualityEscalated, routing, promptText: userText, completionText: answer, prefixCache: dryPrefix, reasoning: finalizeReasoning(reasoningInfo, tier, null) });
    budget.commit(reservation, mDry.actual.costUsd); if (reservation) reservation.committed = true;
    verify.maybeVerify({ rec: mDry.rec, userText, answer, body });
    return;
  }

  // live — forward with stream:true and pipe chunks through unmodified (tenant's own key)
  const providerKey = providerKeyFor(tenant);
  if (!providerKey) {
    budget.release(reservation); if (reservation) reservation.committed = true;
    return res.status(400).json({ error: { message: "No provider API key for this workspace. Add one in the dashboard (Setup → step 1), or run with DRY_RUN=true.", type: "invalid_request_error", code: "no_provider_key" } });
  }
  // resilient connect (timeout + retry/backoff + optional fallback). Retry applies to the
  // INITIAL connection only — once bytes flow we can't safely re-issue the request.
  const buildBody = (m) => {
    const b = { ...body, model: m, stream: true, stream_options: { include_usage: true } };
    return (reasoningPlan && m === model) ? reasoning.applyToBody(b, reasoningPlan) : b;
  };
  const up = await upstream.openStream({ model, buildBody, apiKey: providerKey });
  if (!up.ok) {
    budget.release(reservation); if (reservation) reservation.committed = true;
    return res.status(up.status).json({ error: up.error });
  }
  model = up.modelUsed;

  sseHeaders(res);
  const reader = up.response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", acc = "", usage = null, streamBroke = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      res.write(text); // pipe upstream chunks to the client unmodified
      buffer += text;
      // parse complete SSE lines to capture usage + accumulate assistant text
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload);
          if (obj.usage) usage = obj.usage;
          const d = obj.choices?.[0]?.delta?.content;
          if (d) acc += d;
        } catch { /* partial or non-JSON line — ignore */ }
      }
    }
  } catch (streamErr) {
    // provider stream broke or the client disconnected mid-response — record what was
    // actually delivered, never leak the reservation, never crash.
    streamBroke = true;
    console.warn(`[stream] broke mid-response after ${acc.length} chars: ${scrub(streamErr && streamErr.message)}`);
    try { reader.cancel().catch(() => {}); } catch { /* already gone */ }
  }
  try { if (!res.writableEnded) res.end(); } catch { /* client already gone */ }

  // nothing delivered on a broken stream -> no metering record, just settle the reservation
  if (streamBroke && !acc) { budget.release(reservation); if (reservation) reservation.committed = true; return; }

  // token usage from the stream if the provider sent it, else estimate over what we got
  const promptTokens = usage?.prompt_tokens ?? estTokens(userText);
  const completionTokens = usage?.completion_tokens ?? estTokens(acc);
  if (!streamBroke) cacheSet(cacheKey, buildCompletion({ id, created, model, content: acc, promptTokens, completionTokens })); // never cache a partial answer
  const cuLive = extractCacheUsage(usage);
  const livePrefix = prefixCacheSavings({ model, tier, cachedInputTokens: cuLive.cachedInputTokens, writeInputTokens: cuLive.writeInputTokens });
  const mLive = meterAndLog({ started, tenant, mode: "live", model, tier, decision, grid, promptTokens, completionTokens, session, qualityEscalated, routing, promptText: userText, completionText: acc, prefixCache: livePrefix, reasoning: finalizeReasoning(reasoningInfo, tier, usage) });
  budget.commit(reservation, mLive.actual.costUsd); if (reservation) reservation.committed = true; // settle exactly once
  if (!streamBroke) verify.maybeVerify({ rec: mLive.rec, userText, answer: acc, body, completion: buildCompletion({ id, created, model, content: acc, promptTokens, completionTokens }) });
}

// ---------------------------------------------------------------------------
// OpenAI-compatible endpoint. Point any OpenAI SDK's baseURL at http://host/v1
// ---------------------------------------------------------------------------
app.post("/v1/chat/completions", async (req, res) => {
  const started = Date.now();
  let reservation = null;
  try {
    const body = req.body || {};
    const messages = body.messages || [];
    const userText = lastUserText(messages);
    const session = sessionOf(req);
    const tenant = req.tenant.id;   // resolved by proxyAuth; scopes routing, cache, budget, metering

    // 1) classify + route
    const decision = classify(userText);
    const routed = config.routingEnabled;
    let tier = routed ? decision.tier : tierForModel(body.model);
    // Quality gate: for small-classified requests, keep small only when the tenant's
    // calibrated score clears its conformal threshold (once calibrated); otherwise
    // fall back to the classifier/safety behaviour. Honours X-Joule-Quality-Floor.
    let qualityEscalated = false, routing = null;
    if (routed && tier === "small") {
      const floor = parseFloat(req.get("x-joule-quality-floor"));
      routing = verify.gate(decision, floor, tenant);
      if (!routing.routeSmall) { tier = "large"; qualityEscalated = true; }
    }
    let model = routed ? selectModel(tier) : (body.model || selectModel(tier));

    // 1b) reasoning-budget control (savings-hierarchy #3). Cap thinking budget on
    // reasoning models; optionally downgrade reasoning->standard for simple prompts
    // (a quality-risk decision, gated on the classifier's small-tier verdict).
    let reasoningInfo = null, reasoningPlan = null;
    if (reasoning.isReasoning(model)) {
      reasoningPlan = reasoning.planFor(model, decision, req.get("x-joule-reasoning-effort"));
      const base = { model, family: reasoningPlan.spec.family, effort: reasoningPlan.effort, capTokens: reasoningPlan.capTokens, uncappedTokens: reasoningPlan.uncappedTokens };
      if (config.reasoning.downgradeEnabled && decision.tier === "small") {
        model = config.reasoning.standardModel;                 // verified small-tier downgrade
        reasoningInfo = { ...base, downgraded: true };
        reasoningPlan = null;                                    // no budget to inject on a standard model
      } else {
        reasoningInfo = { ...base, downgraded: false };
      }
    }

    // 2) cache — namespaced by tenant so a tenant can NEVER receive another's cached response
    const cacheKey = tenant + "::" + model + "::" + norm(userText);
    const grid = await getIntensity();

    // 2b) budget: reserve the estimated cost BEFORE any model call. Enforcement
    // rejects (402) here — no model is called. Metering-only mode flags but allows.
    reservation = budget.reserve({
      tenantId: tenant, sessionId: session, estCostUsd: estimateRequestCost(model, tier, userText),
      maxCostUsd: parseFloat(req.get("x-joule-max-cost")), now: started
    });
    if (!reservation.ok) return res.status(reservation.status || 429).json({ error: { message: reservation.message, budget: reservation.detail } });

    // streaming branch — SSE out, metered via the store (not response headers)
    if (body.stream === true) {
      return await handleStreaming({ res, started, tenant, body, userText, decision, tier, model, cacheKey, grid, session, qualityEscalated, routing, reservation, reasoningInfo, reasoningPlan });
    }

    const cachedCompletion = cacheGet(cacheKey);
    let completion, promptTokens, completionTokens, mode, prefixCache = null, semantic = null;

    // Layer-2 semantic cache — ONLY on a Layer-1 (exact) miss, so hits never embed.
    // Namespaced by tenant/project/user-tier/model/system-prompt for ISOLATION;
    // sensitive prompts (patterns or X-Joule-Cache-Bypass) skip the semantic layer.
    const systemText = messages.filter((mm) => mm && mm.role === "system").map((mm) => typeof mm.content === "string" ? mm.content : "").join(" ");
    // tenant comes from the AUTHENTICATED identity (not a spoofable header); project/user-tier
    // are optional SUB-scopes within the tenant. A semantic hit can never cross tenants.
    const semCtx = { tenant: tenant, project: req.get("x-joule-project") || null, userTier: req.get("x-joule-user-tier") || null, model, systemHash: systemText };
    const cacheBypass = semcache.isBypassed(userText, req.get("x-joule-cache-bypass"));
    let semLookup = null;
    if (!cachedCompletion && semcache.enabled()) {
      if (cacheBypass) semcache.recordBypass();
      // embeddings endpoint down -> skip the semantic layer, fall through to a normal call
      else { try { semLookup = await semcache.lookup(semCtx, userText); } catch (e) { semLookup = null; console.warn(`[semcache] lookup skipped (embeddings degraded): ${scrub(e && e.message)}`); } }
    }

    if (cachedCompletion) {
      completion = cachedCompletion;
      promptTokens = completion.usage?.prompt_tokens ?? estTokens(userText);
      completionTokens = completion.usage?.completion_tokens ?? 0;
      mode = "cache";
    } else if (semLookup && semLookup.entry) {
      // semantic hit — serve the cached answer. QUALITY RISK: tracked on its own line,
      // sampled hits are verified to learn per-entry thresholds and bound the error rate.
      const e = semLookup.entry;
      completion = e.completion;
      promptTokens = e.promptTokens; completionTokens = e.completionTokens;
      mode = "semantic_cache";
      semantic = { sim: semLookup.sim, threshold: e.threshold, asOf: new Date(e.createdAt).toISOString(), embedCostUsd: (estTokens(userText) / 1e6) * config.semanticCache.embedPricePerM };
      const answer = e.completion.choices?.[0]?.message?.content || "";
      semcache.onServe(e, semLookup.sim, () => config.dryRun ? semcache.dryCorrect(semLookup.sim) : liveSemanticCorrect(userText, model, answer));
    } else if (config.dryRun) {
      // full pipeline, synthesized answer — clearly labelled, no external call
      const answer = `【dry-run】 routed to ${model} (${tier}). Set DRY_RUN=false and UPSTREAM_API_KEY to make real calls.`;
      promptTokens = estTokens(userText);
      completionTokens = estTokens(answer);
      completion = {
        id: "joule-dry-" + started, object: "chat.completion", created: Math.floor(started / 1000),
        model, choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
      };
      mode = "dry_run";
      // synthesize a plausible prefix-cache hit so the advisory is demoable offline
      prefixCache = prefixCacheSavings({ model, tier, cachedInputTokens: Math.round(promptTokens * config.cache.dryRunPrefixRate), writeInputTokens: 0 });
      if (semLookup) semcache.addEntry({ ctx: semCtx, userText, vec: semLookup.vec, completion, promptTokens, completionTokens, hasPII: containsPII(userText) || containsPII(answer) });
    } else {
      // real upstream call — uses THIS TENANT's provider key (falls back to the global env
      // key for the single-tenant/dev path); timeout + retry/backoff + fallback via upstream.js
      const providerKey = providerKeyFor(tenant);
      if (!providerKey) {
        budget.release(reservation); reservation.committed = true; // no model call happened — free the reservation
        return res.status(400).json({ error: { message: "No provider API key for this workspace. Add one in the dashboard (Setup → step 1), or run with DRY_RUN=true.", type: "invalid_request_error", code: "no_provider_key" } });
      }
      // build the per-model request body (reasoning budget injected only on the routed model)
      const buildBody = (m) => (reasoningPlan && m === model) ? reasoning.applyToBody({ ...body, model: m }, reasoningPlan) : { ...body, model: m };
      const up = await upstream.callJson({ model, buildBody, apiKey: providerKey });
      if (!up.ok) {
        // clean OpenAI-shaped error; reservation freed, nothing metered (no corrupt record)
        budget.release(reservation); reservation.committed = true;
        return res.status(up.status).json({ error: up.error });
      }
      const data = up.data;
      model = up.modelUsed; // reflect a fallback model honestly in metering + headers
      completion = data;
      promptTokens = data.usage?.prompt_tokens ?? estTokens(userText);
      completionTokens = data.usage?.completion_tokens ?? estTokens(JSON.stringify(data.choices?.[0]?.message?.content || ""));
      mode = "live";
      // real prefix-cache savings from the provider's returned usage
      const cu = extractCacheUsage(data.usage);
      prefixCache = prefixCacheSavings({ model, tier, cachedInputTokens: cu.cachedInputTokens, writeInputTokens: cu.writeInputTokens });
      if (semLookup) semcache.addEntry({ ctx: semCtx, userText, vec: semLookup.vec, completion, promptTokens, completionTokens, hasPII: containsPII(userText) || containsPII(data.choices?.[0]?.message?.content || "") });
    }

    // populate the exact cache for freshly-generated completions only (never for a
    // semantic hit — that would store one question's answer under another's key)
    if (mode !== "cache" && mode !== "semantic_cache") cacheSet(cacheKey, completion);

    // 3) meter + 4) log (shared with the streaming path)
    const latencyTolerant = /^(1|true|yes)$/i.test(req.get("x-joule-latency-tolerant") || "");
    const m = meterAndLog({ started, tenant, mode, model, tier, decision, grid, promptTokens, completionTokens, session, qualityEscalated, routing, promptText: userText, completionText: completion.choices?.[0]?.message?.content || "", prefixCache, semantic, reasoning: finalizeReasoning(reasoningInfo, tier, completion.usage), batch: (latencyTolerant && mode !== "cache") ? { discount: config.batch.discount } : undefined });
    budget.commit(reservation, m.actual.costUsd); reservation.committed = true; // reconcile reservation to actual spend

    // 5) expose metrics on headers (drop-in clients still get a clean OpenAI body)
    res.set({
      "x-joule-mode": mode,
      "x-joule-tier": tier,
      "x-joule-model": model,
      "x-joule-cost-usd": m.actual.costUsd.toFixed(6),
      "x-joule-energy-wh": m.actual.energyWh.toFixed(4),
      "x-joule-co2-g": m.actual.carbonG.toFixed(4),
      "x-joule-saved-usd": m.saved.costUsd.toFixed(6),
      "x-joule-saved-co2-g": m.saved.carbonG.toFixed(4)
    });
    res.json(completion);

    // 6) quality verification — AFTER the response, off the serving path
    verify.maybeVerify({ rec: m.rec, userText, answer: completion.choices?.[0]?.message?.content || "", body, completion });
  } catch (err) {
    if (reservation && reservation.ok && !reservation.committed) budget.release(reservation); // free unspent reservation
    // once an SSE stream has started, headers are already flushed — just end it
    if (res.headersSent) { try { res.end(); } catch { /* client gone */ } }
    else res.status(502).json({ error: { message: scrub("joule proxy error: " + err.message) } });
  }
});

// Combine per-view verification stats (from the filtered totals) with the global
// rolling-quality + safety-mode state. `score` is null until >=1 sample verified.
function qualityBlock(totals, tenant) {
  const q = verify.qualityStats(tenant);
  return {
    score: totals.qualityScore,                                                     // avg quality of verified records IN VIEW
    verified: totals.verified,
    verifiedPct: totals.requests ? Math.round((totals.verified / totals.requests) * 100) : 0,
    rollingScore: q.rollingScore,                                                   // global rolling (null until first sample)
    sampleCount: q.sampleCount, sampleRate: q.sampleRate, threshold: q.threshold,
    safetyMode: q.safetyMode, enabled: q.enabled, referenceModel: q.referenceModel, judgeModels: q.judgeModels,
    overhead: q.overhead,                                                           // verification token overhead
    net: totals.net,                                                                // savings minus verification overhead
    // calibrated + conformal verification (the guarantee — marginal, not per-query)
    mode: q.mode, guaranteeReady: q.guaranteeReady, lowAgreementCount: q.lowAgreementCount,
    calibration: q.calibration,                                                     // {n, ready, minN, ece}
    conformal: q.conformal,                                                         // {alpha, threshold, coverage, riskBound, n, ready}
    drift: q.drift                                                                  // {status, drift, ...}
  };
}

// Deployment / residency posture — we DESCRIBE it; we do not certify legal compliance.
function deploymentBlock() {
  const crossBorder = String(config.dataRegion).toUpperCase() !== String(config.providerRegion).toUpperCase();
  return {
    mode: config.deploymentMode,
    dataRegion: config.dataRegion,
    providerRegion: config.providerRegion,
    crossBorder,                              // prompts leave dataRegion to reach the provider
    promptTextRetained: config.logPrompts,     // false by default (metadata-only)
    piiRedaction: config.piiRedact
  };
}

// ---- batch processing (savings-hierarchy #2) -------------------------------
// Process one submitted item: same classify->route->meter pipeline, metered at the
// batch discount (zero quality risk — same model/output, just async). No cache/
// semantic/verify in the batch path (kept self-contained).
async function processBatchItem(item, session, grid, tenant) {
  const messages = item.messages || [];
  const userText = lastUserText(messages);
  const decision = classify(userText);
  const routed = config.routingEnabled;
  const tier = routed ? decision.tier : tierForModel(item.model);
  const model = routed ? selectModel(tier) : (item.model || selectModel(tier));
  const started = Date.now();
  let completion, promptTokens, completionTokens;
  if (config.dryRun) {
    const answer = `【dry-run·batch】 ${model} (${tier}) at ${Math.round(config.batch.discount * 100)}% batch discount.`;
    promptTokens = estTokens(userText); completionTokens = estTokens(answer);
    completion = buildCompletion({ id: "joule-batch-" + started, created: Math.floor(started / 1000), model, content: answer, promptTokens, completionTokens });
  } else {
    const batchKey = providerKeyFor(tenant);   // the submitting tenant's own provider key
    if (!batchKey) throw new Error("no provider API key for this workspace");
    const up = await fetch(config.upstreamBaseUrl + "/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + batchKey },
      body: JSON.stringify({ ...item, model, stream: false }), signal: AbortSignal.timeout(120000)
    });
    completion = await up.json();
    if (!up.ok) throw new Error("upstream " + up.status);
    promptTokens = completion.usage?.prompt_tokens ?? estTokens(userText);
    completionTokens = completion.usage?.completion_tokens ?? estTokens(JSON.stringify(completion.choices?.[0]?.message?.content || ""));
  }
  const m = meterAndLog({ started, tenant, mode: "batch", model, tier, decision, grid, promptTokens, completionTokens, session: item.session || session, routing: null, promptText: userText, completionText: completion.choices?.[0]?.message?.content || "", batch: { discount: config.batch.discount } });
  return { custom_id: item.custom_id ?? null, tier, model, completion, saved_usd: m.rec.batch.savedUsd };
}

async function runBatch(job, items, session, tenant) {
  const grid = await getIntensity();
  for (const item of items) {
    try { job.results.push(await processBatchItem(item, session, grid, tenant)); }
    catch (err) { job.results.push({ custom_id: item.custom_id ?? null, error: scrub(err.message) }); }
    job.completed++;
  }
  job.totals = { savedUsd: job.results.reduce((s, r) => s + (r.saved_usd || 0), 0) };
  job.status = "completed";
}

// Cache advisory + separate savings line (Layer 1). Prefix/exact caching is ZERO
// quality risk; savings are NET of the cache-write premium.
function cacheBlock(totals) {
  const req = totals.requests || 0;
  const pc = totals.prefixCache;
  const exactHitRate = req ? totals.cacheHits / req : 0;
  const prefixReuse = (pc.cachedTokens + pc.writeTokens) ? pc.cachedTokens / (pc.cachedTokens + pc.writeTokens) : 0;
  const breakevenHitRate = cacheadvice.breakevenHitRate();
  const belowBreakeven = pc.writeTokens > 0 && prefixReuse < breakevenHitRate;
  const hostileRate = req ? totals.hostile / req : 0;
  const stats = { requests: req, exactHits: totals.cacheHits, exactHitRate, prefixReuse, breakevenHitRate, belowBreakeven, hostileRate };
  const sc = semcache.stats();
  return {
    ...stats,
    exactCacheSavedUsd: totals.cacheSavedUsd,      // separate from routing savings
    routingSavedUsd: totals.routingSavedUsd,
    prefixCache: pc,                                // {cachedTokens, writeTokens, savedUsd, writePremiumUsd, netSavedUsd}
    tips: cacheadvice.tips(stats),
    note: "Prefix/exact caching is ZERO quality risk — the model recomputes nothing, output is unchanged. Savings are NET of the cache-write premium and kept on a separate line from routing.",
    // Layer-2 semantic cache — a SEPARATE, quality-RISKY line (opt-in) + SAFETY panel.
    semantic: {
      enabled: sc.enabled, active: sc.active, autoDisabled: sc.autoDisabled, autoDisabledReason: sc.autoDisabledReason,
      entries: sc.entries, namespaces: sc.namespaces, hits: totals.semantic.hits,
      savedUsd: totals.semantic.savedUsd, embedCostUsd: totals.semantic.embedCostUsd, netSavedUsd: totals.semantic.netSavedUsd,
      // HONESTY: realisedErrorRate=null means NOT YET MEASURED on this traffic — no safe claim.
      realisedErrorRate: sc.realisedErrorRate, targetError: sc.targetError, disableErrorRate: sc.disableErrorRate,
      verified: sc.verified, servedErrors: sc.servedErrors,
      avgThreshold: sc.avgThreshold, baseThreshold: sc.baseThreshold, minSimilarity: sc.minSimilarity,
      ttlSec: sc.ttlSec, version: sc.version, bypassCount: sc.bypassCount, similarityDistribution: sc.similarityDistribution,
      note: "Semantic caching CAN return a different question's answer — a genuine quality risk, NOT risk-free. It is namespace-isolated per tenant/scope, TTL + version invalidated, sensitive-query bypassed, and served only above a hard similarity floor. A sample of hits is verified; if the realised error rate exceeds target the layer auto-tightens, then auto-DISABLES. Savings must be read WITH the realised error rate; null = not yet measured on this traffic."
    }
  };
}

// ---- dashboard data ----
app.get("/api/stats", async (req, res) => {
  const tenant = req.tenant.id;
  const grid = await getIntensity();
  const totals = store.aggregate(store.predicateFor({ tenant })); // TENANT-SCOPED
  res.json({
    deployment: deploymentBlock(),
    cache: cacheBlock(totals),
    batch: batchBlock(totals),
    reasoning: reasoningBlock(totals),
    budget: budget.stats(tenant),
    config: {
      dryRun: config.dryRun,
      routingEnabled: config.routingEnabled,
      hasUpstreamKey: Boolean(config.upstreamApiKey),
      hasEmToken: Boolean(config.emToken),
      modelSmall: config.modelSmall, modelLarge: config.modelLarge,
      upstreamBaseUrl: config.upstreamBaseUrl
    },
    grid,
    totals,
    quality: qualityBlock(totals, tenant),
    recent: store.recent(25, tenant)
  });
});

// Validate the shared filter query used by /api/summary and /api/report.
function parseFilter(q) {
  return {
    range: ["1h", "24h", "7d", "all"].includes(q.range) ? q.range : "all",
    tier: ["small", "large"].includes(q.tier) ? q.tier : null,
    mode: ["live", "dry_run", "cache"].includes(q.mode) ? q.mode : null,
    q: typeof q.q === "string" ? q.q.slice(0, 64) : ""
  };
}

// ---- self-serve onboarding (Phase 1.2) -------------------------------------
// Browser bootstrap for the login screen. PUBLIC (pre-auth) and deliberately limited to
// the Supabase project URL + ANON key, which are designed to be public. `authRequired`
// tells the dashboard whether to show a login screen at all (dev/DRY_RUN runs open).
app.get("/api/auth-config", (_req, res) => res.json({
  authRequired: config.auth.required,
  supabaseUrl: config.auth.supabaseUrl,
  supabaseAnonKey: config.auth.supabaseAnonKey,
  configured: Boolean(config.auth.supabaseUrl && config.auth.supabaseAnonKey)
}));

// A new workspace goes signup -> provider key -> Joule key -> first request with no
// help from us. All routes are tenant-scoped by dashAuth. Secrets are write-only:
// a provider key can be SET and its status read, but never read back over the API.

// Onboarding state — drives the wizard and the "waiting for your first request" poll.
function onboardingState(tenantId) {
  const requests = store.all(tenantId).length;
  const keys = tenancy.listKeys(tenantId).filter((k) => !k.revoked);
  const hasProviderKey = Boolean(tenancy.getUpstreamKey(tenantId));
  return {
    steps: { providerKey: hasProviderKey, jouleKey: keys.length > 0, firstRequest: requests > 0 },
    complete: hasProviderKey && keys.length > 0 && requests > 0,
    requests,
    // dryRun workspaces can complete without a provider key (synthesized answers)
    dryRun: config.dryRun
  };
}

// Who am I + what's left to do. The dashboard calls this on load.
app.get("/api/me", (req, res) => {
  const tenantId = req.tenant.id;
  res.json({
    tenant: { id: tenantId },
    user: { id: req.tenant.userId || null, email: req.tenant.email || null },
    endpoint: `${req.protocol}://${req.get("host")}/v1`,   // exact baseURL for their SDK
    authRequired: config.auth.required,
    // drives the Settings split: operators get the editable instance form, tenants a read-only view
    isOperator: Boolean(req.isOperator),
    // per-workspace provider connection state. The KEY ITSELF IS NEVER RETURNED — only
    // whether one is set, its last 4, and which endpoint it points at.
    provider: (() => {
      const k = tenancy.getUpstreamKey(tenantId);
      return { connected: Boolean(k), last4: k ? k.slice(-4) : null, baseUrl: config.upstreamBaseUrl };
    })(),
    branding: { logo: tenancy.getLogo(tenantId) },
    onboarding: onboardingState(tenantId),
    keys: tenancy.listKeys(tenantId)
  });
});

// Lightweight poll for the "waiting for your first request…" state + the activation
// moment. Returns the tenant's FIRST real record so the UI can celebrate honestly.
app.get("/api/onboarding", (req, res) => {
  const tenantId = req.tenant.id;
  const first = store.all(tenantId)[0] || null;
  res.json({
    ...onboardingState(tenantId),
    firstRequest: first ? {
      ts: first.ts, model: first.model, tier: first.tier, mode: first.mode,
      costUsd: first.actual.costUsd, energyWh: first.actual.energyWh, carbonG: first.actual.carbonG,
      savedUsd: first.saved.costUsd, savedCarbonG: first.saved.carbonG,
      totalTokens: first.totalTokens,
      // HONESTY: quality is null until a verification sample lands — never a fake score.
      qualityScore: first.verification ? first.verification.qualityScore : null
    } : null
  });
});

// STEP 1 — validate + store this tenant's provider key (encrypted at rest, never logged).
app.post("/api/provider-key", async (req, res) => {
  const tenantId = req.tenant.id;
  const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
  const baseUrl = typeof req.body?.baseUrl === "string" && req.body.baseUrl.trim() ? req.body.baseUrl.trim() : config.upstreamBaseUrl;
  if (!apiKey) return res.status(400).json({ ok: false, valid: false, message: "Paste your provider API key." });
  // real but free validation call (GET /models) so a bad key fails here, not in production
  const check = await upstream.validateKey({ apiKey, baseUrl });
  if (!check.valid) return res.status(400).json({ ok: false, valid: false, message: check.message });
  tenancy.setUpstreamKey(tenantId, apiKey);
  res.json({ ok: true, valid: true, message: check.message, last4: apiKey.slice(-4), onboarding: onboardingState(tenantId) });
});

// STEP 2 — mint a Joule API key. The plaintext is returned ONCE and never again.
app.post("/api/keys", (req, res) => {
  const tenantId = req.tenant.id;
  const name = typeof req.body?.name === "string" ? req.body.name.slice(0, 60) : "default";
  const minted = tenancy.mintKey(tenantId, name);
  res.status(201).json({
    key: minted.key,                    // shown ONCE — the UI must tell the user to copy it now
    id: minted.id, last4: minted.last4, name: minted.name,
    endpoint: `${req.protocol}://${req.get("host")}/v1`,
    onboarding: onboardingState(tenantId)
  });
});

app.get("/api/keys", (req, res) => res.json({ keys: tenancy.listKeys(req.tenant.id) }));

app.post("/api/keys/:id/revoke", (req, res) => {
  // scope the revoke to THIS tenant's keys — you can never revoke another tenant's key
  const owned = tenancy.listKeys(req.tenant.id).some((k) => k.id === req.params.id);
  if (!owned) return res.status(404).json({ ok: false, message: "key not found" });
  res.json({ ok: tenancy.revokeKey(req.params.id) });
});

// Server-computed aggregates + time-series + per-model + sessions, all from the
// real log and filtered by range/tier/mode/model — the dashboard renders this so
// UI and server always agree. /v1/chat/completions behaviour is unchanged.
app.get("/api/summary", (req, res) => {
  const tenant = req.tenant.id;
  const sum = store.summary({ ...parseFilter(req.query), tenant }); // TENANT-SCOPED
  sum.quality = qualityBlock(sum.totals, tenant);
  sum.cache = cacheBlock(sum.totals);
  sum.batch = batchBlock(sum.totals);
  sum.reasoning = reasoningBlock(sum.totals);
  res.json(sum);
});

// Clear ONLY the caller's tenant data (in memory + durably). Destructive by design.
app.post("/api/clear", (req, res) => {
  const removed = store.clear(req.tenant.id);
  res.json({ cleared: true, removed });
});

// ---- batch endpoint (savings-hierarchy #2) ----
// Submit latency-tolerant work; processed async at the provider batch discount.
app.post("/v1/batch", (req, res) => {
  const items = req.body && req.body.requests;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: { message: "requests[] required" } });
  if (items.length > config.batch.maxSize) return res.status(400).json({ error: { message: `batch too large (max ${config.batch.maxSize})` } });
  const session = sessionOf(req);
  const tenant = req.tenant.id;
  const job = batch.submit(items.length);
  job.tenant = tenant; // tag the job so it can never be polled cross-tenant
  runBatch(job, items, session, tenant).catch((err) => { job.status = "failed"; job.error = scrub(err.message); });
  res.status(202).json({ id: job.id, status: job.status, count: job.count });
});

app.get("/v1/batch/:id", (req, res) => {
  const job = batch.get(req.params.id);
  // tenant isolation: a missing job and another tenant's job are indistinguishable (404)
  if (!job || (job.tenant && job.tenant !== req.tenant.id)) return res.status(404).json({ error: { message: "batch not found" } });
  res.json({ id: job.id, status: job.status, count: job.count, completed: job.completed, error: job.error, totals: job.totals, results: job.status === "completed" ? job.results : undefined });
});

// Reasoning-budget control block. Capping the thinking budget is low quality risk;
// a reasoning->standard downgrade is verified through the same conformal path as routing.
function reasoningBlock(totals) {
  const r = totals.reasoning;
  return {
    requests: r.requests, downgrades: r.downgrades,
    reasoningTokens: r.reasoningTokens,
    avgThinkingBudget: r.requests ? Math.round(r.reasoningTokens / r.requests) : 0,
    savedTokens: r.savedTokens, savedUsd: r.savedUsd,
    maxThinkingTokens: config.reasoning.maxThinkingTokens, defaultEffort: config.reasoning.defaultEffort,
    downgradeEnabled: config.reasoning.downgradeEnabled,
    note: "Reasoning tokens are GENERATED tokens (bill as output, count toward energy). Capping the thinking budget is low quality risk; downgrading a reasoning model to a standard one is a quality-risk decision, verified via the conformal path. Savings are labelled estimates (we don't run the uncapped variant)."
  };
}

// Batch savings line + advisory (zero quality risk).
function batchBlock(totals) {
  return {
    discount: config.batch.discount,
    count: totals.batch.count,
    savedUsd: totals.batch.savedUsd,
    note: `Batch processing runs latency-tolerant work asynchronously at the provider batch discount (~${Math.round(config.batch.discount * 100)}% off) — ZERO quality risk (same model, same output). Submit via POST /v1/batch; savings reported on a separate line.`
  };
}

// Quantified cache advisory — actionable findings with before/after + $ impact (estimates).
app.get("/api/advisory", (req, res) => {
  res.json(cacheadvice.advisory(store.all(req.tenant.id)));
});

// ---- trust surface (Phase 2.2): reliability evidence -----------------------
// Real component health + REAL measured latency + REAL process uptime. We do not compute
// an uptime percentage or a "last incident": we don't retain incident history, and
// inventing either would be exactly the fabricated-reliability claim we refuse to make.
app.get("/api/status", async (req, res) => {
  const tenant = req.tenant.id;
  const db = store.health();
  const prov = config.dryRun ? { status: "dry_run" } : (config.upstreamApiKey || tenancy.getUpstreamKey(tenant) ? upstream.providerHealth() : { status: "no_key" });
  let grid = { status: "unknown" };
  try { const g = await getIntensity(); grid = { status: g.live ? "live" : "fallback", source: g.source, zone: g.zone }; } catch { grid = { status: "fallback" }; }
  const latency = store.latencyStats(store.predicateFor({ tenant }));
  res.json({
    ok: true,
    components: {
      proxy: { status: "ok", uptimeSeconds: Math.floor(process.uptime()), startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() },
      database: { status: db.status, backend: db.backend, pendingWrites: db.pendingWrites || 0 },
      provider: prov,
      grid
    },
    // MEASURED end-to-end durations for this workspace — null when nothing to measure.
    latency,
    // Stated plainly rather than fabricated:
    uptimeHistory: { available: false, note: "Historical uptime and incident history are not retained yet, so no availability percentage is claimed here. Current component state above is live. (On roadmap.)" }
  });
});

// Rotate a Joule key: mint a replacement and revoke the old one. Returns the new key ONCE.
app.post("/api/keys/:id/rotate", (req, res) => {
  const tenantId = req.tenant.id;
  const existing = tenancy.listKeys(tenantId).find((k) => k.id === req.params.id);
  if (!existing) return res.status(404).json({ ok: false, message: "key not found" }); // never rotate another tenant's key
  const minted = tenancy.mintKey(tenantId, existing.name || "rotated");
  tenancy.revokeKey(req.params.id);   // old key stops authenticating immediately
  res.status(201).json({ ok: true, key: minted.key, id: minted.id, last4: minted.last4, name: minted.name, revoked: req.params.id });
});

// ---- profile / account (§8) ------------------------------------------------
// ACCOUNT settings live here; WORKSPACE settings live under /api/config + /api/provider-key.
// Email and password changes are performed by the MANAGED auth provider in the browser —
// this server never sees a password. It owns only the things a client cannot be trusted
// with: the 30-day email cooldown, the per-tenant logo, and tenant-scoped deletion.

app.get("/api/profile", (req, res) => {
  const tenantId = req.tenant.id, userId = req.tenant.userId;
  res.json({
    user: { id: userId, email: req.tenant.email || null },
    tenant: { id: tenantId, name: (tenancy.getTenant(tenantId) || {}).name || null },
    emailChange: tenancy.emailChangeState(userId),
    logo: tenancy.getLogo(tenantId),
    // Honest: there is no billing backend wired up. We say so rather than fake a plan.
    subscription: {
      billingConfigured: false,
      planPriceMonthly: config.subscriptionCostMonthly || 0,
      status: config.subscriptionCostMonthly > 0 ? "priced" : "none",
      note: "Billing isn't connected to this deployment yet, so there's no subscription to manage here. Plan changes are handled by our team."
    },
    authProviderConfigured: Boolean(config.auth.supabaseUrl && config.auth.supabaseAnonKey)
  });
});

// The COOLDOWN GATE. The client asks permission BEFORE calling the auth provider, and
// confirms afterwards. Server-side because a client-side check is not enforcement.
app.post("/api/profile/email-change", (req, res) => {
  const userId = req.tenant.userId, tenantId = req.tenant.id;
  if (!userId) return res.status(400).json({ ok: false, message: "No signed-in user to apply this to." });
  const state = tenancy.emailChangeState(userId);
  if (!state.allowed) {
    return res.status(429).json({
      ok: false, ...state,
      message: `You can change your email again on ${new Date(state.nextAllowedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}.`
    });
  }
  if (req.body && req.body.confirm === true) {   // the provider accepted it — start the clock
    const when = tenancy.recordEmailChange(userId, tenantId);
    return res.json({ ok: true, recordedAt: when, ...tenancy.emailChangeState(userId) });
  }
  res.json({ ok: true, ...state });              // permission check only
});

// Company logo — replaces the sidebar mark. Validated: type + size, before anything is stored.
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
const LOGO_MAX_BYTES = 256 * 1024;
app.post("/api/profile/logo", (req, res) => {
  const dataUrl = typeof req.body?.dataUrl === "string" ? req.body.dataUrl : "";
  const m = /^data:([a-z+/-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl.trim());
  if (!m) return res.status(400).json({ ok: false, message: "That doesn't look like an image file." });
  if (!LOGO_TYPES.includes(m[1].toLowerCase())) {
    return res.status(400).json({ ok: false, message: "Use a PNG, JPEG, WebP or SVG image." });
  }
  const bytes = Math.floor(m[2].length * 3 / 4);
  if (bytes > LOGO_MAX_BYTES) {
    return res.status(413).json({ ok: false, message: `That image is ${(bytes / 1024).toFixed(0)} KB — please use one under ${LOGO_MAX_BYTES / 1024} KB.` });
  }
  tenancy.setLogo(req.tenant.id, dataUrl.trim());
  res.json({ ok: true, logo: tenancy.getLogo(req.tenant.id) });
});
app.delete("/api/profile/logo", (req, res) => { tenancy.setLogo(req.tenant.id, null); res.json({ ok: true, logo: null }); });

// Account deletion. Requires a typed confirmation; deletes EVERYTHING for this tenant.
app.post("/api/profile/delete", async (req, res) => {
  const tenantId = req.tenant.id;
  const typed = String(req.body?.confirm || "").trim().toUpperCase();
  if (typed !== "DELETE") {
    return res.status(400).json({ ok: false, message: 'Type DELETE to confirm.' });
  }
  const removedRecords = store.clear(tenantId);              // request log (durable + mirror)
  const purged = tenancy.purgeTenant(tenantId);              // keys, secrets, users, logo, tenant
  try { const d = store.durable(); if (d && d.deleteTenant) await d.deleteTenant(tenantId); }
  catch (e) { console.error("tenant delete error:", e && e.message); }
  // The auth account itself belongs to the managed provider — we do not hold the
  // privileged key needed to delete it, and we say so rather than implying we did.
  res.json({
    ok: true, removedRecords, revokedKeys: purged.keys,
    reason: typeof req.body?.reason === "string" ? req.body.reason.slice(0, 200) : null,
    authAccountNote: "Your Joule workspace and all its data are deleted. Your sign-in account is held by our authentication provider — contact us if you also want that removed."
  });
});

// Weekly value digest for THIS tenant — the same payload the email uses, so the in-app
// summary and the email can never disagree. ?days=N to change the window; ?send=1 to
// deliver it (no-ops cleanly, and reports why, when no email provider is configured).
app.get("/api/digest", async (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
  const d = digest.build(req.tenant.id, { days });
  let delivery = { sent: false, reason: "not requested" };
  if (req.query.send === "1") delivery = await digest.send(d, req.tenant.email || req.query.to || null);
  res.json({ ...d, text: digest.toText(d), delivery });
});

// Budget definitions + live spend/remaining + terminated sessions + recent events.
app.get("/api/budgets", (req, res) => {
  res.json({ ...budget.stats(req.tenant.id), definitions: budget.budgets(req.tenant.id) });
});

// Cumulative ROI since day one — real logged data only; empty state when no history.
app.get("/api/roi", (req, res) => {
  const tenant = req.tenant.id;
  const rollups = store.dailyRollups(tenant);
  const subMonthly = config.subscriptionCostMonthly;
  if (!rollups.length) {
    return res.json({ empty: true, startDate: null, lifetime: null, series: [], net: null, subscriptionMonthly: subMonthly });
  }
  const totals = store.aggregate(store.predicateFor({ tenant }));
  const startDate = rollups[0].date, endDate = rollups[rollups.length - 1].date;
  const days = Math.max(1, Math.round((new Date(endDate + "T00:00:00Z") - new Date(startDate + "T00:00:00Z")) / 86400000) + 1);
  const months = days / 30.4375;
  const grossSaved = totals.cost.saved, verifyCost = totals.verifyCost.costUsd;
  const subscriptionToDate = subMonthly * months;
  // Daily subscription accrual so the NET line on the chart is honest day by day, not
  // just at the endpoint (gross compounds, fees accrue — both must be visible).
  const subPerDay = subMonthly > 0 ? (subMonthly * 12) / 365.25 : 0;
  let cCost = 0, cCarbon = 0, cVerify = 0;
  const series = rollups.map((r, i) => {
    cCost += r.cost.saved; cCarbon += r.carbonG.saved; cVerify += r.verifyCost.costUsd;
    return {
      date: r.date, savedCost: r.cost.saved, savedCarbonG: r.carbonG.saved,
      cumSavedCost: cCost, cumSavedCarbonG: cCarbon, cumVerifyCost: cVerify,
      // net-of-fees to date: what they'd actually be up by on this day
      cumNet: cCost - cVerify - subPerDay * (i + 1)
    };
  });
  const monthlyNetBeforeSub = (grossSaved - verifyCost) / months;

  // WHERE the saving came from. Each lever carries its own quality-risk label AND its
  // BASIS, because these are not slices of one pie:
  //   basis "baseline"   — measured against the always-large baseline; these SUM to
  //                        `cost.saved` (the headline gross figure).
  //   basis "additional" — separate savings lines on a different basis (a discount on
  //                        actual spend, or an estimate). Reported separately and NEVER
  //                        added into the headline, or we'd be double-counting.
  const mkLevers = (rows) => rows.filter((l) => Math.abs(l.savedUsd) > 1e-12).sort((a, b) => b.savedUsd - a.savedUsd);
  const baselineLevers = mkLevers([
    { id: "cache", label: "Exact cache", basis: "baseline", savedUsd: totals.cacheSavedUsd, risk: "none", note: "Model recomputes nothing — the output is byte-identical." },
    { id: "routing", label: "Model routing", basis: "baseline", savedUsd: totals.routingSavedUsd, risk: "verified", note: "A quality-risk decision, bounded by the conformal gate and verified on a sample." },
    { id: "semantic", label: "Semantic cache", basis: "baseline", savedUsd: totals.semantic.savedUsd, risk: "quality-risk", note: "Can return a similar question's answer — read WITH the realised error rate." }
  ]);
  const additionalLevers = mkLevers([
    { id: "prefixCache", label: "Provider prefix cache", basis: "additional", savedUsd: totals.prefixCache.netSavedUsd || 0, risk: "none", note: "Net of the cache-write premium, from the provider's own reported usage." },
    { id: "batch", label: "Batch discount", basis: "additional", savedUsd: totals.batch.savedUsd, risk: "none", note: "Same model, same output — a discount on actual spend for async work." },
    { id: "reasoning", label: "Reasoning-budget control", basis: "additional", savedUsd: totals.reasoning.savedUsd, risk: "estimated", note: "Estimated — we don't run the uncapped variant to compare against." },
    { id: "semanticEmbedCost", label: "…less semantic embedding cost", basis: "additional", savedUsd: -(totals.semantic.embedCostUsd || 0), risk: "none", note: "The embedding spend that semantic-cache savings are reported net of." }
  ]);
  const levers = baselineLevers.concat(additionalLevers);

  // HONESTY: savings are never shown without the quality that was held while making them.
  const minSamples = config.verify.minCalibrationN;
  const quality = {
    score: totals.qualityScore,                       // null until >=1 verified sample
    verified: totals.verified,
    requests: totals.requests,
    sufficient: totals.verified >= minSamples,        // below this we refuse to state a guarantee
    minSamples,
    guaranteeReady: verify.qualityStats(tenant).guaranteeReady
  };

  res.json({
    empty: false, startDate, endDate, days,
    lifetime: { requests: totals.requests, savedCost: grossSaved, savedCarbonG: totals.carbonG.saved, savedEnergyWh: totals.energyWh.saved, verifyCost, avgQuality: totals.qualityScore },
    quality,
    levers,
    // the baseline levers reconcile exactly to the headline gross figure; the additional
    // ones are reported on their own line so nothing is ever double-counted into it.
    leverTotals: {
      baselineSavedUsd: baselineLevers.reduce((s, l) => s + l.savedUsd, 0),
      additionalSavedUsd: additionalLevers.reduce((s, l) => s + l.savedUsd, 0)
    },
    series,
    net: {
      grossSaved, verifyCost, subscriptionMonthly: subMonthly, subscriptionToDate,
      netAfterFees: grossSaved - verifyCost - subscriptionToDate,
      avgMonthlySaving: grossSaved / months,
      netMonthly: (grossSaved - verifyCost - subscriptionToDate) / months,
      paybackMonths: (subMonthly > 0 && monthlyNetBeforeSub > 0) ? subMonthly / monthlyNetBeforeSub : null,
      worthIt: subMonthly > 0 ? (grossSaved - verifyCost) > subscriptionToDate : null
    },
    // energy/carbon are MODELLED from token counts, not metered from hardware.
    methodology: { cost: "measured", energy: "estimated", carbon: "estimated" }
  });
});

// ---- runtime configuration (masked; secret-free) ----------------------------
// A MASKED, secret-free view of the effective config plus per-field provenance.
// Secrets are reported only as booleans + last-4; the raw values never leave here.
function maskedConfig() {
  const key = config.upstreamApiKey;
  const fields = ["dryRun", "routingEnabled", "modelSmall", "modelLarge", "upstreamBaseUrl", "gridZone", "upstreamApiKey", "emToken"];
  const sources = {};
  for (const f of fields) sources[f] = config.sourceOf(f);
  return {
    dryRun: config.dryRun,
    routingEnabled: config.routingEnabled,
    modelSmall: config.modelSmall,
    modelLarge: config.modelLarge,
    upstreamBaseUrl: config.upstreamBaseUrl,
    gridZone: config.gridZone,
    hasUpstreamKey: Boolean(key),
    upstreamKeyLast4: key ? key.slice(-4) : null,
    hasEmToken: Boolean(config.emToken),
    sources
  };
}

// Per-field validators. Each returns the value to apply, or throws a safe message.
// Only these keys are accepted; anything else is rejected as an unknown field.
const strField = (v, name) => {
  if (typeof v !== "string" || !v.trim() || v.length > 120) throw name + " must be a non-empty string";
  return v.trim();
};
const boolField = (v, name) => {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "false") return v === "true";
  throw name + " must be a boolean";
};
const CONFIG_FIELDS = {
  upstreamApiKey: (v) => { if (typeof v !== "string") throw "upstreamApiKey must be a string"; return v.trim(); },
  emToken: (v) => { if (typeof v !== "string") throw "emToken must be a string"; return v.trim(); },
  upstreamBaseUrl: (v) => {
    if (typeof v !== "string") throw "upstreamBaseUrl must be a string";
    let u; try { u = new URL(v.trim()); } catch { throw "upstreamBaseUrl must be a valid URL"; }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw "upstreamBaseUrl must be http(s)";
    return v.trim();
  },
  modelSmall: (v) => strField(v, "modelSmall"),
  modelLarge: (v) => strField(v, "modelLarge"),
  gridZone: (v) => {
    if (typeof v !== "string" || !/^[A-Za-z0-9-]{1,20}$/.test(v)) throw "gridZone must be short alphanumeric/hyphen";
    return v;
  },
  routingEnabled: (v) => boolField(v, "routingEnabled"),
  dryRun: (v) => boolField(v, "dryRun")
};

app.get("/api/config", (_req, res) => res.json(maskedConfig()));

app.post("/api/config", (req, res) => {
  const body = req.body || {};
  const keys = Object.keys(body);
  const unknown = keys.filter((k) => !CONFIG_FIELDS[k]);
  if (unknown.length) return res.status(400).json({ error: { message: "unknown field(s): " + unknown.join(", ") } });
  // MULTI-TENANT SAFETY: these are PROCESS-GLOBAL settings. A normal tenant must never
  // rewrite them for everyone — their provider key is per-workspace and goes through
  // /api/provider-key instead. OPERATORS of the deployment may edit them; the UI only
  // offers this form to operators, so no tenant is ever shown a save that must 403.
  if (config.auth.required && !req.isOperator) {
    const globalOnly = keys.filter((k) => ["upstreamApiKey", "emToken", "dryRun", "routingEnabled", "modelSmall", "modelLarge", "upstreamBaseUrl", "gridZone"].includes(k));
    if (globalOnly.length) {
      return res.status(403).json({ error: { message: "These are deployment-wide settings and can only be changed by an operator of this deployment. Your own provider key is set under Provider connection.", type: "invalid_request_error", code: "global_config_forbidden" } });
    }
  }

  const toApply = {};
  try {
    for (const k of keys) {
      const val = CONFIG_FIELDS[k](body[k]);
      // Blank secret means "leave as is" — don't wipe an env-provided secret.
      if ((k === "upstreamApiKey" || k === "emToken") && val === "") continue;
      toApply[k] = val;
    }
  } catch (msg) {
    return res.status(400).json({ error: { message: String(msg) } });
  }

  config.setOverrides(toApply);
  // A new region/token means the cached grid intensity is stale.
  if ("gridZone" in toApply || "emToken" in toApply) invalidateIntensity();
  res.json(maskedConfig());
});

// ---- audit-style report (JSON or CSV) — respects the active filters ----
app.get("/api/report", (req, res) => {
  const tenant = req.tenant.id;
  const filter = { ...parseFilter(req.query), tenant }; // TENANT-SCOPED
  const pred = store.predicateFor(filter);
  const rows = store.all(tenant).filter(pred);
  const totals = store.aggregate(pred);
  const period = {
    from: rows[0]?.ts || null,
    to: rows[rows.length - 1]?.ts || null,
    requests: rows.length,
    filter
  };
  if (req.query.format === "csv") {
    res.set("content-type", "text/csv");
    res.set("content-disposition", 'attachment; filename="joule-report.csv"');
    return res.send(store.toCsv(pred));
  }
  // Branded, dated, filable PDF — built from the SAME totals as the JSON/CSV, so the
  // three formats can never disagree. Hand-rolled writer, no dependency.
  if (req.query.format === "pdf") {
    const minSamples = config.verify.minCalibrationN;
    const subMonthly = config.subscriptionCostMonthly;
    const days = (period.from && period.to)
      ? Math.max(1, Math.round((new Date(period.to) - new Date(period.from)) / 86400000) + 1) : 1;
    const subscriptionToDate = subMonthly > 0 ? subMonthly * (days / 30.4375) : 0;
    const buf = reportpdf.build({
      tenantName: (tenancy.getTenant(tenant) || {}).name || null,
      tenantId: tenant,
      period: { ...period, label: period.from ? `${String(period.from).slice(0, 10)} to ${String(period.to).slice(0, 10)} (${days} day${days === 1 ? "" : "s"})` : "no data in range" },
      totals,
      quality: { score: totals.qualityScore, verified: totals.verified, minSamples, sufficient: totals.verified >= minSamples },
      net: {
        subscriptionToDate,
        netAfterFees: totals.cost.saved - totals.verifyCost.costUsd - subscriptionToDate
      },
      latency: store.latencyStats(pred),
      generatedAt: Date.now()
    });
    res.set("content-type", "application/pdf");
    res.set("content-disposition", 'attachment; filename="joule-report.pdf"');
    return res.send(buf);
  }
  const q = verify.qualityStats(tenant);
  res.set("content-disposition", 'attachment; filename="joule-report.json"');
  res.json({
    report: "Joule — AI cost & emissions report",
    generatedAt: new Date().toISOString(),
    period,
    deployment: deploymentBlock(),  // mode, data/provider region, cross-border, retention, redaction
    cache: cacheBlock(totals),      // separate cache savings line (zero quality risk) + advisory
    batch: batchBlock(totals),      // batch-discount savings line (zero quality risk)
    reasoning: reasoningBlock(totals), // reasoning-token capping / downgrade savings line
    budget: budget.stats(tenant),   // limits, used, remaining, rejections (enforcement prevents overspend)
    methodology: {
      cost: "Exact: provider-returned token usage x configured per-model prices.",
      energy: "Estimated, DECODE-WEIGHTED: base[tier] + perKTokOut[tier] x (completion_tokens/1000) + perKTokIn[tier] x (prompt_tokens/1000), with perKTokIn an order of magnitude below perKTokOut. Measurement studies show inference energy is dominated by the decode phase — near-zero correlation with prompt length, scaling with tokens generated. Anchored to GPU characterisation (ML.ENERGY / Zeus / TokenPowerBench methodology) with IEA 'Energy & AI' for order-of-magnitude sanity. Configurable in src/config.js.",
      carbon: "energy(kWh) x grid carbon intensity (gCO2/kWh) from Electricity Maps, aligned to GHG Protocol Scope 2 (location-based).",
      cache: "Cache savings are a SEPARATE line from routing and carry ZERO quality risk — prefix/exact caching makes the model recompute nothing, so output is byte-identical. Prefix-cache savings are computed from the provider's REAL returned usage (cached vs cache-creation input tokens) and reported NET of the cache-write premium; a breakeven-reuse warning fires when the write premium would exceed read savings. (Semantic caching, which can return a different question's answer and is NOT risk-free, is a separate opt-in layer reported on its own line.)",
      verification: `Quality gating is CALIBRATED + CONFORMAL. A cheap per-request routing signal (router margin, no extra model call) is mapped to a probability of acceptability by isotonic regression (calibration set n=${q.calibration.n}, ECE=${q.calibration.ece == null ? "n/a" : q.calibration.ece.toFixed(3)}); a distribution-free conformal threshold bounds the probability of unacceptable degradation by alpha=${q.conformal.alpha}. The bound is MARGINAL (population-level), NOT a per-query guarantee, and distribution shift can violate it — always read n and alpha with any figure. Labels come from a SAMPLED (${Math.round(q.sampleRate * 100)}%) reference re-run + judge PANEL (${q.judgeModels.join(", ")}) with randomised answer order and agreement reporting; the judge is fallible and only LABELS calibration data, it does not gate live traffic. Below MIN_CALIBRATION_N=${q.calibration.minN} no guarantee is stated. Verification spends real tokens; net = routing savings − that overhead. References: ML.ENERGY/Zeus/TokenPowerBench (energy), FrugalGPT → Hybrid LLM (ICLR 2024) → conformal risk control (gating).`,
      standardsAlignment: ["GHG Protocol Scope 2 (location-based)", "SCI — Software Carbon Intensity (ISO/IEC 21031)"]
    },
    verification: {
      mode: q.mode,
      guaranteeReady: q.guaranteeReady,
      sampled: true,
      sampleRate: q.sampleRate,
      judgeModels: q.judgeModels,
      lowAgreementCount: q.lowAgreementCount,
      calibration: q.calibration,               // {n, ready, minN, ece}
      conformal: q.conformal,                   // {alpha, threshold, coverage, riskBound, n, ready}
      drift: q.drift,
      safetyMode: q.safetyMode,
      verified: totals.verified,
      qualityScore: totals.qualityScore,        // null until >=1 verified sample
      overhead: q.overhead,
      net: totals.net
    },
    totals
  });
});

// Prometheus / OpenTelemetry-compatible metrics (dep-free, always on) from the real log.
app.get("/metrics", (_req, res) => {
  res.set("content-type", "text/plain; version=0.0.4");
  res.send(otel.metricsText(store.aggregate(), store.perModel(), budget.stats()));
});

// Health signal with per-component status. The process staying up is the top-level `ok`;
// components report degraded/fallback without failing the check (degraded != down).
app.get("/api/health", async (_req, res) => {
  const db = store.health();
  const prov = config.dryRun ? { status: "dry_run" } : (config.upstreamApiKey ? upstream.providerHealth() : { status: "no_key" });
  let grid = { status: "unknown" };
  try { const g = await getIntensity(); grid = { status: g.live ? "live" : "fallback", source: g.source }; } catch { grid = { status: "fallback" }; }
  res.json({
    ok: true, version: "0.1.0", dryRun: config.dryRun, otel: otel.status(),
    components: {
      db: { backend: db.backend, status: db.status, pendingWrites: db.pendingWrites || 0 },
      provider: prov,
      grid
    }
  });
});

// Only listen when run directly (`npm start`). When required as a module (tests),
// export the app so it can be mounted on an ephemeral port — behaviour is identical.
if (require.main === module) {
  // wait for the durable store to finish loading (postgres) before accepting traffic
  storeReady.then(() => app.listen(config.port, () => {
    console.log(`\n  Joule proxy → http://localhost:${config.port} [store: ${store.backend()}]`);
    console.log(`  dashboard   → http://localhost:${config.port}/`);
    console.log(`  point clients at baseURL http://localhost:${config.port}/v1`);
    console.log(`  mode: ${config.dryRun ? "DRY_RUN (no external calls)" : "LIVE"} | routing: ${config.routingEnabled ? "on" : "off"} | grid zone: ${config.gridZone}\n`);
  }));
}

module.exports = app;
