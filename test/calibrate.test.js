"use strict";
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const calibrate = require("../src/calibrate");

let tmpDir;
before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "joule-cal-")); calibrate.setDir(tmpDir); });
after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });
beforeEach(() => { fs.rmSync(path.join(tmpDir, "calibration.json"), { force: true }); calibrate.reset(); });

test("predict is null before a fit, then non-decreasing (isotonic/PAV)", () => {
  assert.equal(calibrate.predict(0.5), null, "null until fitted");
  // higher raw signal => more likely acceptable
  for (let i = 0; i < 100; i++) { const raw = i / 100; calibrate.add(raw, raw > 0.5 ? 1 : 0); }
  calibrate.fit();
  let prev = -1;
  for (let x = 0; x <= 1.0001; x += 0.05) {
    const y = calibrate.predict(x);
    assert.ok(y >= 0 && y <= 1);
    assert.ok(y >= prev - 1e-9, "monotone non-decreasing");
    prev = y;
  }
  assert.ok(calibrate.predict(0.1) < calibrate.predict(0.9), "low signal < high signal");
});

test("ece is a fraction in [0,1] once fitted", () => {
  for (let i = 0; i < 60; i++) { const raw = i / 60; calibrate.add(raw, raw > 0.4 ? 1 : 0); }
  calibrate.fit();
  const e = calibrate.ece();
  assert.ok(e >= 0 && e <= 1);
});

test("calibration persists and reloads across a reset", () => {
  for (let i = 0; i < 30; i++) calibrate.add(i / 30, i % 2);
  calibrate.fit(); calibrate.persist();
  assert.equal(calibrate.size(), 30);
  calibrate.reset();
  assert.equal(calibrate.size(), 0);
  calibrate.load();
  assert.equal(calibrate.size(), 30, "points reloaded from disk");
  assert.ok(calibrate.predict(0.9) != null, "fitted knots reloaded");
});

test("ready() requires MIN_CALIBRATION_N points and a fit", () => {
  for (let i = 0; i < 10; i++) calibrate.add(0.9, 1); // fewer than default minN (50)
  calibrate.fit();
  assert.equal(calibrate.ready(), false);
});
