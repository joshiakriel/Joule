"use strict";
const crypto = require("crypto");
const config = require("./config");

/**
 * Multi-tenant identity + isolation primitives (Phase 1.1).
 *
 *  - Joule API keys (customer -> /v1 proxy): minted `jk_live_<random>`, shown ONCE,
 *    stored only as a sha-256 hash. Resolved to a tenant via an in-memory hash->tenant
 *    cache (the hot path never hits the DB).
 *  - Supabase JWT (dashboard -> /api): verified LOCALLY (HS256) against SUPABASE_JWT_SECRET
 *    so password/session/token logic stays fully managed by Supabase. Structured so an
 *    asymmetric/JWKS verifier (SSO/OIDC) can be added later.
 *  - Per-tenant upstream provider key: encrypted at rest (AES-256-GCM), never logged.
 *
 * Registries are in-memory here (authoritative for the memory backend + tests); the
 * Postgres backend persists the same rows in tenant-scoped tables (migrations/002).
 * Secrets are NEVER logged or returned after creation.
 */

const DEFAULT_TENANT_ID = config.auth.defaultTenantId;

// in-memory stores (memory backend + tests). tenantId -> {id,name}; keyHash -> {tenantId,id,last4,name,revoked}
let tenants, keysByHash, secretsByTenant, usersById;
function reset() {
  tenants = new Map();
  keysByHash = new Map();
  secretsByTenant = new Map();
  usersById = new Map();
  ensureTenant(DEFAULT_TENANT_ID, "default");
}

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlToBuf = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

// ---- tenants + users ----
function ensureTenant(id, name) { if (!tenants.has(id)) tenants.set(id, { id, name: name || id, createdAt: new Date().toISOString() }); return tenants.get(id); }
function createTenant(name) { const id = crypto.randomUUID(); return ensureTenant(id, name || "tenant"); }
function getTenant(id) { return tenants.get(id) || null; }
const defaultTenant = () => ({ id: DEFAULT_TENANT_ID });
function attachUser(userId, tenantId) { usersById.set(userId, tenantId); return { userId, tenantId }; }

// ---- Joule API keys ----
// Mint a key: returns the PLAINTEXT once; only the hash is retained.
function mintKey(tenantId, name) {
  ensureTenant(tenantId, tenantId);
  const secret = crypto.randomBytes(24).toString("hex");
  const key = config.auth.keyPrefix + secret;
  const hash = sha256(key);
  const rec = { id: "ak_" + crypto.randomBytes(6).toString("hex"), tenantId, last4: secret.slice(-4), name: name || "default", createdAt: new Date().toISOString(), revoked: false };
  keysByHash.set(hash, rec);
  return { key, id: rec.id, last4: rec.last4, tenantId, name: rec.name }; // `key` shown ONCE
}
function revokeKey(keyId) { for (const rec of keysByHash.values()) if (rec.id === keyId) { rec.revoked = true; return true; } return false; }
function listKeys(tenantId) { return [...keysByHash.values()].filter((r) => r.tenantId === tenantId).map((r) => ({ id: r.id, last4: r.last4, name: r.name, createdAt: r.createdAt, revoked: r.revoked })); }

const bearer = (authHeader) => { const m = /^Bearer\s+(.+)$/i.exec(String(authHeader || "").trim()); return m ? m[1].trim() : null; };

// Resolve a Joule API key (from an Authorization header) to a tenant, or null.
function resolveFromApiKey(authHeader) {
  const key = bearer(authHeader);
  if (!key || !key.startsWith(config.auth.keyPrefix)) return null;
  const rec = keysByHash.get(sha256(key));
  if (!rec || rec.revoked) return null;
  return { id: rec.tenantId, keyId: rec.id };
}

// ---- Supabase JWT (HS256) verification ----
// Verify signature + exp locally; extract tenant from app_metadata.tenant_id (preferred)
// or a top-level tenant_id claim, else map the Supabase user (sub) to a tenant.
function verifyJwt(token) {
  const secret = config.auth.jwtSecret;
  if (!secret || !token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try { header = JSON.parse(b64urlToBuf(parts[0]).toString("utf8")); payload = JSON.parse(b64urlToBuf(parts[1]).toString("utf8")); }
  catch { return null; }
  if (!header || header.alg !== "HS256") return null; // only HS256 here (JWKS/asymmetric is a later add)
  const expected = crypto.createHmac("sha256", secret).update(parts[0] + "." + parts[1]).digest();
  const got = b64urlToBuf(parts[2]);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return null;
  if (payload.exp && Date.now() / 1000 > payload.exp) return null; // expired
  return payload;
}
function resolveFromJwt(authHeader) {
  const payload = verifyJwt(bearer(authHeader));
  if (!payload) return null;
  const tenantId = (payload.app_metadata && payload.app_metadata.tenant_id) || payload.tenant_id || usersById.get(payload.sub);
  if (!tenantId) return null;
  ensureTenant(tenantId, tenantId);
  // `role` is carried through so the server can recognise an operator from a role claim
  // (Supabase projects commonly put it at the top level or under app_metadata).
  const role = payload.role || (payload.app_metadata && payload.app_metadata.role) || null;
  return { id: tenantId, userId: payload.sub || null, email: payload.email || null, role };
}

// ---- per-tenant upstream key encryption (AES-256-GCM) ----
function encKey() {
  if (config.auth.encKey) return crypto.createHash("sha256").update(config.auth.encKey).digest(); // 32 bytes from provided secret
  return crypto.createHash("sha256").update("joule-dev-enc::" + config.auth.defaultTenantId).digest(); // deterministic dev key (DRY_RUN)
}
function setUpstreamKey(tenantId, plaintext) {
  ensureTenant(tenantId, tenantId);
  if (!plaintext) { secretsByTenant.delete(tenantId); return; }
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const enc = Buffer.concat([c.update(String(plaintext), "utf8"), c.final()]);
  secretsByTenant.set(tenantId, { iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), data: enc.toString("hex") });
}
function getUpstreamKey(tenantId) {
  const s = secretsByTenant.get(tenantId);
  if (!s) return null;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", encKey(), Buffer.from(s.iv, "hex"));
    d.setAuthTag(Buffer.from(s.tag, "hex"));
    return Buffer.concat([d.update(Buffer.from(s.data, "hex")), d.final()]).toString("utf8");
  } catch { return null; }
}

reset();

module.exports = {
  DEFAULT_TENANT_ID, reset, ensureTenant, createTenant, getTenant, defaultTenant, attachUser,
  mintKey, revokeKey, listKeys, resolveFromApiKey, resolveFromJwt, verifyJwt,
  setUpstreamKey, getUpstreamKey, _sha256: sha256
};
