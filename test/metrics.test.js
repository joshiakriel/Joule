"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { compute } = require("../src/metrics");
const config = require("../src/config");

const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

// Energy model: base[tier] + perKTok[tier] * (totalTokens / 1000)
const energyWh = (tier, tokens) => {
  const e = config.energy[tier];
  return e.baseWh + e.perKTokWh * (tokens / 1000);
};

test("cost is exact for known tokens x configured prices (small tier)", () => {
  const m = compute({ model: "gpt-4o-mini", tier: "small", promptTokens: 1000, completionTokens: 1000, gPerKwh: 450, cached: false });
  const p = config.pricing["gpt-4o-mini"];
  approx(m.actual.costUsd, (1000 / 1e6) * p.in + (1000 / 1e6) * p.out);
});

test("energy follows base + perKTok*(tokens/1000) and carbon = energy/1000 * intensity", () => {
  const gPerKwh = 450;
  const m = compute({ model: "gpt-4o-mini", tier: "small", promptTokens: 500, completionTokens: 1500, gPerKwh, cached: false });
  const expectedWh = energyWh("small", 2000);
  approx(m.actual.energyWh, expectedWh);
  approx(m.actual.carbonG, (expectedWh / 1000) * gPerKwh);
  assert.equal(m.totalTokens, 2000);
});

test("baseline always uses the large tier / large model", () => {
  const gPerKwh = 300;
  const m = compute({ model: "gpt-4o-mini", tier: "small", promptTokens: 1000, completionTokens: 1000, gPerKwh, cached: false });
  const bp = config.pricing[config.modelLarge];
  approx(m.baseline.costUsd, (1000 / 1e6) * bp.in + (1000 / 1e6) * bp.out);
  approx(m.baseline.energyWh, energyWh("large", 2000));
  approx(m.baseline.carbonG, (energyWh("large", 2000) / 1000) * gPerKwh);
});

test("saved = max(0, baseline - actual) for a small-routed request (positive)", () => {
  const m = compute({ model: "gpt-4o-mini", tier: "small", promptTokens: 1000, completionTokens: 1000, gPerKwh: 450, cached: false });
  approx(m.saved.costUsd, m.baseline.costUsd - m.actual.costUsd);
  approx(m.saved.energyWh, m.baseline.energyWh - m.actual.energyWh);
  approx(m.saved.carbonG, m.baseline.carbonG - m.actual.carbonG);
  assert.ok(m.saved.energyWh > 0, "small routing should save energy vs large baseline");
});

test("a correctly large-routed request yields ~0 saved", () => {
  const m = compute({ model: config.modelLarge, tier: "large", promptTokens: 1000, completionTokens: 1000, gPerKwh: 450, cached: false });
  approx(m.saved.costUsd, 0);
  approx(m.saved.energyWh, 0);
  approx(m.saved.carbonG, 0);
});

test("saved is clamped at 0, never negative", () => {
  const m = compute({ model: config.modelLarge, tier: "large", promptTokens: 10, completionTokens: 10, gPerKwh: 450, cached: false });
  assert.ok(m.saved.costUsd >= 0 && m.saved.energyWh >= 0 && m.saved.carbonG >= 0);
});

test("cache hit is metered as effectively free", () => {
  const m = compute({ model: "gpt-4o-mini", tier: "small", promptTokens: 1000, completionTokens: 1000, gPerKwh: 450, cached: true });
  assert.equal(m.actual.costUsd, 0);
  assert.equal(m.actual.carbonG, 0);
  assert.ok(m.saved.carbonG > 0, "cache still shows savings vs large baseline");
});
