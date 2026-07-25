"use strict";
const config = require("./config");

/**
 * OpenTelemetry GenAI interop WITHOUT the OTel SDK (minimal-deps rule).
 *
 * - `/metrics` (Prometheus text) is always available and derived from the real log.
 * - OTLP/HTTP JSON span export is opt-in (OTEL_ENABLED + OTEL_EXPORTER_OTLP_ENDPOINT):
 *   each request emits a span following the GenAI semantic conventions
 *   (gen_ai.request.model, gen_ai.usage.input_tokens, …) plus joule.* cost/energy/
 *   carbon/quality attributes. Spans are hand-built JSON POSTed with fetch, off the
 *   serving path. No endpoint => no-op.
 */

const providerSystem = () => { try { return new URL(config.upstreamBaseUrl).host; } catch { return "unknown"; } };
const hex = (n) => { let s = ""; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16); return s; };
const enabled = () => config.otel.enabled && Boolean(config.otel.endpoint);

// Deterministic hex id from a string (so all calls in a session share a trace + parent span).
function hashHex(str, len) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  let s = (h >>> 0).toString(16);
  while (s.length < len) s = (Math.imul(h, s.length + 7) >>> 0).toString(16) + s;
  return s.slice(0, len);
}
const emittedParents = new Set();     // sessions we've already emitted a parent span for
function reset() { emittedParents.clear(); }

const kv = (key, value) => ({ key, value });
const sVal = (s) => ({ stringValue: String(s) });
const iVal = (n) => ({ intValue: String(Math.round(n)) });
const dVal = (n) => ({ doubleValue: Number(n) });

// Build an OTLP/HTTP JSON traces payload for one logged record (GenAI conventions).
// When the record has a session, spans share a deterministic trace id and hang off a
// per-session PARENT span; `includeParent` emits that parent span alongside the child.
function spanPayload(rec, includeParent) {
  const startNano = String(BigInt(new Date(rec.ts).getTime() - (rec.latencyMs || 0)) * 1000000n);
  const endNano = String(BigInt(new Date(rec.ts).getTime()) * 1000000n);
  const traceId = rec.session ? hashHex("trace:" + rec.session, 32) : hex(32);
  const parentSpanId = rec.session ? hashHex("span:" + rec.session, 16) : null;
  const cacheHit = rec.mode === "cache" || rec.mode === "semantic_cache";
  const attrs = [
    kv("gen_ai.system", sVal(providerSystem())),
    kv("gen_ai.operation.name", sVal("chat")),
    kv("gen_ai.request.model", sVal(rec.model)),
    kv("gen_ai.response.model", sVal(rec.model)),
    kv("gen_ai.usage.input_tokens", iVal(rec.promptTokens || 0)),
    kv("gen_ai.usage.output_tokens", iVal(rec.completionTokens || 0)),
    // joule.* — our differentiating attributes, alongside the standard without polluting it
    kv("joule.tier", sVal(rec.tier)),
    kv("joule.mode", sVal(rec.mode)),
    kv("joule.cost_usd", dVal(rec.actual.costUsd)),
    kv("joule.energy_wh", dVal(rec.actual.energyWh)),
    kv("joule.co2_g", dVal(rec.actual.carbonG)),
    kv("joule.saved_usd", dVal(rec.saved.costUsd)),
    kv("joule.cache_hit", sVal(String(cacheHit))),
    kv("joule.conformal_alpha", dVal(config.verify.targetRiskAlpha))
  ];
  if (rec.session) attrs.push(kv("joule.session", sVal(rec.session)));
  if (rec.verification) attrs.push(kv("joule.quality_score", dVal(rec.verification.qualityScore)));
  if (rec.reasoning) attrs.push(kv("joule.reasoning_tokens", iVal(rec.reasoning.reasoningTokens || 0)));
  const spans = [{
    traceId, spanId: hex(16), parentSpanId: parentSpanId || undefined,
    name: "chat " + rec.model, kind: 3, // CLIENT
    startTimeUnixNano: startNano, endTimeUnixNano: endNano, attributes: attrs
  }];
  // per-session PARENT span (agent run), emitted once, so child calls nest under it
  if (includeParent && rec.session) {
    spans.unshift({
      traceId, spanId: parentSpanId, name: "agent session " + rec.session, kind: 1, // INTERNAL
      startTimeUnixNano: startNano, endTimeUnixNano: endNano,
      attributes: [kv("joule.session", sVal(rec.session)), kv("gen_ai.operation.name", sVal("agent"))]
    });
  }
  return { resourceSpans: [{ resource: { attributes: [kv("service.name", sVal(config.otel.serviceName))] }, scopeSpans: [{ scope: { name: "joule", version: "0.1.0" }, spans }] }] };
}

