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
  if (!checkIssuerAudience(payload)) return null;                  // wrong project / wrong audience
  return payload;
}

/**
 * Issuer + audience validation. A valid signature alone only proves "someone holding this
 * secret signed this" — it does NOT prove the token came from OUR project or was minted
 * for US. Without this, a genuine session token from any other Supabase project that
 * happened to share the secret would be accepted.
 *
 * Enforced ONLY when SUPABASE_URL is configured, because that is the one thing that tells
 * us which issuer to expect. Unconfigured (local dev, offline tests) => nothing to compare
 * against, so the check is skipped rather than guessed at.
 */
function expectedIssuer() {
  const base = String(config.auth.supabaseUrl || "").trim().replace(/\/+$/, "");
  return base ? base + "/auth/v1" : null;
}
function checkIssuerAudience(payload) {
  const iss = expectedIssuer();
  if (!iss) return true;                                   // not configured — nothing to verify against
  if (payload.iss !== iss) return false;                   // minted by a different project
  const want = config.auth.jwtAudience;
  if (!want) return true;
  const aud = payload.aud;                                 // `aud` may be a string or an array
  return Array.isArray(aud) ? aud.includes(want) : aud === want;
}
/**
 * A user's own workspace id, derived DETERMINISTICALLY from their Supabase user id.
 *
 * Phase 1.1's model is "one user = one tenant to start". Supabase never populates a
 * tenant_id claim, so without this every verified sign-in resolved to no tenant and 401'd.
 * Deriving the id means the mapping is stable across restarts with nothing to persist —
 * the same user always lands in the same workspace and keeps their data.
 *
 * Supabase `sub` is already a UUID, so it's used directly (it must be a UUID to satisfy
 * the `tenant_id UUID` column and the RLS policy). Any non-UUID subject is hashed into a
 * stable RFC-4122 v5-style UUID instead.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function tenantIdForUser(sub) {
  if (!sub) return null;
  if (UUID_RE.test(sub)) return String(sub).toLowerCase();
  const h = crypto.createHash("sha256").update("joule-tenant::" + sub).digest("hex");
  return [h.slice(0, 8), h.slice(8, 12), "5" + h.slice(13, 16), ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20), h.slice(20, 32)].join("-");
}

function resolveFromJwt(authHeader) {
  const payload = verifyJwt(bearer(authHeader));
  if (!payload) return null;
  // Explicit team mapping wins (app_metadata claim, then the user->tenant table) so teams
  // work later; otherwise fall back to this user's own derived workspace.
  const tenantId = (payload.app_metadata && payload.app_metadata.tenant_id)
    || payload.tenant_id
    || usersById.get(payload.sub)
    || tenantIdForUser(payload.sub);
  if (!tenantId) return null;
  ensureTenant(tenantId, payload.email || tenantId);
  if (payload.sub && !usersById.has(payload.sub)) usersById.set(payload.sub, tenantId); // remember for this process
  // `role` is carried through so the server can recognise an operator from a role claim
  // (Supabase projects commonly put it at the top level or under app_metadata).
  const role = payload.role || (payload.app_metadata && payload.app_metadata.role) || null;
  return { id: tenantId, userId: payload.sub || null, email: payload.email || null, role };
}

/**
 * AUTH DIAGNOSTICS (DEBUG_AUTH=true only).
 * Reports the SHAPE of an incoming token and the PRECISE reason it was rejected, so an
 * operator can tell "no token arrived" from "wrong algorithm" from "signature mismatch"
 * from "verified fine but no tenant could be resolved".
 *
 * SAFETY: never returns or logs the token, its signature, or the secret. Only lengths,
 * a 2-char head/tail fingerprint of the secret, and non-sensitive claim values.
 */
