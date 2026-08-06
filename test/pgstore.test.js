"use strict";
// Persistence + reconciliation tests for the Postgres store backend.
//
//  A) OFFLINE (always runs): drives store.js's "postgres" branch through a faithful
//     in-process fake of the durable layer (same semantics as pgstore: snapshot-at-add,
//     ON CONFLICT DO NOTHING, seq order, verification reattached on load). Proves that
//     records SURVIVE A RESTART (new load from the durable store) and that the reloaded
//     aggregate reconciles exactly with a direct read of the durable rows.
//
//  B) REAL DB (opt-in): set DATABASE_URL and STORE_PG_TEST=1 to run the same flow against
//     a real Postgres via the real pgstore. Double opt-in + a truncate mean you MUST point
//     it at a throwaway/test database, never production. Skips unless both are set.
process.env.DRY_RUN = "true";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const store = require("../src/store");
const config = require("../src/config");
const pgstore = require("../src/pgstore");

function makeRec({ id, tier = "small", cached = false, tokens = 100, actEnergy = 1, baseEnergy = 4, mode, model, session = null, ts } = {}) {
  const actCost = 0.001, baseCost = 0.01;
  return {
    id, ts: ts || new Date().toISOString(), mode: mode || (cached ? "cache" : "dry_run"), cached,
    model: model || (tier === "small" ? "gpt-4o-mini" : "gpt-4o"), tier, session, latencyMs: 10,
    promptTokens: tokens / 2, completionTokens: tokens / 2, totalTokens: tokens,
    actual: { costUsd: actCost, energyWh: actEnergy, carbonG: actEnergy * 0.45 },
    baseline: { costUsd: baseCost, energyWh: baseEnergy, carbonG: baseEnergy * 0.45 },
    saved: { costUsd: baseCost - actCost, energyWh: baseEnergy - actEnergy, carbonG: (baseEnergy - actEnergy) * 0.45 },
    grid: { zone: "AE", gPerKwh: 450, source: "fallback (test)" }
  };
}

// ---- A) offline fake durable backend (mirrors pgstore's observable semantics) ----
function makeFakeDurable() {
  const rows = []; // simulates the `records` table
  let seq = 0;
  const create = () => ({
    async ensureSchema() {},
    async load() {
      return rows.slice().sort((a, b) => a.seq - b.seq).map((r) => {
        const rec = JSON.parse(r.data);
        if (r.verification != null) rec.verification = JSON.parse(r.verification);
        return rec;
      });
    },
    persistAdd(rec, payload) { // snapshot payload captured by store.add(); ON CONFLICT DO NOTHING
      if (rows.some((r) => r.id === rec.id)) return;
      rows.push({ seq: seq++, id: rec.id, ts: rec.ts, tier: rec.tier, mode: rec.mode, model: rec.model, session: rec.session || null, cached: rec.cached === true, data: payload, verification: null });
    },
    persistVerification(id, vjson) { const r = rows.find((x) => x.id === id); if (r) r.verification = vjson; },
    persistClear() { rows.length = 0; seq = 0; },
    flush() { return Promise.resolve(); },
    close() { return Promise.resolve(); },
    isDegraded() { return false; }
  });
  return { rows, create };
}

