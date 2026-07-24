"use strict";
const fs = require("fs");
const path = require("path");
const config = require("./config");

/**
 * Isotonic regression via Pool-Adjacent-Violators (PAV) — maps a raw uncertainty
 * signal to a CALIBRATED probability that the small answer is acceptable. Raw
 * signals are weak used directly but near-optimal after a monotone fit. Plain JS,
 * NO ML dependency. Persisted so calibration survives restarts.
 */

let DATA_DIR = path.join(__dirname, "..", "data");
const FILE = () => path.join(DATA_DIR, "calibration.json");

let points = [];   // { raw, label(0|1), ts }
let knots = [];     // fitted step function, sorted by x: [{x, y}]
let sinceRefit = 0;

function setDir(dir) { if (dir) DATA_DIR = dir; }
function reset() { points = []; knots = []; sinceRefit = 0; }

function load() {
  try {
    if (fs.existsSync(FILE())) {
      const j = JSON.parse(fs.readFileSync(FILE(), "utf8"));
      points = Array.isArray(j.points) ? j.points : [];
      knots = Array.isArray(j.knots) ? j.knots : [];
    }
  } catch { /* start empty */ }
}
function persist() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify({ points, knots })); } catch { /* ignore disk errors */ }
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
      blocks.push({ x: A.x, sumY, w, y: sumY / w }); // pooled mean; block keeps the lowest x
    }
  }
  return blocks.map((b) => ({ x: b.x, y: b.y }));
}

function fit() { knots = points.length ? pav(points.map((p) => ({ x: p.raw, y: p.label }))) : []; sinceRefit = 0; return knots; }

// Right-continuous step prediction, clamped to [0,1]. null until fitted.
function predict(raw) {
  if (!knots.length) return null;
  let y = knots[0].y;
  for (const k of knots) { if (raw >= k.x) y = k.y; else break; }
  return Math.max(0, Math.min(1, y));
}

function add(raw, label) {
  points.push({ raw, label: label ? 1 : 0, ts: Date.now() });
  if (++sinceRefit >= (config.verify.calibrationRefitEvery || 200)) { fit(); persist(); }
}

const size = () => points.length;
const ready = (minN) => points.length >= (minN != null ? minN : (config.verify.minCalibrationN || 50)) && knots.length > 0;

// Expected Calibration Error over `bins` equal-width bins of predicted probability.
function ece(bins = 10) {
  if (!points.length || !knots.length) return null;
  const b = Array.from({ length: bins }, () => ({ n: 0, conf: 0, acc: 0 }));
  for (const p of points) {
    const pr = predict(p.raw); if (pr == null) continue;
    const idx = Math.min(bins - 1, Math.floor(pr * bins));
    b[idx].n++; b[idx].conf += pr; b[idx].acc += p.label;
  }
  let e = 0; const N = points.length;
  for (const bin of b) if (bin.n) e += (bin.n / N) * Math.abs(bin.acc / bin.n - bin.conf / bin.n);
  return e;
}

// Calibrated (p, label) pairs — input to conformal threshold + coverage.
function calibrationPoints() {
  return points.map((p) => ({ p: predict(p.raw), label: p.label })).filter((x) => x.p != null);
}

// Raw-signal distribution (for drift comparison).
function rawStats() {
  if (!points.length) return { n: 0, mean: 0, std: 0 };
  const n = points.length, mean = points.reduce((s, p) => s + p.raw, 0) / n;
  const std = Math.sqrt(points.reduce((s, p) => s + (p.raw - mean) ** 2, 0) / n);
  return { n, mean, std };
}

module.exports = {
  setDir, load, persist, reset, fit, predict, add, size, ready, ece,
  calibrationPoints, rawStats, _points: () => points, _knots: () => knots
};
