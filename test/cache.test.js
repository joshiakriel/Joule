"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { prefixCacheSavings } = require("../src/metrics");
const cacheadvice = require("../src/cacheadvice");
const config = require("../src/config");

test("prefixCacheSavings: cached input tokens save read cost, net of write premium", () => {
  const p = config.pricing[config.modelLarge];
  const r = prefixCacheSavings({ model: config.modelLarge, tier: "large", cachedInputTokens: 1000, writeInputTokens: 0 });
  const expectedRead = (1000 / 1e6) * p.in * (1 - config.cache.readMultiplier);
  assert.ok(Math.abs(r.savedUsd - expectedRead) < 1e-12);
  assert.equal(r.writePremiumUsd, 0, "no premium with writeMultiplier 1.0 default");
  assert.ok(Math.abs(r.netSavedUsd - expectedRead) < 1e-12);
});

test("prefixCacheSavings is honest: net can be negative when write premium exceeds read saving", () => {
  // simulate Anthropic-ish economics: cheap reads, premium writes
  const saved = config.cache.readMultiplier, savedW = config.cache.writeMultiplier;
  config.cache.readMultiplier = 0.1; config.cache.writeMultiplier = 1.25;
  const r = prefixCacheSavings({ model: config.modelLarge, tier: "large", cachedInputTokens: 100, writeInputTokens: 10000 });
  assert.ok(r.writePremiumUsd > 0);
  assert.ok(r.netSavedUsd < 0, "writing a big prefix that's barely reused is a net loss — reported honestly");
  config.cache.readMultiplier = saved; config.cache.writeMultiplier = savedW; // restore
});

test("analyzePrompt flags cache-hostile structure (variable content at the front)", () => {
  assert.equal(cacheadvice.analyzePrompt("summarise this ticket").hostile, false);
  assert.equal(cacheadvice.analyzePrompt("5f8a1c2e-1111-2222-3333-444455556666 then summarise").hostile, true);
  assert.equal(cacheadvice.analyzePrompt("at 2026-07-25T10:00 please summarise").hostile, true);
  assert.equal(cacheadvice.analyzePrompt("request id 123456789 summarise").hostile, true);
});

test("breakevenHitRate is 0 with no write premium and positive with one", () => {
  assert.equal(cacheadvice.breakevenHitRate(0.5, 1.0), 0);
  const be = cacheadvice.breakevenHitRate(0.1, 1.25); // 0.25 / (0.25 + 0.9)
  assert.ok(be > 0.2 && be < 0.25);
});

test("advisory() produces quantified before/after findings with a $ estimate", () => {
  const recs = [
    { cacheHostile: true, promptTokens: 2000, model: "gpt-4o", prefixCache: null },
    { cacheHostile: true, promptTokens: 2000, model: "gpt-4o" },
    { cacheHostile: false, promptTokens: 2000, model: "gpt-4o-mini" }
  ];
  const a = cacheadvice.advisory(recs);
  assert.equal(a.requests, 3);
  const f = a.findings.find((x) => x.pattern === "dynamic-content-before-static");
  assert.equal(f.count, 2, "counts the hostile requests");
  assert.equal(f.currentHitRate, 0);
  assert.ok(f.estimatedHitRate > 0 && f.estSavingUsd > 0, "before/after + $ impact");
  assert.match(f.method, /estimate/i);
  assert.equal(cacheadvice.advisory([]).requests, 0, "empty state");
});
