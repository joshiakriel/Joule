"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const conformal = require("../src/conformal");

// tiny deterministic LCG so the test is stable offline
function lcg(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

test("empty calibration -> not ready, routes nothing small", () => {
  const r = conformal.compute([], 0.05);
  assert.equal(r.ready, false);
  assert.equal(r.threshold, 1.01);
});

test("all-acceptable calibration certifies at alpha with coverage 1", () => {
  const pts = Array.from({ length: 100 }, () => ({ p: 0.9, label: 1 }));
  const r = conformal.compute(pts, 0.05);
  assert.equal(r.ready, true);
  assert.ok(r.threshold <= 0.9);
  assert.equal(r.coverage, 1);
  assert.ok(r.riskBound <= 0.05, "risk bound within alpha");
});

test("empirical coverage on a held-out split lands within a band of (1 - alpha)", () => {
  const alpha = 0.1;
  const rnd = lcg(42);
  // generate (p, label) where acceptance probability increases with p
  const data = [];
  for (let i = 0; i < 1000; i++) {
    const p = rnd();
    const label = rnd() < p ? 1 : 0; // higher calibrated p => more likely acceptable
    data.push({ p, label });
  }
  const cal = data.slice(0, 500), hold = data.slice(500);
  const { threshold, ready } = conformal.compute(cal, alpha);
  assert.equal(ready, true, "threshold computed");
  const cov = conformal.coverageAt(hold, threshold);
  assert.ok(cov != null, "some held-out points routed small");
  // marginal guarantee: held-out acceptance among routed-small should be >= ~1-alpha
  assert.ok(cov >= (1 - alpha) - 0.08, `held-out coverage ${cov.toFixed(3)} within band of ${1 - alpha}`);
  assert.ok(cov <= 1);
});

test("threshold rises when low-p answers are unacceptable (excludes the risky region)", () => {
  const pts = [];
  for (let i = 0; i < 200; i++) pts.push({ p: 0.2, label: 0 }); // risky, unacceptable
  for (let i = 0; i < 200; i++) pts.push({ p: 0.95, label: 1 }); // safe, acceptable
  const r = conformal.compute(pts, 0.05);
  assert.equal(r.ready, true);
  assert.ok(r.threshold > 0.2, "does not route the risky low-p region small");
  assert.equal(r.coverage, 1);
});
