"use strict";
const config = require("./config");

/**
 * Given the ACTUAL token usage returned by the provider, compute:
 *   - cost (USD)      — exact, from token usage x your configured prices
 *   - energy (Wh)     — estimated, from the transparent per-tier energy model
 *   - carbon (gCO2)   — energy x live grid intensity
 * and the BASELINE (what the same request would have cost/emitted if it had
 * always gone to the large model) so we can report verifiable savings.
 */

function energyWh(tier, totalTokens) {
  const e = config.energy[tier] || config.energy.large;
  return e.baseWh + e.perKTokWh * (totalTokens / 1000);
}

function costUsd(model, tier, promptTokens, completionTokens) {
  const p = config.priceFor(model, tier);
  return (promptTokens / 1e6) * p.in + (completionTokens / 1e6) * p.out;
}

function compute({ model, tier, promptTokens, completionTokens, gPerKwh, cached }) {
  const totalTokens = promptTokens + completionTokens;

  // Actual (routed) request
  const actual = cached
    ? { costUsd: 0, energyWh: 0.001, carbonG: 0 } // cache hit ≈ free
    : {
        costUsd: costUsd(model, tier, promptTokens, completionTokens),
        energyWh: energyWh(tier, totalTokens),
        carbonG: (energyWh(tier, totalTokens) / 1000) * gPerKwh
      };

  // Baseline: same tokens, but always the large model / large tier
  const bWh = energyWh("large", totalTokens);
  const baseline = {
    costUsd: costUsd(config.modelLarge, "large", promptTokens, completionTokens),
    energyWh: bWh,
    carbonG: (bWh / 1000) * gPerKwh
  };

  const saved = {
    costUsd: Math.max(0, baseline.costUsd - actual.costUsd),
    energyWh: Math.max(0, baseline.energyWh - actual.energyWh),
    carbonG: Math.max(0, baseline.carbonG - actual.carbonG)
  };

  return { actual, baseline, saved, totalTokens };
}

module.exports = { compute };
