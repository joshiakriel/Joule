-- Phase 1.1 — multi-tenancy: identity tables, tenant_id on the request log, and
-- Row-Level Security so the DATABASE itself refuses cross-tenant reads even if app
-- code has a bug (defence in depth). Idempotent: safe to run on every boot.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ---- identity ----
CREATE TABLE IF NOT EXISTS tenants (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- the default tenant that existing (pre-tenancy) rows are backfilled to
INSERT INTO tenants (id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'default')
  ON CONFLICT (id) DO NOTHING;

-- a user (Supabase auth uid) belongs to exactly one tenant to start; the schema allows
-- many users per tenant so teams work later.
CREATE TABLE IF NOT EXISTS users (
  id         UUID PRIMARY KEY,                       -- Supabase auth user id (sub)
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email      TEXT,
  role       TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_tenant_idx ON users (tenant_id);

-- customer Joule API keys — only the sha-256 HASH is stored (shown in plaintext once).
CREATE TABLE IF NOT EXISTS api_keys (
  id         TEXT PRIMARY KEY,
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash   TEXT UNIQUE NOT NULL,
  last4      TEXT,
  name       TEXT,
  revoked    BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys (tenant_id);

-- per-tenant upstream provider key, ENCRYPTED at rest (AES-256-GCM blob {iv,tag,data}).
CREATE TABLE IF NOT EXISTS tenant_secrets (
  tenant_id       UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  upstream_key_enc JSONB,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- tenant_id on the request log + backfill ----
ALTER TABLE records ADD COLUMN IF NOT EXISTS tenant_id UUID;
UPDATE records SET tenant_id = '00000000-0000-0000-0000-000000000001' WHERE tenant_id IS NULL;
ALTER TABLE records ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-0000-0000-000000000001';
ALTER TABLE records ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS records_tenant_idx ON records (tenant_id);

-- ---- Row-Level Security (belt and braces) ----
-- Policy: a row is visible only when its tenant_id matches the session GUC the app sets
-- (`SET app.current_tenant = '<uuid>'`). FORCE so even the table owner is subject to it.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['records','users','api_keys','tenant_secrets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
      WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid)$f$, t);
  END LOOP;
END $$;

-- Pre-auth key resolution needs to read api_keys WITHOUT a tenant context (we don't know
-- the tenant yet). This SECURITY DEFINER function runs as owner (bypassing RLS) and returns
-- ONLY the tenant_id for a matching, non-revoked hash — nothing else leaks.
CREATE OR REPLACE FUNCTION resolve_api_key(p_hash TEXT)
  RETURNS UUID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT tenant_id FROM api_keys WHERE key_hash = p_hash AND revoked = false LIMIT 1;
$$;

-- The app holds an in-memory mirror of ALL tenants' records and rebuilds it on boot.
-- This SECURITY DEFINER reader runs as owner (bypassing RLS) so the mirror can load
-- every tenant, while per-request WRITES still set app.current_tenant and are RLS-checked.
CREATE OR REPLACE FUNCTION app_load_records()
  RETURNS TABLE(data JSONB, verification JSONB) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT data, verification FROM records ORDER BY seq ASC;
$$;
