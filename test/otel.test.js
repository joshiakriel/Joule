"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const otel = require("../src/otel");

const rec = {
  ts: new Date().toISOString(), latencyMs: 120, model: "gpt-4o-mini", tier: "small", mode: "dry_run",
  promptTokens: 10, completionTokens: 20, actual: { costUsd: 0.0001, energyWh: 0.05, carbonG: 0.02 }, saved: { costUsd: 0.001 },
  verification: { qualityScore: 0.9 }
};

test("OTLP span follows GenAI semantic conventions + joule.* attributes", () => {
  const p = otel.spanPayload(rec);
  const span = p.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.kind, 3, "CLIENT span");
  assert.match(span.name, /^chat /);
  const keys = span.attributes.map((a) => a.key);
  for (const k of ["gen_ai.system", "gen_ai.request.model", "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "joule.cost_usd", "joule.energy_wh", "joule.co2_g", "joule.quality_score", "joule.cache_hit", "joule.conformal_alpha"]) {
    assert.ok(keys.includes(k), "has " + k);
  }
  const inTok = span.attributes.find((a) => a.key === "gen_ai.usage.input_tokens");
  assert.equal(inTok.value.intValue, "10");
  assert.ok(/^\d+$/.test(span.startTimeUnixNano) && /^\d+$/.test(span.endTimeUnixNano), "unix-nano times");
});

test("session spans share a trace and nest under a per-session parent span", () => {
  const r = { ...rec, session: "agent-run-1" };
  const p = otel.spanPayload(r, true);
  const spans = p.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 2, "parent + child");
  const parent = spans.find((s) => s.name.startsWith("agent session"));
  const child = spans.find((s) => s.name.startsWith("chat"));
  assert.ok(parent && child);
  assert.equal(child.traceId, parent.traceId, "same trace");
  assert.equal(child.parentSpanId, parent.spanId, "child nests under the session parent");
});

test("Prometheus metricsText is valid exposition format with per-model labels", () => {
  const totals = {
    requests: 2, energyWh: { actual: 1.5 }, carbonG: { actual: 0.7 }, cost: { saved: 0.01 },
    cacheSavedUsd: 0.001, prefixCache: { netSavedUsd: 0.0002 }, semantic: { netSavedUsd: 0 }, verified: 1, qualityScore: 0.9
  };
  const perModel = [{ model: "gpt-4o-mini", tier: "small", calls: 1, tokens: 30, cost: 0.0001 }, { model: "gpt-4o", tier: "large", calls: 1, tokens: 40, cost: 0.0003 }];
  const text = otel.metricsText(totals, perModel, { rejected: 0 });
  assert.match(text, /# HELP joule_requests_total/);
  assert.match(text, /# TYPE joule_requests_total counter/);
  assert.match(text, /joule_requests_total\{model="gpt-4o-mini",tier="small"\} 1/);
  assert.match(text, /joule_energy_wh_total 1\.5/);
  assert.match(text, /joule_quality_score 0\.9/);
  // HELP/TYPE lines pair with sample lines
  assert.equal((text.match(/# TYPE /g) || []).length >= 6, true);
});

test("OTLP export is disabled by default (no endpoint)", () => {
  assert.equal(otel.enabled(), false);
  assert.doesNotThrow(() => otel.emit(rec)); // no-op, never throws
});
