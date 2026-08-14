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
 * Registries are an in-memory CACHE for fast synchronous lookup on the hot path. On the
 * postgres backend they are hydrated from tenants/users/api_keys/tenant_secrets at boot
 * and written through on every change, so keys and provider secrets SURVIVE A RESTART.
 * On the memory backend they are in-process only. Secrets are NEVER logged or returned.
 */

const DEFAULT_TENANT_ID = config.auth.defaultTenantId;

// in-memory stores (memory backend + tests). tenantId -> {id,name}; keyHash -> {tenantId,id,last4,name,revoked}
let tenants, keysByHash, secretsByTenant, usersById;
function reset() {
  tenants = new Map();
  keysByHash = new Map();
  secretsByTenant = new Map();
  usersById = new Map();
  if (typeof emailChangedAt !== "undefined") { emailChangedAt.clear(); logos.clear(); }
  ensureTenant(DEFAULT_TENANT_ID, "default");
}

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlToBuf = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

/**
 * DURABILITY. The maps above are a fast, synchronous cache — the /v1 hot path resolves a
 * key with a map lookup and never touches the DB. They are HYDRATED from Postgres at boot
 * and kept current by write-throughs, so a minted Joule key and a tenant's encrypted
 * provider key SURVIVE A RESTART. Without this they lived only in memory and were
 * destroyed on every redeploy (and on any idle spin-down).
 *
 * Writes are fire-and-forget through pgstore's off-path queue: a DB outage buffers them
 * and replays on recovery; nothing here can throw into a request. On the memory backend
 * `durable` stays null and behaviour is exactly as before.
 */
let durable = null;
function usePersistence(handle) { durable = handle || null; }
const persist = (fn, ...args) => { try { if (durable && durable[fn]) durable[fn](...args); } catch (e) { console.error("identity persist error:", e && e.message); } };

// Load tenants / users / api keys / provider secrets back into the cache at boot.
async function hydrate() {
  if (!durable || !durable.loadIdentity) return { tenants: 0, keys: 0, secrets: 0, users: 0 };
  const d = await durable.loadIdentity();
  for (const t of d.tenants) { if (!tenants.has(t.id)) tenants.set(t.id, { id: t.id, name: t.name || t.id, createdAt: new Date().toISOString() }); if (t.logo) logos.set(t.id, t.logo); }
  for (const k of d.apiKeys) keysByHash.set(k.key_hash, { id: k.id, tenantId: k.tenant_id, last4: k.last4, name: k.name, createdAt: k.created_at ? new Date(k.created_at).toISOString() : new Date().toISOString(), revoked: k.revoked === true });
  for (const s of d.secrets) if (s.upstream_key_enc) secretsByTenant.set(s.tenant_id, s.upstream_key_enc);
  for (const u of d.users) { usersById.set(u.id, u.tenant_id); if (u.email_changed_at) emailChangedAt.set(u.id, new Date(u.email_changed_at).toISOString()); }
  return { tenants: d.tenants.length, keys: d.apiKeys.length, secrets: d.secrets.length, users: d.users.length };
}

// ---- tenants + users ----
function ensureTenant(id, name) {
  if (!tenants.has(id)) {
    tenants.set(id, { id, name: name || id, createdAt: new Date().toISOString() });
    persist("persistTenant", id, name || String(id));
  }
  return tenants.get(id);
}
function createTenant(name) { const id = crypto.randomUUID(); return ensureTenant(id, name || "tenant"); }
function getTenant(id) { return tenants.get(id) || null; }
const defaultTenant = () => ({ id: DEFAULT_TENANT_ID });
function attachUser(userId, tenantId, email) {
  usersById.set(userId, tenantId);
  persist("persistUser", userId, tenantId, email || null);
  return { userId, tenantId };
}

