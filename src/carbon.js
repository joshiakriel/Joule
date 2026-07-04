"use strict";
const config = require("./config");

/**
 * Live grid carbon intensity (gCO2/kWh) from the Electricity Maps free API.
 * Cached briefly so we don't hammer the API. Falls back to a labelled constant
 * whenever the token is missing or the API is unreachable — so carbon numbers
 * always render, and we're always honest about the source.
 */
let cache = { value: null, ts: 0 };

// Drop the cached intensity so the next call re-resolves — used when the grid
// zone or EM token changes at runtime (POST /api/config).
function invalidate() { cache = { value: null, ts: 0 }; }

async function getIntensity() {
  const now = Date.now();
  if (cache.value && now - cache.ts < 1000 * 60 * 10) return cache.value;

  const fallback = {
    gPerKwh: config.fallbackIntensity,
    zone: config.gridZone,
    source: "fallback (set ELECTRICITYMAPS_TOKEN for live data)",
    updatedAt: new Date().toISOString(),
    live: false
  };

  if (!config.emToken) {
    cache = { value: fallback, ts: now };
    return fallback;
  }

  try {
    const url = `https://api.electricitymap.org/v3/carbon-intensity/latest?zone=${encodeURIComponent(config.gridZone)}`;
    const res = await fetch(url, { headers: { "auth-token": config.emToken }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`EM ${res.status}`);
    const data = await res.json();
    const val = {
      gPerKwh: Number(data.carbonIntensity),
      zone: data.zone || config.gridZone,
      source: "Electricity Maps (live)",
      updatedAt: data.datetime || new Date().toISOString(),
      live: true
    };
    if (!Number.isFinite(val.gPerKwh)) throw new Error("no intensity in response");
    cache = { value: val, ts: now };
    return val;
  } catch (err) {
    const fb = { ...fallback, source: `fallback (Electricity Maps error: ${err.message})` };
    cache = { value: fb, ts: now };
    return fb;
  }
}

module.exports = { getIntensity, invalidate };
