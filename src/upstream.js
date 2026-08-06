"use strict";
const config = require("./config");

/**
 * Resilient upstream (model provider) boundary — the PRIMARY path.
 *
 * Every live call goes through here: a hard per-attempt timeout, exponential-backoff
 * retries on TRANSIENT failures only (HTTP 429, 5xx, or a network/timeout error), an
 * optional fallback model, and finally a clean OpenAI-shaped error. Other 4xx (client)
 * errors are returned immediately — retrying or failing over won't help them.
 *
 * Returns a discriminated result (never throws for an expected provider failure) so the
 * caller can always produce a correct response-or-clean-error and release its reservation:
 *   success  -> { ok:true,  status, data,  modelUsed, attempts }
 *   json fail-> { ok:false, status, error, modelUsed, attempts }        (error is OpenAI-shaped)
 *   stream   -> { ok:true,  status, response, modelUsed, attempts }     (raw Response to pipe)
 *
 * `fetch` is injectable for deterministic, offline fault-injection tests.
 */
let fetchImpl = (...a) => global.fetch(...a);
function setFetch(fn) { fetchImpl = fn || ((...a) => global.fetch(...a)); }

// ---- provider health (surfaced by /api/health; never triggers a live probe) ----
let health = { calls: 0, consecutiveFailures: 0, lastStatus: null, lastOkAt: null, lastErrorAt: null };
function resetHealth() { health = { calls: 0, consecutiveFailures: 0, lastStatus: null, lastOkAt: null, lastErrorAt: null }; }
function mark(ok, status) {
  health.calls++; health.lastStatus = status;
  if (ok) { health.consecutiveFailures = 0; health.lastOkAt = Date.now(); }
  else { health.consecutiveFailures++; health.lastErrorAt = Date.now(); }
}
function providerHealth() {
  const status = health.calls === 0 ? "unknown" : (health.consecutiveFailures === 0 ? "ok" : "degraded");
  return { status, calls: health.calls, consecutiveFailures: health.consecutiveFailures, lastStatus: health.lastStatus, lastOkAt: health.lastOkAt, lastErrorAt: health.lastErrorAt };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isTransient = (status) => status === 429 || (status >= 500 && status <= 599); // + network errors (status 0)
function backoffMs(attempt) {
  const base = config.upstream.retryBaseMs * Math.pow(2, attempt); // attempt: 0,1,2,...
  return config.upstream.retryJitter ? Math.round(base * (0.5 + Math.random())) : base;
}
function cleanError(status, message) {
  const type = (!status || status >= 500) ? "upstream_error" : "invalid_request_error";
  return { error: { message: String(message || "upstream request failed"), type, code: status || null } };
}

// one network attempt; throws only on network/timeout (caller treats as transient)
async function attempt(bodyObj, stream, timeoutMs) {
  return fetchImpl(config.upstreamBaseUrl + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + config.upstreamApiKey },
    body: JSON.stringify(bodyObj),
    signal: AbortSignal.timeout(timeoutMs || config.upstream.timeoutMs)
  });
}

// Try one model with up to maxRetries extra attempts. `doAttempt(model)` resolves to
// { ok, status, value } or throws (network/timeout => transient). Retries transient only.
async function runModel(model, buildBody, stream, timeoutMs) {
  const maxRetries = Math.max(0, config.upstream.maxRetries);
  let last = { ok: false, status: 0, value: null };
  for (let i = 0; i <= maxRetries; i++) {
    if (i > 0) await sleep(backoffMs(i - 1));
    try {
      const resp = await attempt(buildBody(model), stream, timeoutMs);
      if (resp.ok) return { ok: true, status: resp.status, value: resp };
      const data = await resp.json().catch(() => cleanError(resp.status, "upstream error " + resp.status));
      last = { ok: false, status: resp.status, value: data };
      if (!isTransient(resp.status)) return last;                    // client 4xx — do not retry
      console.warn(`[upstream] transient ${resp.status} on ${model} (attempt ${i + 1}/${maxRetries + 1}) — retrying`);
    } catch (err) {                                                  // network / timeout
      last = { ok: false, status: 0, value: cleanError(0, "provider unreachable: " + scrub(err)) };
      console.warn(`[upstream] network error on ${model} (attempt ${i + 1}/${maxRetries + 1}): ${err && err.message}`);
    }
  }
  return last;
}

const scrub = (err) => String(err && err.message ? err.message : err).replace(/Bearer\s+\S+/gi, "Bearer ***");

// models to try: primary, then the configured fallback (if different)
function modelChain(primary) {
  const chain = [primary];
  const fb = config.upstream.fallbackModel;
  if (fb && fb !== primary) chain.push(fb);
  return chain;
}

// Shared driver across the model chain. Returns the first ok result; on a non-transient
// (client) failure returns immediately (no failover); otherwise tries the fallback model.
async function drive(primary, buildBody, stream, timeoutMs) {
  const chain = modelChain(primary);
  let result, attempts = 0, modelUsed = primary;
  for (const model of chain) {
    modelUsed = model; attempts++;
    result = await runModel(model, buildBody, stream, timeoutMs);
    if (result.ok) { mark(true, result.status); return { ...result, modelUsed, attempts }; }
    if (result.status && !isTransient(result.status)) { mark(false, result.status); return { ...result, modelUsed, attempts }; }
    if (chain.length > 1 && model !== chain[chain.length - 1]) console.warn(`[upstream] ${model} exhausted — falling back to ${config.upstream.fallbackModel}`);
  }
  mark(false, result.status || 0);
  return { ...result, modelUsed, attempts };
}

// Non-streaming: returns parsed JSON on success, else a clean OpenAI-shaped error.
async function callJson({ model, buildBody, timeoutMs }) {
  const r = await drive(model, buildBody, false, timeoutMs);
  if (r.ok) {
    const data = await r.value.json().catch(() => null);
    if (!data || !data.choices) return { ok: false, status: 502, error: cleanError(502, "malformed provider response").error, modelUsed: r.modelUsed, attempts: r.attempts };
    return { ok: true, status: r.status, data, modelUsed: r.modelUsed, attempts: r.attempts };
  }
  const error = (r.value && r.value.error) ? r.value.error : cleanError(r.status, "upstream request failed").error;
  return { ok: false, status: r.status || 502, error, modelUsed: r.modelUsed, attempts: r.attempts };
}

// Streaming: returns the raw Response to pipe on success, else a clean error. Retries/
// fallback apply to the INITIAL connection only — once bytes flow we can't safely retry.
async function openStream({ model, buildBody, timeoutMs }) {
  const r = await drive(model, buildBody, true, timeoutMs);
  if (r.ok) return { ok: true, status: r.status, response: r.value, modelUsed: r.modelUsed, attempts: r.attempts };
  const error = (r.value && r.value.error) ? r.value.error : cleanError(r.status, "upstream request failed").error;
  return { ok: false, status: r.status || 502, error, modelUsed: r.modelUsed, attempts: r.attempts };
}

module.exports = { callJson, openStream, providerHealth, resetHealth, setFetch, isTransient, _health: () => health };