test("postgres backend: records persist across a restart and reconcile with the durable rows", async () => {
  const fake = makeFakeDurable();
  const origCreate = pgstore.create;
  const origBackend = config.store.backend;
  pgstore.create = fake.create;          // inject the fake durable layer
  config.store.backend = "postgres";
  try {
    // ---- first "process": write a small+large request and a verification ----
    store.init(); await store.ready();
    assert.equal(store.backend(), "postgres");
    assert.equal(store.all().length, 0, "starts empty");

    const r1 = store.add(makeRec({ id: "r1", tier: "small", tokens: 100, actEnergy: 1, baseEnergy: 4 }));
    store.add(makeRec({ id: "r2", tier: "large", tokens: 200, actEnergy: 2, baseEnergy: 6 }));
    store.addVerification(r1.id, { qualityScore: 0.9, verifyCost: { tokens: 50, costUsd: 0.002, energyWh: 1.5, carbonG: 0.6 } });
    await store.flush(); // durable writes settle off the serving path

    const beforeRestart = store.aggregate();
    assert.equal(beforeRestart.requests, 2);
    assert.equal(beforeRestart.verified, 1);

    // ---- "restart": brand-new in-memory state, reload purely from the durable store ----
    store.init(); await store.ready();
    const afterRestart = store.aggregate();

    // persistence: the data survived the restart
    assert.equal(afterRestart.requests, 2, "both records reloaded after restart");
    assert.equal(afterRestart.verified, 1, "verification reloaded after restart");
    assert.equal(store.all().find((r) => r.id === "r1").verification.qualityScore, 0.9);

    // reconciliation: reloaded aggregate == pre-restart aggregate == direct durable-row read
    assert.equal(afterRestart.requests, beforeRestart.requests);
    assert.ok(Math.abs(afterRestart.cost.saved - beforeRestart.cost.saved) < 1e-12);
    assert.ok(Math.abs(afterRestart.energyWh.actual - beforeRestart.energyWh.actual) < 1e-12);

    const direct = fake.rows.reduce((s, r) => { const d = JSON.parse(r.data); s.n++; s.tokens += d.totalTokens; s.cost += d.actual.costUsd; return s; }, { n: 0, tokens: 0, cost: 0 });
    assert.equal(direct.n, afterRestart.requests, "row count matches aggregate");
    assert.equal(direct.tokens, afterRestart.tokens, "token sum matches aggregate");
    assert.ok(Math.abs(direct.cost - afterRestart.cost.actual) < 1e-12, "cost sum matches aggregate");

    // clear wipes memory AND the durable rows
    const removed = store.clear();
    assert.equal(removed, 2);
    await store.flush();
    assert.equal(fake.rows.length, 0, "durable rows truncated");
    store.init(); await store.ready();
    assert.equal(store.aggregate().requests, 0, "empty after clear + restart");
  } finally {
    pgstore.create = origCreate;
    config.store.backend = origBackend;
    store.init(); // restore the default (memory) backend for other suites
  }
});

test("postgres backend: a durable-write outage never throws into the caller path", async () => {
  const origCreate = pgstore.create;
  const origBackend = config.store.backend;
  // a durable layer whose writes reject — store.add must still return synchronously
  pgstore.create = () => ({
    async ensureSchema() {}, async load() { return []; },
    persistAdd() { throw new Error("db down"); },
    persistVerification() { throw new Error("db down"); },
    persistClear() { throw new Error("db down"); },
    flush() { return Promise.resolve(); }, close() { return Promise.resolve(); }, isDegraded() { return true; }
  });
  config.store.backend = "postgres";
  try {
    store.init(); await store.ready();
    const rec = store.add(makeRec({ id: "x1" })); // must not throw
    assert.equal(rec.id, "x1");
    assert.equal(store.aggregate().requests, 1, "response path still sees the record in memory");
  } finally {
    pgstore.create = origCreate;
    config.store.backend = origBackend;
    store.init();
  }
});

// ---- B) real Postgres (opt-in; needs a throwaway DB) ----
const REAL = process.env.DATABASE_URL && process.env.STORE_PG_TEST === "1";
test("real Postgres: persistence + reconciliation against a live database", { skip: REAL ? false : "set DATABASE_URL and STORE_PG_TEST=1 (throwaway DB — this truncates `records`)" }, async () => {
  const origBackend = config.store.backend;
  config.store.backend = "postgres";
  try {
    store.init(); await store.ready();
    store.clear(); await store.flush();

    store.add(makeRec({ id: "pg1", tier: "small", tokens: 100, actEnergy: 1, baseEnergy: 4 }));
    const r2 = store.add(makeRec({ id: "pg2", tier: "large", tokens: 200, actEnergy: 2, baseEnergy: 6 }));
    store.addVerification(r2.id, { qualityScore: 0.8, verifyCost: { tokens: 40, costUsd: 0.001, energyWh: 1, carbonG: 0.4 } });
    await store.flush();

    // reconnect: fresh pool + reload from the real table
    await store.close();
    store.init(); await store.ready();
    const agg = store.aggregate();
    assert.equal(agg.requests, 2, "records persisted across reconnect");
    assert.equal(agg.verified, 1);

    // reconciliation: aggregate() (== /api/stats) vs a direct COUNT/SUM on the table
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: config.store.databaseUrl, ssl: config.store.ssl });
    const { rows } = await pool.query("SELECT count(*)::int n, coalesce(sum((data->'actual'->>'costUsd')::numeric),0) cost FROM records");
    await pool.end();
    assert.equal(rows[0].n, agg.requests, "direct table count == aggregate");
    assert.ok(Math.abs(Number(rows[0].cost) - agg.cost.actual) < 1e-9, "direct cost sum == aggregate");
  } finally {
    config.store.backend = origBackend;
    await store.close().catch(() => {});
    store.init();
  }
});
