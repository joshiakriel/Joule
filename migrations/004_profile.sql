-- Profile: account-level state that must be DURABLE and server-authoritative.
--
--  * users.email_changed_at — the 30-day email-change cooldown. Enforced on the SERVER;
--    a client-side check is not enforcement.
--  * tenants.logo — the company logo shown in the sidebar, stored per tenant as a
--    size-bounded data URL so no object storage is required. Validated before write.
--
-- Idempotent: safe to run on every boot.

ALTER TABLE users   ADD COLUMN IF NOT EXISTS email_changed_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS logo TEXT;

-- Loaders must read across tenants at boot (RLS forbids that), same SECURITY DEFINER
-- pattern as app_load_records / app_load_tenants.
CREATE OR REPLACE FUNCTION app_load_tenants()
  RETURNS TABLE(id UUID, name TEXT, logo TEXT) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT id, name, logo FROM tenants;
$$;

CREATE OR REPLACE FUNCTION app_load_users()
  RETURNS TABLE(id UUID, tenant_id UUID, email TEXT, email_changed_at TIMESTAMPTZ)
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT id, tenant_id, email, email_changed_at FROM users;
$$;

-- Account deletion. Removes EVERYTHING belonging to one tenant in a single transaction:
-- request log, API keys, provider secret, users, then the tenant row. SECURITY DEFINER
-- because it must delete across RLS-protected tables for a tenant that is being removed;
-- it takes the tenant id explicitly and touches nothing else.
CREATE OR REPLACE FUNCTION app_delete_tenant(p_tenant UUID)
  RETURNS TABLE(records BIGINT, keys BIGINT, users BIGINT)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r BIGINT; k BIGINT; u BIGINT;
BEGIN
  DELETE FROM records        WHERE tenant_id = p_tenant;  GET DIAGNOSTICS r = ROW_COUNT;
  DELETE FROM api_keys       WHERE tenant_id = p_tenant;  GET DIAGNOSTICS k = ROW_COUNT;
  DELETE FROM tenant_secrets WHERE tenant_id = p_tenant;
  DELETE FROM users          WHERE tenant_id = p_tenant;  GET DIAGNOSTICS u = ROW_COUNT;
  DELETE FROM tenants        WHERE id = p_tenant;
  RETURN QUERY SELECT r, k, u;
END $$;
