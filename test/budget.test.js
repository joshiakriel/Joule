"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config");
const budget = require("../src/budget");

beforeEach(() => { budget.reset(); config.budget.enforce = false; config.budget.globalUsd = 0; config.budget.dailyUsd = 0; config.budget.sessionUsd = 0; });

test("metering-only mode never blocks but flags would-be breaches", () => {
  config.budget.sessionUsd = 0.001; config.budget.enforce = false;
  const r = budget.reserve({ sessionId: "s1", estCostUsd: 0.01 }); // over cap
  assert.equal(r.ok, true, "not blocked when enforcement is off");
  assert.equal(r.wouldReject, true, "but flagged");
  assert.equal(budget.stats().wouldReject, 1);
  assert.equal(budget.stats().rejected, 0);
});

test("enforcement rejects a reservation that would exceed the per-session cap", () => {
  config.budget.sessionUsd = 0.002; config.budget.enforce = true;
  const first = budget.reserve({ sessionId: "s1", estCostUsd: 0.0015 });
  assert.equal(first.ok, true);
  budget.commit(first, 0.0015);
  const second = budget.reserve({ sessionId: "s1", estCostUsd: 0.001 }); // 0.0015 + 0.001 > 0.002
  assert.equal(second.ok, false, "blocked");
  assert.equal(second.detail.scope, "session");
  assert.equal(budget.stats().rejected, 1);
  // a different session is unaffected
  assert.equal(budget.reserve({ sessionId: "s2", estCostUsd: 0.001 }).ok, true);
});

test("hierarchical: global + daily caps both enforced", () => {
  config.budget.enforce = true; config.budget.globalUsd = 0.003; config.budget.dailyUsd = 0.002;
  const a = budget.reserve({ estCostUsd: 0.0015 }); budget.commit(a, 0.0015);
  const b = budget.reserve({ estCostUsd: 0.001 }); // daily 0.0015+0.001>0.002 -> block on daily
  assert.equal(b.ok, false);
  assert.equal(b.detail.scope, "day");
});

test("reservation reconciles to actual on commit; release frees it", () => {
  config.budget.enforce = true; config.budget.globalUsd = 0.01;
  const r = budget.reserve({ estCostUsd: 0.005 });      // reserve big estimate
  assert.ok(budget.stats().reserved.global > 0);
  budget.commit(r, 0.001);                               // actual much smaller
  assert.ok(Math.abs(budget.stats().used.global - 0.001) < 1e-9, "committed actual, not estimate");
  assert.ok(budget.stats().reserved.global < 1e-9, "reservation cleared");
  const r2 = budget.reserve({ estCostUsd: 0.002 });
  budget.release(r2);
  assert.ok(budget.stats().reserved.global < 1e-9, "released reservation frees budget");
});

test("per-request X-Joule-Max-Cost cap rejects an over-limit single request", () => {
  config.budget.enforce = true;
  const r = budget.reserve({ estCostUsd: 0.01, maxCostUsd: 0.005 });
  assert.equal(r.ok, false);
  assert.equal(r.detail.scope, "request");
});

test("init seeds committed spend from existing records", () => {
  budget.init([
    { ts: new Date().toISOString(), actual: { costUsd: 0.003 }, session: "s1" },
    { ts: new Date().toISOString(), actual: { costUsd: 0.002 }, session: "s2" }
  ]);
  assert.ok(Math.abs(budget.stats().used.global - 0.005) < 1e-9);
});
