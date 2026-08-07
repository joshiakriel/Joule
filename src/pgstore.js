"use strict";
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const config = require("./config");

/**
 * Durable Postgres backing for store.js. This module NEVER computes aggregates —
 * store.js keeps the in-memory record mirror and runs all the same JS aggregation
 * either way, so the numbers reconcile exactly with the JSONL backend. Here we only
 * persist writes and load the log back on boot.
 *
 * Resilience (Phase 0.3):
 *  - Writes are serialized (submission order preserved) and run OFF the serving path.
 *  - A DB outage never throws into the caller. Failed writes BUFFER in memory (bounded)
 *    and REPLAY in order when the DB recovers, so the table reconciles with the mirror
 *    once the DB is back. Reads never hit the DB (the mirror does), so the dashboard is
 *    unaffected by an outage.
 *  - Pool acquire + statement timeouts mean pool exhaustion fails fast, never hangs.
 *  - Secrets (connection string, credentials) are never logged.
 *
 * `_pool` may be injected for deterministic, offline fault-injection tests.
 */
function create({ databaseUrl, ssl, poolMax = 5, connectTimeoutMs = 5000, statementTimeoutMs = 8000, maxBufferedWrites = 10000, _pool } = {}) {
  const pool = _pool || new Pool({
    connectionString: databaseUrl, ssl, max: poolMax,
    connectionTimeoutMillis: connectTimeoutMs,   // wait for a pooled connection, then fail (no hang)
    idleTimeoutMillis: 30000,
    statement_timeout: statementTimeoutMs        // server-side per-statement cap
  });
  let queue = Promise.resolve(); // serialize durable writes, preserve order
  let degraded = false;
  const pending = [];            // ops buffered during an outage: { sql, params, label }
  let dropped = 0;

  const logErr = (op, e) => console.error(`store(postgres) ${op} error:`, e && e.message ? e.message : String(e));
  pool.on("error", (e) => { degraded = true; logErr("pool", e); }); // idle-client error must not crash

  const tsOrNull = (ts) => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

  async function ensureSchema() {
    const dir = path.join(__dirname, "..", "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) await pool.query(fs.readFileSync(path.join(dir, f), "utf8"));
  }

  async function load() {
    // read every tenant's rows for the in-memory mirror via the SECURITY DEFINER reader
    // (bypasses RLS for the boot load only; per-request writes remain RLS-checked).
    const { rows } = await pool.query("SELECT data, verification FROM app_load_records()");
    return rows.map((r) => { const rec = r.data; if (r.verification != null) rec.verification = r.verification; return rec; });
  }

  // Run a write. If it carries a tenant, do it inside a transaction that sets
  // app.current_tenant so Row-Level Security authorises exactly that tenant's row.
  async function runOp(op) {
    if (!op.tenant) return void (await pool.query(op.sql, op.params));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [op.tenant]);
      await client.query(op.sql, op.params);
      await client.query("COMMIT");
    } catch (e) { try { await client.query("ROLLBACK"); } catch { /* already gone */ } throw e; }
    finally { client.release(); }
  }

  function buffer(op) {
    pending.push(op);
    while (pending.length > maxBufferedWrites) { pending.shift(); dropped++; } // bound memory; drop oldest, loudly
    if (dropped && dropped % 100 === 1) console.warn(`[store] write buffer full — dropped ${dropped} durable writes (mirror unaffected)`);
  }

  // Run one op against the DB. On failure, mark degraded and buffer it for replay.
  async function runOrBuffer(op) {
    if (degraded) { buffer(op); return; } // stay in order: don't jump ahead of buffered ops
    try { await runOp(op); }
    catch (e) { degraded = true; logErr(op.label, e); buffer(op); }
  }
  const enqueue = (op) => { queue = queue.then(() => runOrBuffer(op)); return queue; };

  function persistAdd(rec, payload) {
    enqueue({
      label: "add", tenant: rec.tenant || null,
      sql: `INSERT INTO records (tenant_id, id, ts, tier, mode, model, session, cached, data)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (id) DO NOTHING`,
      params: [rec.tenant || null, rec.id, tsOrNull(rec.ts), rec.tier || null, rec.mode || null, rec.model || null, rec.session || null, rec.cached === true, payload]
    });
  }
  function persistVerification(id, verificationJson, tenant) {
    enqueue({ label: "addVerification", tenant: tenant || null, sql: "UPDATE records SET verification = $2::jsonb WHERE id = $1", params: [id, verificationJson] });
  }
  function persistClear() {
    pending.length = 0; // a clear supersedes everything buffered
    enqueue({ label: "clear", sql: "TRUNCATE TABLE records RESTART IDENTITY", params: [] });
  }
  function persistClearTenant(tenantId) {
    enqueue({ label: "clearTenant", tenant: tenantId, sql: "DELETE FROM records WHERE tenant_id = $1", params: [tenantId] });
  }

  // Attempt to reconnect + replay buffered writes in order. Called by store.recover()
  // (and can be scheduled). Safe to call anytime; a no-op when healthy + empty.
  async function recover() {
    try {
      await pool.query("SELECT 1");            // cheap liveness probe (subject to statement_timeout)
      degraded = false;
      while (pending.length) {
        const op = pending[0];
        await runOp(op);                       // replay in order (tenant GUC set); throw => stop, stay degraded
        pending.shift();
      }
      return { ok: true, pending: pending.length };
    } catch (e) {
      degraded = true; logErr("recover", e);
      return { ok: false, pending: pending.length, error: e.message };
    }
  }

  const flush = () => queue;
  const close = async () => { await queue.catch(() => {}); if (!_pool) await pool.end(); };
  const health = () => ({ backend: "postgres", status: degraded ? "degraded" : "ok", pendingWrites: pending.length, droppedWrites: dropped });

  return { ensureSchema, load, persistAdd, persistVerification, persistClear, persistClearTenant, recover, flush, close, health, isDegraded: () => degraded };
}

module.exports = { create };
