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

  // ---- identity persistence (tenants / users / api keys / provider secrets) ----
  // Read ACROSS tenants at boot via the SECURITY DEFINER loaders, then cached in memory so
  // the hot path stays a synchronous map lookup with no per-request DB hit. Writes are
  // enqueued off-path like every other write: an outage buffers them, never breaks a response.
  async function loadIdentity() {
    const [tenants, apiKeys, secrets, users] = await Promise.all([
      pool.query("SELECT id, name, logo FROM app_load_tenants()"),
      pool.query("SELECT id, tenant_id, key_hash, last4, name, revoked, created_at FROM app_load_api_keys()"),
      pool.query("SELECT tenant_id, upstream_key_enc FROM app_load_tenant_secrets()"),
      pool.query("SELECT id, tenant_id, email, email_changed_at FROM app_load_users()")
    ]);
    return { tenants: tenants.rows, apiKeys: apiKeys.rows, secrets: secrets.rows, users: users.rows };
  }

  // `tenants` has no tenant_id column and no RLS policy, so it needs no GUC.
  function persistTenant(id, name) {
    enqueue({ label: "tenant", sql: "INSERT INTO tenants (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING", params: [id, name || String(id)] });
  }
  function persistUser(id, tenantId, email) {
    enqueue({ label: "user", tenant: tenantId,
      sql: "INSERT INTO users (id, tenant_id, email) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id",
      params: [id, tenantId, email || null] });
  }
  function persistApiKey(rec, keyHash) {
    enqueue({ label: "apiKey", tenant: rec.tenantId,
      sql: `INSERT INTO api_keys (id, tenant_id, key_hash, last4, name, revoked)
            VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      params: [rec.id, rec.tenantId, keyHash, rec.last4 || null, rec.name || null, rec.revoked === true] });
  }
  function persistRevokeKey(keyId, tenantId) {
    enqueue({ label: "revokeKey", tenant: tenantId, sql: "UPDATE api_keys SET revoked = true WHERE id = $1", params: [keyId] });
  }
  // the provider key is persisted ONLY as its AES-256-GCM blob {iv,tag,data} — never plaintext
  function persistTenantSecret(tenantId, encBlob) {
    enqueue({ label: "tenantSecret", tenant: tenantId,
      sql: `INSERT INTO tenant_secrets (tenant_id, upstream_key_enc, updated_at)
            VALUES ($1,$2::jsonb,now()) ON CONFLICT (tenant_id) DO UPDATE SET upstream_key_enc = EXCLUDED.upstream_key_enc, updated_at = now()`,
      params: [tenantId, encBlob == null ? null : JSON.stringify(encBlob)] });
  }

  // ---- profile ----
  function persistEmailChangedAt(userId, tenantId, whenIso) {
    enqueue({ label: "emailChangedAt", tenant: tenantId,
      sql: "UPDATE users SET email_changed_at = $2, email = COALESCE($3, email) WHERE id = $1",
      params: [userId, whenIso, null] });
  }
  function persistLogo(tenantId, logo) {
    enqueue({ label: "logo", sql: "UPDATE tenants SET logo = $2 WHERE id = $1", params: [tenantId, logo] });
  }
  // Full tenant deletion, transactional, via the SECURITY DEFINER routine.
  async function deleteTenant(tenantId) {
    const { rows } = await pool.query("SELECT records, keys, users FROM app_delete_tenant($1)", [tenantId]);
    return rows[0] || { records: 0, keys: 0, users: 0 };
  }

  /**
   * Verify that row-level security is ACTUALLY in force, in the live database.
   *
   * An offline test suite cannot prove this — it needs a real Postgres — so the check runs
   * where the database exists. It answers the two questions that decide whether the
   * DB-layer half of tenant isolation is real:
   *   1. Is RLS enabled AND forced on every tenant-scoped table, with a policy attached?
   *      (ENABLE alone is not enough: without FORCE the table owner bypasses it.)
   *   2. Does the role we connect as BYPASS RLS? Supabase's default `postgres` role often
   *      does, and that silently defeats every policy no matter how correct it is.
   * Returns a structured verdict; never throws.
   */
  async function checkRls() {
    const tables = ["records", "users", "api_keys", "tenant_secrets"];
    try {
      const { rows: t } = await pool.query(
        `SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
                (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY($1)`, [tables]);
      const { rows: r } = await pool.query(
        "SELECT current_user AS role, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses, rolsuper FROM pg_roles WHERE rolname = current_user");
      const role = r[0] || {};
      const perTable = {};
      let allProtected = true;
      for (const name of tables) {
        const row = t.find((x) => x.table === name);
        const ok = Boolean(row && row.enabled && row.forced && Number(row.policies) > 0);
        perTable[name] = row
          ? { enabled: row.enabled, forced: row.forced, policies: Number(row.policies), protected: ok }
          : { missing: true, protected: false };
        if (!ok) allProtected = false;
      }
      // A bypassing role makes the policies decorative — say so rather than reporting green.
      const bypasses = Boolean(role.bypasses || role.rolsuper);
      return {
        available: true,
        enforced: allProtected && !bypasses,
        tables: perTable,
        connectedRole: role.role || null,
        roleBypassesRls: bypasses,
        note: bypasses
          ? `RLS policies are configured, but the connecting role "${role.role}" BYPASSES row-level security, so the database is not enforcing tenant isolation. Connect as a role without BYPASSRLS/SUPERUSER to make the DB-layer guarantee real.`
          : allProtected
            ? "Row-level security is enabled and FORCED on every tenant table, with policies attached, and the connecting role does not bypass it."
            : "One or more tenant tables are missing RLS, FORCE, or a policy — see `tables`."
      };
    } catch (e) {
      return { available: false, enforced: null, error: e && e.message ? e.message : String(e),
        note: "Could not verify row-level security against the database." };
    }
  }

  const flush = () => queue;
  const close = async () => { await queue.catch(() => {}); if (!_pool) await pool.end(); };
  const health = () => ({ backend: "postgres", status: degraded ? "degraded" : "ok", pendingWrites: pending.length, droppedWrites: dropped });

  return { ensureSchema, load, persistAdd, persistVerification, persistClear, persistClearTenant,
    loadIdentity, persistTenant, persistUser, persistApiKey, persistRevokeKey, persistTenantSecret,
    persistEmailChangedAt, persistLogo, deleteTenant, checkRls,
    recover, flush, close, health, isDegraded: () => degraded };
}

module.exports = { create };