function diagnoseJwt(authHeader) {
  const out = { present: false, scheme: null, tokenLength: 0, alg: null, kid: null, typ: null,
    iss: null, aud: null, role: null, sub: null, expiresInSec: null, claimKeys: [],
    secretLoaded: false, secretLength: 0, secretHint: null, tenantResolvable: false, reason: null };

  const secret = config.auth.jwtSecret;
  out.secretLoaded = Boolean(secret);
  out.secretLength = secret ? secret.length : 0;
  if (secret && secret.length >= 4) out.secretHint = secret.slice(0, 2) + "…" + secret.slice(-2);
  // a secret pasted WITH surrounding quotes is a classic env-var mistake
  if (secret && /^["'].*["']$/.test(secret)) out.reason = "secret_wrapped_in_quotes";

  const raw = String(authHeader || "").trim();
  if (!raw) { out.reason = out.reason || "no_authorization_header"; return out; }
  out.present = true;
  out.scheme = raw.split(/\s+/)[0] || null;
  const token = bearer(raw);
  if (!token) { out.reason = out.reason || "header_not_bearer"; return out; }
  out.tokenLength = token.length;

  const parts = token.split(".");
  if (parts.length !== 3) { out.reason = out.reason || "not_a_three_part_jwt"; return out; }

  let header, payload;
  try { header = JSON.parse(b64urlToBuf(parts[0]).toString("utf8")); } catch { out.reason = out.reason || "header_not_decodable"; return out; }
  try { payload = JSON.parse(b64urlToBuf(parts[1]).toString("utf8")); } catch { out.reason = out.reason || "payload_not_decodable"; return out; }

  out.alg = header.alg || null; out.kid = header.kid || null; out.typ = header.typ || null;
  out.iss = payload.iss || null; out.aud = payload.aud || null;
  out.role = payload.role || null; out.sub = payload.sub ? String(payload.sub).slice(0, 8) + "…" : null;
  out.claimKeys = Object.keys(payload).sort();
  if (payload.exp) out.expiresInSec = Math.round(payload.exp - Date.now() / 1000);

  if (!secret) { out.reason = out.reason || "no_SUPABASE_JWT_SECRET_configured"; return out; }
  if (header.alg !== "HS256") { out.reason = out.reason || `unsupported_alg_${header.alg}_verifier_is_HS256_only`; return out; }

  // signature check — raw UTF-8 secret, which is what Supabase's legacy HS256 secret is
  const expected = crypto.createHmac("sha256", secret).update(parts[0] + "." + parts[1]).digest();
  const got = b64urlToBuf(parts[2]);
  const sigOk = expected.length === got.length && crypto.timingSafeEqual(expected, got);
  if (!sigOk) {
    // is it a base64-decoded-secret project? report it so we fix encoding, not architecture
    let altOk = false;
    try {
      const alt = crypto.createHmac("sha256", Buffer.from(secret, "base64")).update(parts[0] + "." + parts[1]).digest();
      altOk = alt.length === got.length && crypto.timingSafeEqual(alt, got);
    } catch { /* not valid base64 */ }
    out.reason = altOk ? "signature_valid_only_if_secret_base64_decoded" : "signature_mismatch";
    return out;
  }
  if (payload.exp && Date.now() / 1000 > payload.exp) { out.reason = "token_expired"; return out; }
  const wantIss = expectedIssuer();
  if (wantIss && payload.iss !== wantIss) { out.reason = "issuer_mismatch_token_from_a_different_project"; out.expectedIss = wantIss; return out; }
  if (wantIss && !checkIssuerAudience(payload)) { out.reason = "audience_mismatch_expected_" + config.auth.jwtAudience; return out; }

  // signature is GOOD — can we resolve a tenant from it?
  const tenantId = (payload.app_metadata && payload.app_metadata.tenant_id) || payload.tenant_id || usersById.get(payload.sub) || tenantIdForUser(payload.sub);
  out.tenantResolvable = Boolean(tenantId);
  out.reason = tenantId ? "ok" : "verified_but_no_subject_to_derive_a_workspace_from";
  return out;
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
  setUpstreamKey, getUpstreamKey, diagnoseJwt, tenantIdForUser, _sha256: sha256
};