// ---- Joule API keys ----
// Mint a key: returns the PLAINTEXT once; only the hash is retained.
function mintKey(tenantId, name) {
  ensureTenant(tenantId, tenantId);
  const secret = crypto.randomBytes(24).toString("hex");
  const key = config.auth.keyPrefix + secret;
  const hash = sha256(key);
  const rec = { id: "ak_" + crypto.randomBytes(6).toString("hex"), tenantId, last4: secret.slice(-4), name: name || "default", createdAt: new Date().toISOString(), revoked: false };
  keysByHash.set(hash, rec);
  persist("persistApiKey", rec, hash);   // survives a restart
  return { key, id: rec.id, last4: rec.last4, tenantId, name: rec.name }; // `key` shown ONCE
}
function revokeKey(keyId) {
  for (const rec of keysByHash.values()) if (rec.id === keyId) { rec.revoked = true; persist("persistRevokeKey", keyId, rec.tenantId); return true; }
  return false;
}
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
  if (payload.sub && !usersById.has(payload.sub)) attachUser(payload.sub, tenantId, payload.email); // remembered durably
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

/* ---------- profile: email-change cooldown, company logo, account deletion ----------
   The cooldown is SERVER-AUTHORITATIVE — a client-side check is not enforcement. The
   email/password changes themselves are performed by the managed auth provider
   (Supabase); we never see or store a password, and we only record WHEN an email
   change happened so the policy can be applied. */
const EMAIL_COOLDOWN_DAYS = 30;
const emailChangedAt = new Map();   // userId -> ISO timestamp
const logos = new Map();            // tenantId -> data URL

function emailChangeState(userId, now = Date.now()) {
  const last = userId ? emailChangedAt.get(userId) : null;
  if (!last) return { allowed: true, lastChangedAt: null, nextAllowedAt: null, daysRemaining: 0, cooldownDays: EMAIL_COOLDOWN_DAYS };
  const next = new Date(last).getTime() + EMAIL_COOLDOWN_DAYS * 86400000;
  const allowed = now >= next;
  return {
    allowed, lastChangedAt: last, nextAllowedAt: new Date(next).toISOString(),
    daysRemaining: allowed ? 0 : Math.ceil((next - now) / 86400000), cooldownDays: EMAIL_COOLDOWN_DAYS
  };
}
function recordEmailChange(userId, tenantId, whenIso) {
  const when = whenIso || new Date().toISOString();
  emailChangedAt.set(userId, when);
  persist("persistEmailChangedAt", userId, tenantId, when);
  return when;
}

// Company logo: a size-bounded data URL, validated by the caller before it reaches here.
function setLogo(tenantId, dataUrl) {
  if (dataUrl) logos.set(tenantId, dataUrl); else logos.delete(tenantId);
  persist("persistLogo", tenantId, dataUrl || null);
}
const getLogo = (tenantId) => logos.get(tenantId) || null;

// Drop EVERYTHING for one tenant from the in-memory caches. The durable delete is done by
// the caller so the request log goes with it.
function purgeTenant(tenantId) {
  let keys = 0;
  for (const [hash, rec] of [...keysByHash]) if (rec.tenantId === tenantId) { keysByHash.delete(hash); keys++; }
  for (const [uid, tid] of [...usersById]) if (tid === tenantId) { usersById.delete(uid); emailChangedAt.delete(uid); }
  secretsByTenant.delete(tenantId);
  logos.delete(tenantId);
  tenants.delete(tenantId);
  return { keys };
}

// ---- per-tenant upstream key encryption (AES-256-GCM) ----
/**
 * Encryption keys to TRY when decrypting, newest first:
 *   1. JOULE_ENC_KEY            — the current key, always used for writing
 *   2. JOULE_ENC_KEY_PREVIOUS   — the key being rotated away from
 *   3. the built-in dev fallback — what was used before JOULE_ENC_KEY was ever set
 *
 * Without (2) and (3), setting or changing JOULE_ENC_KEY silently orphaned every stored
 * provider key: the ciphertext was still there but could never be read again, and the
 * only "fix" was for each tenant to re-enter their key. Now a secret encrypted under an
 * older key is decrypted with it and TRANSPARENTLY RE-ENCRYPTED under the current one,
 * so rotation is a no-op for the user instead of a data-loss event.
 */
