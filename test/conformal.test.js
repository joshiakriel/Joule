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

test("ADAPTIVE conformal re-converges after a distribution shift; a frozen static threshold goes stale", () => {
  const alpha = 0.1, target = 1 - alpha;
  const rnd = lcg(20260726);
  const aci = conformal.createAci({ alpha, gamma: 0.05, gammaDrift: 0.1, window: 300 });
  const preLabel = (p) => (p > 0.3 || rnd() < 0.5) ? 1 : 0;   // acceptable region p > 0.3
  const postLabel = (p) => (p > 0.7 || rnd() < 0.2) ? 1 : 0;  // SHIFT: region moves up to p > 0.7
  const pre = [];
  for (let i = 0; i < 500; i++) { const p = rnd(); const label = preLabel(p); pre.push({ p, label }); aci.update({ p, label }); }
  const staticTau = conformal.compute(pre, alpha).threshold; // FROZEN static threshold
  // unbiased post-shift eval set to measure the frozen static threshold's coverage
  const evalPost = []; for (let i = 0; i < 800; i++) { const p = rnd(); evalPost.push({ p, label: postLabel(p) }); }
  const staticCov = conformal.coverageAt(evalPost, staticTau);
  // ADAPTIVE observes only ROUTED-SMALL outcomes (p >= current threshold), as the real sampler does
  for (let i = 0; i < 2000; i++) { const p = rnd(); if (p >= aci.state().threshold) aci.update({ p, label: postLabel(p), drift: true }); }
  const adaptiveCov = aci.rollingCoverage();
  assert.ok(staticCov != null && adaptiveCov != null);
  assert.ok(staticCov < target - 0.05, `static coverage ${staticCov.toFixed(3)} degraded below target ${target} and stays there`);
  assert.ok(adaptiveCov > staticCov + 0.05, `adaptive ${adaptiveCov.toFixed(3)} beats static ${staticCov.toFixed(3)}`);
  assert.ok(adaptiveCov >= target - 0.1, `adaptive ${adaptiveCov.toFixed(3)} re-converged within band of target ${target}`);
  // drift boost raises the effective learning rate
  assert.equal(aci.state().driftBoosted, true);
});

test("adaptive alpha_t tightens after errors, relaxes after clean hits", () => {
  const aci = conformal.createAci({ alpha: 0.1, gamma: 0.05, window: 100 });
  for (let i = 0; i < 10; i++) aci.update({ p: 0.5, label: 0 }); // errors -> stricter
  const tightened = aci.state().alphaT;
  for (let i = 0; i < 30; i++) aci.update({ p: 0.5, label: 1 }); // clean -> relax
  assert.ok(tightened < 0.1, "alpha_t dropped below target after errors (stricter)");
  assert.ok(aci.state().alphaT > tightened, "alpha_t relaxed after clean hits");
});
