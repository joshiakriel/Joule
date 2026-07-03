"use strict";
const fs = require("fs");
const path = require("path");

/**
 * Simple, dependency-free append-only log (JSONL on disk + in-memory mirror).
 * Great for an MVP and a single node. For multi-instance production, swap this
 * module for Postgres/ClickHouse — the interface stays the same.
 */
let DATA_DIR = path.join(__dirname, "..", "data");
let LOG_FILE = path.join(DATA_DIR, "log.jsonl");

let records = [];

// init() with no args uses the default ../data dir (production). Pass an explicit
// dir to point the store at an isolated location — used by the test suite so runs
// don't pollute data/log.jsonl. Re-initialising starts from a clean in-memory set.
function init(dir) {
  if (dir) { DATA_DIR = dir; LOG_FILE = path.join(DATA_DIR, "log.jsonl"); }
  records = [];
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE)) {
      records = fs
        .readFileSync(LOG_FILE, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    }
  } catch (e) {
    console.error("store init error:", e.message);
  }
}

function add(rec) {
  records.push(rec);
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + "\n"); } catch (e) { /* ignore disk errors in MVP */ }
}

function all() { return records; }

function aggregate() {
  const t = {
    requests: records.length,
    cacheHits: 0,
    routedSmall: 0,
    routedLarge: 0,
    tokens: 0,
    cost: { actual: 0, baseline: 0, saved: 0 },
    energyWh: { actual: 0, baseline: 0, saved: 0 },
    carbonG: { actual: 0, baseline: 0, saved: 0 }
  };
  for (const r of records) {
    if (r.cached) t.cacheHits++;
    if (r.tier === "small") t.routedSmall++; else t.routedLarge++;
    t.tokens += r.totalTokens || 0;
    t.cost.actual += r.actual.costUsd; t.cost.baseline += r.baseline.costUsd; t.cost.saved += r.saved.costUsd;
    t.energyWh.actual += r.actual.energyWh; t.energyWh.baseline += r.baseline.energyWh; t.energyWh.saved += r.saved.energyWh;
    t.carbonG.actual += r.actual.carbonG; t.carbonG.baseline += r.baseline.carbonG; t.carbonG.saved += r.saved.carbonG;
  }
  t.savedPct = t.energyWh.baseline > 0 ? Math.round((1 - t.energyWh.actual / t.energyWh.baseline) * 100) : 0;
  return t;
}

function recent(n = 25) { return records.slice(-n).reverse(); }

function toCsv() {
  const head = "timestamp,mode,model,tier,cached,prompt_tokens,completion_tokens,cost_usd,energy_wh,carbon_g,baseline_cost_usd,baseline_carbon_g,saved_cost_usd,saved_carbon_g,grid_zone,grid_gco2_per_kwh,grid_source";
  const rows = records.map((r) =>
    [r.ts, r.mode, r.model, r.tier, r.cached ? 1 : 0, r.promptTokens, r.completionTokens,
     r.actual.costUsd.toFixed(6), r.actual.energyWh.toFixed(4), r.actual.carbonG.toFixed(4),
     r.baseline.costUsd.toFixed(6), r.baseline.carbonG.toFixed(4),
     r.saved.costUsd.toFixed(6), r.saved.carbonG.toFixed(4),
     r.grid.zone, r.grid.gPerKwh, `"${r.grid.source}"`].join(","));
  return [head, ...rows].join("\n");
}

module.exports = { init, add, all, aggregate, recent, toCsv };