const devFallbackKey = () => crypto.createHash("sha256").update("joule-dev-enc::" + config.auth.defaultTenantId).digest();
function encKeyCandidates() {
  const out = [];
  if (config.auth.encKey) out.push({ key: crypto.createHash("sha256").update(config.auth.encKey).digest(), label: "current" });
  if (config.auth.encKeyPrevious) out.push({ key: crypto.createHash("sha256").update(config.auth.encKeyPrevious).digest(), label: "previous" });
  out.push({ key: devFallbackKey(), label: "built-in default" });   // always the last resort
  return out;
}

// Writing always uses the CURRENT key (the first candidate).
function encKey() { return encKeyCandidates()[0].key; }
function setUpstreamKey(tenantId, plaintext) {
  ensureTenant(tenantId, tenantId);
  undecryptable.delete(tenantId);
  if (!plaintext) { secretsByTenant.delete(tenantId); persist("persistTenantSecret", tenantId, null); return; }
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const enc = Buffer.concat([c.update(String(plaintext), "utf8"), c.final()]);
  const blob = { iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), data: enc.toString("hex") };
  secretsByTenant.set(tenantId, blob);
  persist("persistTenantSecret", tenantId, blob);   // encrypted blob only — never plaintext
}
function decryptWith(blob, key) {
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(blob.iv, "hex"));
  d.setAuthTag(Buffer.from(blob.tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(blob.data, "hex")), d.final()]).toString("utf8");
}

function getUpstreamKey(tenantId) {
  const s = secretsByTenant.get(tenantId);
  if (!s) return null;
  const candidates = encKeyCandidates();
  for (let i = 0; i < candidates.length; i++) {
    let plain;
    try { plain = decryptWith(s, candidates[i].key); } catch { continue; }   // wrong key — try the next
    if (i > 0) {
      // Decrypted with an OLDER key. Re-encrypt under the current one and persist, so the
      // rotation completes itself instead of leaving the secret one step from unreadable.
      console.warn(`[tenancy] provider key for tenant ${tenantId} was encrypted with the ${candidates[i].label} encryption key — re-encrypting under the current JOULE_ENC_KEY.`);
      try { setUpstreamKey(tenantId, plain); } catch (e) { console.error("re-encrypt failed:", e && e.message); }
    }
    undecryptable.delete(tenantId);
    return plain;
  }
  // Genuinely unreadable under every key we know. A STORED-BUT-UNREADABLE secret is not the
  // same as no secret — reporting null for both made a changed JOULE_ENC_KEY look like
  // "never configured" and silently restarted onboarding. providerKeyState() tells them apart.
  if (!undecryptable.has(tenantId)) {
    undecryptable.add(tenantId);
    console.error(`[tenancy] stored provider key for tenant ${tenantId} cannot be decrypted with the current key, JOULE_ENC_KEY_PREVIOUS, or the built-in default. Set JOULE_ENC_KEY_PREVIOUS to the old value, or have the tenant re-enter their provider key.`);
  }
  return null;
}
const undecryptable = new Set();

/**
 * Why a tenant has no usable provider key:
 *   "ok"          — a key is stored and decrypts
 *   "none"        — nothing stored; genuine first-time setup
 *   "unreadable"  — a key IS stored but the encryption key no longer matches it
 * The last case is the one worth naming: it looks identical to "none" from the outside,
 * and telling a user to "add your provider key" when theirs is sitting there undecryptable
 * is both confusing and wrong.
 */
function providerKeyState(tenantId) {
  if (!secretsByTenant.has(tenantId)) return "none";
  return getUpstreamKey(tenantId) ? "ok" : "unreadable";
}

reset();

module.exports = {
  DEFAULT_TENANT_ID, reset, ensureTenant, createTenant, getTenant, defaultTenant, attachUser,
  mintKey, revokeKey, listKeys, resolveFromApiKey, resolveFromJwt, verifyJwt,
  setUpstreamKey, getUpstreamKey, diagnoseJwt, tenantIdForUser, usePersistence, hydrate,
  emailChangeState, recordEmailChange, setLogo, getLogo, purgeTenant, EMAIL_COOLDOWN_DAYS, providerKeyState, _sha256: sha256
};
