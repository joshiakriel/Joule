"use strict";
// Provider-boundary unit tests: timeout, retry/backoff on transient failures only,
// fallback model, and clean errors — all with an INJECTED fetch (offline, deterministic).
process.env.DRY_RUN = "true";
const { test, before, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const upstream = require("../src/upstream");
const config = require("../src/config");

const okBody = { choices: [{ index: 0, message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
const resp = (status, body, isStream) => ({ ok: status >= 200 && status < 300, status, json: async () => body, body: isStream ? { getReader: () => ({}) } : null });
const buildBody = (m) => ({ model: m, messages: [] });

let savedUpstream;
before(() => { savedUpstream = { ...config.upstream }; config.setOverrides({ upstreamApiKey: "sk-test", upstreamBaseUrl: "http://provider.test" }); });
after(() => { Object.assign(config.upstream, savedUpstream); config.clearOverrides(); upstream.setFetch(null); upstream.resetHealth(); });
beforeEach(() => {
  config.upstream.retryBaseMs = 1; config.upstream.retryJitter = false; config.upstream.maxRetries = 2; config.upstream.fallbackModel = "";
  upstream.resetHealth();
});

test("retries a transient 500 then succeeds", async () => {
  let calls = 0;
  upstream.setFetch(async () => { calls++; return calls < 3 ? resp(500, { error: { message: "boom" } }) : resp(200, okBody); });
  const r = await upstream.callJson({ model: "m", buildBody });
  assert.equal(r.ok, true);
  assert.equal(calls, 3, "two retries then success (3 attempts total)");
  assert.ok(r.data.choices, "returns the provider JSON");
  assert.equal(upstream.providerHealth().status, "ok");
});

test("does NOT retry a client 4xx (400) — returns immediately", async () => {
  let calls = 0;
  upstream.setFetch(async () => { calls++; return resp(400, { error: { message: "bad request" } }); });
  const r = await upstream.callJson({ model: "m", buildBody });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(calls, 1, "client errors are not retried");
  assert.match(r.error.message, /bad request/, "provider's own error body is passed through");
});

test("retries a 429 (rate limit) — treated as transient", async () => {
  let calls = 0;
  upstream.setFetch(async () => { calls++; return calls < 2 ? resp(429, { error: { message: "slow down" } }) : resp(200, okBody); });
  const r = await upstream.callJson({ model: "m", buildBody });
  assert.equal(r.ok, true);
  assert.equal(calls, 2);
});

test("network error / timeout is transient, then a clean upstream error after exhaustion", async () => {
  let calls = 0;
  upstream.setFetch(async () => { calls++; throw Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }); });
  const r = await upstream.callJson({ model: "m", buildBody });
  assert.equal(r.ok, false);
  assert.equal(calls, 3, "1 attempt + 2 retries");
  assert.equal(r.status, 502, "clean synthesized status");
  assert.equal(r.error.type, "upstream_error");
  assert.equal(upstream.providerHealth().status, "degraded");
  assert.equal(upstream.providerHealth().consecutiveFailures, 1);
});

test("falls back to FALLBACK_MODEL after the primary exhausts transient failures", async () => {
  config.upstream.fallbackModel = "backup-model";
  const seen = [];
  upstream.setFetch(async (_url, opts) => {
    const m = JSON.parse(opts.body).model; seen.push(m);
    return m === "backup-model" ? resp(200, okBody) : resp(503, { error: { message: "down" } });
  });
  const r = await upstream.callJson({ model: "primary", buildBody });
  assert.equal(r.ok, true);
  assert.equal(r.modelUsed, "backup-model", "served by the fallback model");
  assert.equal(seen.filter((m) => m === "primary").length, 3, "primary tried 3x before failover");
  assert.ok(seen.includes("backup-model"));
});

test("openStream returns the raw response to pipe on success; clean error on failure", async () => {
  upstream.setFetch(async () => resp(200, {}, true));
  const ok = await upstream.openStream({ model: "m", buildBody });
  assert.equal(ok.ok, true);
  assert.ok(ok.response && ok.response.body, "raw response returned for piping");

  upstream.setFetch(async () => resp(500, { error: { message: "down" } }));
  const bad = await upstream.openStream({ model: "m", buildBody });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 500);
  assert.ok(bad.error.message);
});

test("a malformed provider 200 (no choices) is treated as a failure, not passed through", async () => {
  upstream.setFetch(async () => resp(200, { not: "an openai body" }));
  const r = await upstream.callJson({ model: "m", buildBody });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
});
