-- Phase 1.1 completion: make identity DURABLE.
--
-- migrations/002 created tenants / users / api_keys / tenant_secrets, but nothing ever
-- read or wrote them — tenancy.js kept everything in memory, so every minted Joule API
-- key and every per-tenant provider key was destroyed on restart. On a host that spins
-- down when idle, a customer's key stopped working within the hour.
--
-- The app hydrates its in-memory identity cache from these tables at boot (so the hot
-- path stays a synchronous map lookup with no per-request DB hit) and write-throughs
-- keep them current. Boot must read ACROSS tenants, which RLS forbids, so the loader is
-- SECURITY DEFINER — exactly the pattern app_load_records() already uses for the mirror.
-- Idempotent: safe to run on every boot.
--
-- Every loader DROPs before CREATE. Migrations re-run in order on EVERY boot, so a later
-- migration may already have widened one of these; CREATE OR REPLACE would then fail with
-- "cannot change return type of existing function", abort this file, and prevent the later
-- migration from running at all. Dropping first makes the sequence converge either way.

DROP FUNCTION IF EXISTS app_load_tenants();
CREATE FUNCTION app_load_tenants()
  RETURNS TABLE(id UUID, name TEXT) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT id, name FROM tenants;
$$;

DROP FUNCTION IF EXISTS app_load_api_keys();
CREATE FUNCTION app_load_api_keys()
  RETURNS TABLE(id TEXT, tenant_id UUID, key_hash TEXT, last4 TEXT, name TEXT, revoked BOOLEAN, created_at TIMESTAMPTZ)
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT id, tenant_id, key_hash, last4, name, revoked, created_at FROM api_keys;
$$;

DROP FUNCTION IF EXISTS app_load_tenant_secrets();
CREATE FUNCTION app_load_tenant_secrets()
  RETURNS TABLE(tenant_id UUID, upstream_key_enc JSONB)
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT tenant_id, upstream_key_enc FROM tenant_secrets WHERE upstream_key_enc IS NOT NULL;
$$;

DROP FUNCTION IF EXISTS app_load_users();
CREATE FUNCTION app_load_users()
  RETURNS TABLE(id UUID, tenant_id UUID, email TEXT)
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT id, tenant_id, email FROM users;
$$;
