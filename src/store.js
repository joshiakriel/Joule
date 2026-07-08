"use strict";
const fs = require("fs");
const path = require("path");

/**
 * Simple, dependency-free append-only log (JSONL on disk + in-memory mirror).
 * Great for an MVP and a single node. For multi-instance production, swap this
 * module for Postgres/ClickHouse — the interface stays the same.
 *
 * All filtering + aggregation lives here so the server and the tests share ONE
 * implementation. `predicateFor()` turns a {range,tier,mode,q} filter into a
 * record predicate; `aggregate/perModel/series/sessions/toCsv/summary` all accept
 * that predicate and operate on the real logged records — never mocked data.
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

// Truly empty the store — in memory AND on disk. Destructive; used by the
// dashboard's "clear session data" action. Returns how many records were removed.
function clear() {
  const removed = records.length;
  records = [];
  try { fs.writeFileSync(LOG_FILE, ""); } catch (e) { /* ignore disk errors in MVP */ }
  return removed;
}

// ---- filtering ------------------------------------------------------------
const RANGE_MS = { "1h": 3600e3, "24h": 86400e3, "7d": 604800e3 };
// Cutoff timestamp (ms) for a named range, or null for "all"/unknown.
function rangeCutoff(range, now = Date.now()) { return RANGE_MS[range] ? now - RANGE_MS[range] : null; }

// Build a record predicate from a filter. Time range, exact tier/mode, and a
// case-insensitive substring match on the model field — all against real fields.
function predicateFor(filter = {}, now = Date.now()) {
  const cutoff = rangeCutoff(filter.range, now);
  const tier = filter.tier || null;
  const mode = filter.mode || null;
  const needle = (filter.q || "").trim().toLowerCase();
  return (r) => {
    if (cutoff !== null && new Date(r.ts).getTime() < cutoff) return false;
    if (tier && r.tier !== tier) return false;
    if (mode && r.mode !== mode) return false;
    if (needle && !String(r.model || "").toLowerCase().includes(needle)) return false;
    return true;
  };
}

const select = (pred) => (pred ? records.filter(pred) : records);

