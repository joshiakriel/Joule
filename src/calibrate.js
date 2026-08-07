"use strict";
const fs = require("fs");
const path = require("path");
const config = require("./config");

/**
 * Isotonic regression via Pool-Adjacent-Violators (PAV) — maps a raw uncertainty
 * signal to a CALIBRATED probability that the small answer is acceptable. Plain JS,
 * NO ML dependency. Persisted so calibration survives restarts.
 *
 * PER-TENANT (Phase 1.1): each tenant has its OWN calibration set — one tenant's
 * quality signal never mixes into another's guarantee. `for(tenantId)` returns a
 * calibrator bound to that tenant; the flat top-level API operates on the default
 * tenant (backward-compatible with the single-tenant tests/paths).
 */
const DEFAULT_TENANT = config.auth.defaultTenantId;
let DATA_DIR = path.join(__dirname, "..", "data");
const FILE = () => path.join(DATA_DIR, "calibration.json");

const states = new Map(); // tenantId -> { points, knots, sinceRefit }
function stateFor(tid) {
  const id = tid || DEFAULT_TENANT;
  if (!states.has(id)) states.set(id, { points: [], knots: [], sinceRefit: 0 });
  return states.get(id);
}

function setDir(dir) { if (dir) DATA_DIR = dir; }
function reset() { states.clear(); }

// ---- persistence: all tenants in one file, keyed by tenant ----
function load() {
  try {
    if (fs.existsSync(FILE())) {
      const j = JSON.parse(fs.readFileSync(FILE(), "utf8"));
      const byT = j.byTenant || (j.points ? { [DEFAULT_TENANT]: { points: j.points, knots: j.knots } } : {}); // migrate old flat file
      for (const [tid, v] of Object.entries(byT)) states.set(tid, { points: Array.isArray(v.points) ? v.points : [], knots: Array.isArray(v.knots) ? v.knots : [], sinceRefit: 0 });
    }
  } catch { /* start empty */ }
}
function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const byTenant = {};
    for (const [tid, st] of states) byTenant[tid] = { points: st.points, knots: st.knots };
    fs.writeFileSync(FILE(), JSON.stringify({ byTenant }));
  } catch { /* ignore disk errors */ }
}

// Pool-Adjacent-Violators: least-squares non-decreasing fit of y over x-sorted points.
function pav(pts) {
  const s = pts.slice().sort((a, b) => a.x - b.x);
  const blocks = [];
  for (const p of s) {
    blocks.push({ x: p.x, sumY: p.y, w: 1, y: p.y });
    while (blocks.length > 1 && blocks[blocks.length - 2].y > blocks[blocks.length - 1].y) {
      const B = blocks.pop(), A = blocks.pop();
      const w = A.w + B.w, sumY = A.sumY + B.sumY;
      blocks.push({ x: A.x, sumY, w, y: sumY / w });
    }
  }
  return blocks.map((b) => ({ x: b.x, y: b.y }));
}

function fitState(st) { st.knots = st.points.length ? pav(st.points.map((p) => ({ x: p.raw, y: p.label }))) : []; st.sinceRefit = 0; return st.knots; }

function predictState(st, raw) {
  if (!st.knots.length) return null;
  let y = st.knots[0].y;
  for (const k of st.knots) { if (raw >= k.x) y = k.y; else break; }
  return Math.max(0, Math.min(1, y));
}

function addState(st, raw, label) {
  st.points.push({ raw, label: label ? 1 : 0, ts: Date.now() });
  if (++st.sinceRefit >= (config.verify.calibrationRefitEvery || 200)) { fitState(st); persist(); }
}

function eceState(st, bins = 10) {
  if (!st.points.length || !st.knots.length) return null;
  const b = Array.from({ length: bins }, () => ({ n: 0, conf: 0, acc: 0 }));
  for (const p of st.points) {
    const pr = predictState(st, p.raw); if (pr == null) continue;
    const idx = Math.min(bins - 1, Math.floor(pr * bins));
    b[idx].n++; b[idx].conf += pr; b[idx].acc += p.label;
  }
  let e = 0; const N = st.points.length;
  for (const bin of b) if (bin.n) e += (bin.n / N) * Math.abs(bin.acc / bin.n - bin.conf / bin.n);
  return e;
}
function calibrationPointsState(st) { return st.points.map((p) => ({ p: predictState(st, p.raw), label: p.label })).filter((x) => x.p != null); }
function rawStatsState(st) {
  if (!st.points.length) return { n: 0, mean: 0, std: 0 };
  const n = st.points.length, mean = st.points.reduce((s, p) => s + p.raw, 0) / n;
  const std = Math.sqrt(st.points.reduce((s, p) => s + (p.raw - mean) ** 2, 0) / n);
  return { n, mean, std };
}

// A calibrator bound to one tenant.
function forTenant(tid) {
  const st = stateFor(tid);
  return {
    fit: () => fitState(st),
    predict: (raw) => predictState(st, raw),
    add: (raw, label) => addState(st, raw, label),
    size: () => st.points.length,
    ready: (minN) => st.points.length >= (minN != null ? minN : (config.verify.minCalibrationN || 50)) && st.knots.length > 0,
    ece: (bins) => eceState(st, bins),
    calibrationPoints: () => calibrationPointsState(st),
    rawStats: () => rawStatsState(st),
    reset: () => { st.points = []; st.knots = []; st.sinceRefit = 0; },
    _points: () => st.points, _knots: () => st.knots
  };
}

// flat (default-tenant) API — backward compatible
const d = () => forTenant(DEFAULT_TENANT);
module.exports = {
  setDir, load, persist, reset, for: forTenant,
  fit: () => d().fit(), predict: (r) => d().predict(r), add: (r, l) => d().add(r, l),
  size: () => d().size(), ready: (m) => d().ready(m), ece: (b) => d().ece(b),
  calibrationPoints: () => d().calibrationPoints(), rawStats: () => d().rawStats(),
  _points: () => d()._points(), _knots: () => d()._knots()
};
