"use strict";
// Row-Level Security isolation against a REAL Postgres (defence in depth): even a direct
// SQL SELECT cannot read another tenant's rows. Opt-in — set DATABASE_URL + STORE_PG_TEST=1
// against a THROWAWAY database (this creates + deletes tenant rows). Skips otherwise.
process.env.DRY_RUN = "true";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../src/config");

const REAL = process.env.DATABASE_URL && process.env.STORE_PG_TEST === "1";

test("RLS: a direct query for tenant A can never see tenant B's records", { skip: REAL ? false : "set DATABASE_URL + STORE_PG_TEST=1 (throwaway DB)" }, async () => {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: config.store.databaseUrl, ssl: config.store.ssl });
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";
  const c = await pool.connect();
  try {
    // apply migrations (idempotent) so RLS + policies exist
    for (const f of fs.readdirSync(path.join(__dirname, "..", "migrations")).filter((x) => x.endsWith(".sql")).sort()) {
      await c.query(fs.readFileSync(path.join(__dirname, "..", "migrations", f), "utf8"));
    }
    await c.query("INSERT INTO tenants (id,name) VALUES ($1,'A'),($2,'B') ON CONFLICT DO NOTHING", [A, B]);

    // write one row per tenant, each inside its own tenant GUC (as the app does)
    for (const [t, id] of [[A, "rls-a"], [B, "rls-b"]]) {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_tenant',$1,true)", [t]);
      await c.query("INSERT INTO records (tenant_id,id,ts,tier,mode,model,cached,data) VALUES ($1,$2,now(),'small','dry_run','m',false,'{}'::jsonb) ON CONFLICT (id) DO NOTHING", [t, id]);
      await c.query("COMMIT");
    }

    // as tenant A, a plain SELECT sees ONLY A's row — the DB itself refuses B's
    await c.query("BEGIN"); await c.query("SELECT set_config('app.current_tenant',$1,true)", [A]);
    const seenByA = (await c.query("SELECT id FROM records WHERE id IN ('rls-a','rls-b')")).rows.map((r) => r.id);
    await c.query("COMMIT");
    assert.deepEqual(seenByA, ["rls-a"], "tenant A sees only its own row — RLS blocks B");

    await c.query("BEGIN"); await c.query("SELECT set_config('app.current_tenant',$1,true)", [B]);
    const seenByB = (await c.query("SELECT id FROM records WHERE id IN ('rls-a','rls-b')")).rows.map((r) => r.id);
    await c.query("COMMIT");
    assert.deepEqual(seenByB, ["rls-b"], "tenant B sees only its own row — RLS blocks A");

    // cleanup
    for (const [t, id] of [[A, "rls-a"], [B, "rls-b"]]) {
      await c.query("BEGIN"); await c.query("SELECT set_config('app.current_tenant',$1,true)", [t]);
      await c.query("DELETE FROM records WHERE id=$1", [id]); await c.query("COMMIT");
    }
  } finally { c.release(); await pool.end(); }
});