// ---- aggregation ----------------------------------------------------------
// Sum a set of records into the totals shape used across the app.
function accumulate(rs) {
  const t = {
    requests: rs.length, cacheHits: 0, routedSmall: 0, routedLarge: 0, tokens: 0,
    cost: { actual: 0, baseline: 0, saved: 0 },
    energyWh: { actual: 0, baseline: 0, saved: 0 },
    carbonG: { actual: 0, baseline: 0, saved: 0 }
  };
  for (const r of rs) {
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

function aggregate(pred) { return accumulate(select(pred)); }

// Per-model breakdown straight from the log: calls, tokens, cost, energy,
// carbon, avg latency. Sorted by call count desc.
function perModel(pred) {
  const map = new Map();
  for (const r of select(pred)) {
    let m = map.get(r.model);
    if (!m) { m = { model: r.model, tier: r.tier, calls: 0, tokens: 0, cost: 0, energyWh: 0, carbonG: 0, latSum: 0, latN: 0 }; map.set(r.model, m); }
    m.calls++; m.tokens += r.totalTokens || 0;
    m.cost += r.actual.costUsd; m.energyWh += r.actual.energyWh; m.carbonG += r.actual.carbonG;
    if (typeof r.latencyMs === "number") { m.latSum += r.latencyMs; m.latN++; }
  }
  return [...map.values()]
    .map((m) => ({ model: m.model, tier: m.tier, calls: m.calls, tokens: m.tokens, cost: m.cost, energyWh: m.energyWh, carbonG: m.carbonG, avgLatencyMs: m.latN ? Math.round(m.latSum / m.latN) : null }))
    .sort((a, b) => b.calls - a.calls);
}

// Bucketed time-series over [from,to] for the dashboard charts.
function series(pred, opts = {}) {
  const rs = select(pred);
  const buckets = opts.buckets || 24;
  const from = opts.from != null ? opts.from : (rs.length ? new Date(rs[0].ts).getTime() : Date.now());
  let to = opts.to != null ? opts.to : (rs.length ? new Date(rs[rs.length - 1].ts).getTime() : Date.now());
  if (to <= from) to = from + 1;
  const width = (to - from) / buckets;
  const out = Array.from({ length: buckets }, (_, i) => ({ t: Math.round(from + i * width), calls: 0, energyActual: 0, energyBaseline: 0, carbonActual: 0, costActual: 0 }));
  for (const r of rs) {
    let idx = Math.floor((new Date(r.ts).getTime() - from) / width);
    if (idx < 0) idx = 0; if (idx >= buckets) idx = buckets - 1;
    const b = out[idx];
    b.calls++; b.energyActual += r.actual.energyWh; b.energyBaseline += r.baseline.energyWh;
    b.carbonActual += r.actual.carbonG; b.costActual += r.actual.costUsd;
  }
  return out;
}

// ---- sessions -------------------------------------------------------------
// Group requests into "runs". Real signal: a client-supplied X-Joule-Session
// header (stored on the record as `session`). Untagged requests are bucketed by
// time gaps so ad-hoc dashboard activity still groups sensibly.
const GAP_MS = 15 * 60 * 1000;

function summarizeSession(g) {
  const rs = g.recs;
  const a = accumulate(rs);
  const from = rs[0].ts, to = rs[rs.length - 1].ts;
  return {
    id: g.id, label: g.label, tagged: g.tagged,
    from, to, durationMs: new Date(to).getTime() - new Date(from).getTime(),
    calls: a.requests, small: a.routedSmall, large: a.routedLarge, cached: a.cacheHits,
    tokens: a.tokens, cost: a.cost, energyWh: a.energyWh, carbonG: a.carbonG, savedPct: a.savedPct
  };
}

function sessions(pred) {
  const rs = select(pred).slice().sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const groups = new Map();
  // tagged: group by the client-supplied session id
  for (const r of rs.filter((x) => x.session)) {
    const key = "s:" + r.session;
    if (!groups.has(key)) groups.set(key, { id: r.session, label: r.session, tagged: true, recs: [] });
    groups.get(key).recs.push(r);
  }
  // untagged: split by time gaps
  let bucket = 0, lastTs = null;
  for (const r of rs.filter((x) => !x.session)) {
    const ms = new Date(r.ts).getTime();
    if (lastTs === null || ms - lastTs > GAP_MS) bucket++;
    lastTs = ms;
    const key = "g:" + bucket;
    if (!groups.has(key)) groups.set(key, { id: "adhoc-" + bucket, label: "ad-hoc activity", tagged: false, recs: [] });
    groups.get(key).recs.push(r);
  }
  return [...groups.values()].map(summarizeSession).sort((a, b) => new Date(b.to) - new Date(a.to));
}

// One call that assembles everything the dashboard's filtered view needs.
function summary(filter = {}, now = Date.now()) {
  const pred = predicateFor(filter, now);
  const cutoff = rangeCutoff(filter.range, now);
  const filtered = records.filter(pred);
  const from = cutoff != null ? cutoff : (filtered.length ? new Date(filtered[0].ts).getTime() : now);
  return {
    filter,
    window: { from: new Date(from).toISOString(), to: new Date(now).toISOString() },
    totals: accumulate(filtered),
    series: series(pred, { from, to: now, buckets: 24 }),
    perModel: perModel(pred),
    sessions: sessions(pred),
    recent: filtered.slice(-25).reverse()
  };
}

function recent(n = 25) { return records.slice(-n).reverse(); }

const csvCell = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
function toCsv(pred) {
  const head = "timestamp,mode,model,tier,cached,prompt_tokens,completion_tokens,cost_usd,energy_wh,carbon_g,baseline_cost_usd,baseline_carbon_g,saved_cost_usd,saved_carbon_g,grid_zone,grid_gco2_per_kwh,grid_source,session";
  const rows = select(pred).map((r) =>
    [r.ts, r.mode, r.model, r.tier, r.cached ? 1 : 0, r.promptTokens, r.completionTokens,
     r.actual.costUsd.toFixed(6), r.actual.energyWh.toFixed(4), r.actual.carbonG.toFixed(4),
     r.baseline.costUsd.toFixed(6), r.baseline.carbonG.toFixed(4),
     r.saved.costUsd.toFixed(6), r.saved.carbonG.toFixed(4),
     r.grid.zone, r.grid.gPerKwh, csvCell(r.grid.source), csvCell(r.session || "")].join(","));
  return [head, ...rows].join("\n");
}

module.exports = {
  init, add, all, clear, recent, toCsv,
  aggregate, perModel, series, sessions, summary,
  predicateFor, rangeCutoff
};