// Fire-and-forget span export (off the serving path). No-op unless configured. Emits
// a per-session parent span the first time a session is seen (agent run -> child calls).
function emit(rec) {
  if (!enabled() || !rec) return;
  let includeParent = false;
  if (rec.session && !emittedParents.has(rec.session)) { emittedParents.add(rec.session); includeParent = true; }
  fetch(config.otel.endpoint + "/v1/traces", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(spanPayload(rec, includeParent)), signal: AbortSignal.timeout(5000)
  }).catch((err) => console.error("[otel] export error:", err.message));
}

// Prometheus exposition text, derived from the real aggregates (dep-free, always on).
const esc = (s) => String(s).replace(/[\\"\n]/g, (c) => ({ "\\": "\\\\", '"': '\\"', "\n": "\\n" }[c]));
function metricsText(totals, perModel, budgetStats) {
  const L = [];
  const block = (name, help, type, samples) => { L.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples); };
  const perM = (name, val) => perModel.map((m) => `${name}{model="${esc(m.model)}",tier="${m.tier}"} ${val(m)}`);
  block("joule_requests_total", "Metered requests", "counter", perM("joule_requests_total", (m) => m.calls));
  block("joule_tokens_total", "Total tokens", "counter", perM("joule_tokens_total", (m) => m.tokens));
  block("joule_cost_usd_total", "Actual cost (USD)", "counter", perM("joule_cost_usd_total", (m) => m.cost.toFixed(6)));
  block("joule_energy_wh_total", "Estimated energy (Wh)", "counter", [`joule_energy_wh_total ${totals.energyWh.actual.toFixed(4)}`]);
  block("joule_co2_grams_total", "Estimated carbon (gCO2)", "counter", [`joule_co2_grams_total ${totals.carbonG.actual.toFixed(4)}`]);
  block("joule_cost_saved_usd_total", "Routing cost saved (USD)", "counter", [`joule_cost_saved_usd_total ${totals.cost.saved.toFixed(6)}`]);
  block("joule_cache_saved_usd_total", "Cache cost saved, net (USD)", "counter", [`joule_cache_saved_usd_total ${(totals.cacheSavedUsd + totals.prefixCache.netSavedUsd + totals.semantic.netSavedUsd).toFixed(6)}`]);
  block("joule_verified_total", "Verified quality samples", "counter", [`joule_verified_total ${totals.verified}`]);
  if (totals.qualityScore != null) block("joule_quality_score", "Avg verified quality (0-1)", "gauge", [`joule_quality_score ${totals.qualityScore.toFixed(4)}`]);
  if (budgetStats) block("joule_budget_rejected_total", "Requests blocked by budget enforcement", "counter", [`joule_budget_rejected_total ${budgetStats.rejected}`]);
  return L.join("\n") + "\n";
}

function status() { return { metricsEndpoint: "/metrics", otlpExport: enabled(), endpoint: enabled() ? config.otel.endpoint : null, serviceName: config.otel.serviceName }; }

module.exports = { enabled, emit, spanPayload, metricsText, status, providerSystem, reset };
