"use strict";
// Settings architecture: per-workspace provider connection vs deployment-wide instance
// settings. A tenant must never be offered a save that is structurally guaranteed to 403.
process.env.DRY_RUN = "true";
process.env.VERIFY_SAMPLE_RATE = "0";
delete process.env.UPSTREAM_API_KEY;

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("../src/store");
const verify = require("../src/verify");
const budget = require("../src/budget");
const config = require("../src/config");
const tenancy = require("../src/tenancy");
const upstream = require("../src/upstream");
const app = require("../src/server");

let server, base, tmpDir;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwtFor = (tid, extra = {}) => {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({ sub: "u-" + tid.slice(0, 6), app_metadata: { tenant_id: tid }, exp: Math.floor(Date.now() / 1000) + 3600, ...extra });
  return `${h}.${p}.${crypto.createHmac("sha256", config.auth.jwtSecret).update(h + "." + p).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
};
const auth = (t) => ({ authorization: "Bearer " + t });
const postJson = (url, body, headers) => fetch(base + url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body || {}) });

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "joule-set-"));
  store.init(tmpDir); require("../src/calibrate").setDir(tmpDir);
  verify.reset(); budget.reset();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  config.auth.required = false; config.auth.operatorEmails = []; upstream.setFetch(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => {
  store.clear(); tenancy.reset(); upstream.setFetch(null);
  config.auth.required = true; config.auth.jwtSecret = "set-secret"; config.auth.operatorEmails = [];
});

test("a tenant can connect a provider; a bad key is rejected with the PROVIDER's own message", async () => {
  const T = tenancy.createTenant("acme");
  const tok = jwtFor(T.id, { email: "user@acme.com" });

  // bad key -> the provider's wording, and nothing is stored
  upstream.setFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));
  const bad = await postJson("/api/provider-key", { apiKey: "gsk_wrong", baseUrl: "https://api.groq.com/openai/v1" }, auth(tok));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).message, /rejected this key/i);
  assert.equal(tenancy.getUpstreamKey(T.id), null, "a rejected key is never stored");

  // good key -> saved encrypted, and /api/me reports connected WITHOUT leaking it
  upstream.setFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }));
  const good = await postJson("/api/provider-key", { apiKey: "gsk_realkey1234", baseUrl: "https://api.groq.com/openai/v1" }, auth(tok));
  assert.equal(good.status, 200);
  assert.equal((await good.json()).valid, true);

  const me = await (await fetch(base + "/api/me", { headers: auth(tok) })).json();
  assert.equal(me.provider.connected, true, "connection state is shown");
  assert.equal(me.provider.last4, "1234", "only the last 4 are exposed");
  assert.ok(!JSON.stringify(me).includes("gsk_realkey1234"), "the stored key is NEVER returned");
});

test("the stored provider key is not returned by ANY endpoint", async () => {
  const T = tenancy.createTenant("t");
  const tok = jwtFor(T.id, { email: "u@t.com" });
  tenancy.setUpstreamKey(T.id, "sk-super-secret-value");
  for (const url of ["/api/me", "/api/config", "/api/stats", "/api/status", "/api/keys", "/api/report?format=json"]) {
    const body = await (await fetch(base + url, { headers: auth(tok) })).text();
    assert.ok(!body.includes("sk-super-secret-value"), `${url} must not leak the provider key`);
  }
});

test("a normal tenant CANNOT edit deployment-wide settings (the guard holds)", async () => {
  const T = tenancy.createTenant("t");
  const tok = jwtFor(T.id, { email: "nobody@example.com" });   // not on the operator allowlist
  const me = await (await fetch(base + "/api/me", { headers: auth(tok) })).json();
  assert.equal(me.isOperator, false, "a normal tenant is not an operator");

  const r = await postJson("/api/config", { modelSmall: "sneaky-model" }, auth(tok));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.code, "global_config_forbidden");
  assert.notEqual(config.modelSmall, "sneaky-model", "the deployment config is unchanged");
});

test("an OPERATOR can edit deployment-wide settings", async () => {
  config.auth.operatorEmails = ["ops@joule.test"];
  const T = tenancy.createTenant("t");
  const opTok = jwtFor(T.id, { email: "ops@joule.test" });

  const me = await (await fetch(base + "/api/me", { headers: auth(opTok) })).json();
  assert.equal(me.isOperator, true, "allowlisted email is an operator");

  const saved = { small: config.modelSmall };
  try {
    const r = await postJson("/api/config", { modelSmall: "operator-set-model" }, auth(opTok));
    assert.equal(r.status, 200, "an operator's save succeeds");
    assert.equal(config.modelSmall, "operator-set-model");
  } finally { config.setOverrides({ modelSmall: saved.small }); config.clearOverrides(); }

  // a role claim works too (for projects that put roles on the JWT)
  const roleTok = jwtFor(T.id, { email: "someone@else.com", role: "operator" });
  const me2 = await (await fetch(base + "/api/me", { headers: auth(roleTok) })).json();
  assert.equal(me2.isOperator, true, "a role:operator claim also grants operator");
});

test("the UI never offers a tenant a save that is guaranteed to 403", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  assert.doesNotThrow(() => new Function(js), "dashboard JS parses");

  // the misleading PANEL TITLE is gone; the two surfaces are named for what they are
  assert.ok(!/<h2>Workspace configuration<\/h2>/i.test(html), "the mislabelled panel title is gone");
  assert.ok(!/Set the provider key, models and grid region for this workspace/i.test(html), "and its misleading lead copy with it");
  assert.match(html, /Provider connection/, "per-workspace surface");
  assert.match(html, /Instance settings/, "deployment-wide surface");

  // the editable instance form is hidden by default and only revealed for an operator
  assert.match(html, /id="cfgEditable" style="display:none"/, "editable instance form starts hidden");
  assert.match(js, /ME && ME\.isOperator/, "revealed only when the identity is an operator");
  assert.match(js, /ed\.style\.display = "none"; ro\.style\.display = "block"/, "non-operators get the read-only view");

  // provider connection reuses the onboarding validate flow rather than duplicating it
  assert.match(js, /async function saveProviderKey/, "one shared validate-then-save flow");
  const uses = (js.match(/saveProviderKey\(\{/g) || []).length;
  assert.ok(uses >= 2, `both onboarding and Settings call the shared flow (found ${uses})`);

  // presets prefill the endpoint, incl. Groq
  assert.match(js, /api\.groq\.com\/openai\/v1/, "Groq preset");
  assert.match(js, /api\.openai\.com\/v1/, "OpenAI preset");
  assert.match(js, /api\.anthropic\.com/, "Anthropic preset");

  // a rejected token produces a clear message, not a silent blank panel
  assert.match(js, /function sessionExpired/, "session-expired state exists");
  assert.match(js, /SUPABASE_JWT_SECRET/, "and points the operator at the real cause");
  // write-only key: the UI shows a set-state, never the value
  assert.match(js, /Connected to/, "connection status shown");
  assert.match(js, /Key ending/, "only the last 4 are displayed");
});

test("with auth off (dev/DRY_RUN) the local user is the operator, so nothing regresses", async () => {
  config.auth.required = false;
  const me = await (await fetch(base + "/api/me")).json();
  assert.equal(me.isOperator, true, "single-tenant/dev keeps full control");
  const r = await postJson("/api/config", { modelSmall: "dev-model" });
  assert.equal(r.status, 200, "and can still save instance settings");
  config.clearOverrides();
});

// ---- auth: a verified Supabase user must resolve to a workspace ----
// Regression guard for the production 401: attachUser() was never called, Supabase never
// sets app_metadata.tenant_id, so every correctly-signed token resolved to no tenant.
test("a real Supabase token (no tenant_id claim) resolves to that user's own workspace", async () => {
  const sub = "8f2b1c44-0000-4444-9999-1a2b3c4d5e6f";
  const h = b64({ alg: "HS256", typ: "JWT", kid: "abc-123" });           // Supabase adds a kid even on HS256
  const p = b64({ iss: "https://proj.supabase.co/auth/v1", aud: "authenticated", sub,
    email: "you@company.com", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600,
    app_metadata: { provider: "email", providers: ["email"] } });        // NOTE: no tenant_id
  const tok = `${h}.${p}.${crypto.createHmac("sha256", config.auth.jwtSecret).update(h + "." + p).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

  const r = await fetch(base + "/api/me", { headers: auth(tok) });
  assert.equal(r.status, 200, "a verified user is no longer 401'd for having no tenant claim");
  const me = await r.json();
  assert.equal(me.tenant.id, sub, "one user = one workspace, derived from their Supabase id");
  assert.equal(me.user.email, "you@company.com");
});

test("the derived workspace is STABLE across restarts and isolated per user", () => {
  const subA = "8f2b1c44-0000-4444-9999-1a2b3c4d5e6f";
  const subB = "11111111-2222-3333-4444-555555555555";
  const first = tenancy.tenantIdForUser(subA);
  tenancy.reset();                                   // simulate a process restart
  assert.equal(tenancy.tenantIdForUser(subA), first, "same user -> same workspace after restart (data survives)");
  assert.notEqual(tenancy.tenantIdForUser(subB), first, "different users get different workspaces");
  // a non-UUID subject still yields a valid, stable UUID for the tenant_id column / RLS
  const derived = tenancy.tenantIdForUser("auth0|abc123");
  assert.match(derived, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "valid UUID shape");
  assert.equal(tenancy.tenantIdForUser("auth0|abc123"), derived, "and deterministic");
});

test("an explicit tenant claim still wins, so teams keep working later", async () => {
  const team = "99999999-8888-7777-6666-555555555555";
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({ sub: "aaaaaaaa-0000-0000-0000-000000000001", email: "member@team.com",
    app_metadata: { tenant_id: team }, exp: Math.floor(Date.now() / 1000) + 3600 });
  const tok = `${h}.${p}.${crypto.createHmac("sha256", config.auth.jwtSecret).update(h + "." + p).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
  const me = await (await fetch(base + "/api/me", { headers: auth(tok) })).json();
  assert.equal(me.tenant.id, team, "an explicit team mapping takes precedence over the derived one");
});

test("auth diagnostics report the precise reason and never leak the token or secret", () => {
  const d = tenancy.diagnoseJwt("Bearer " + "x".repeat(40));
  assert.equal(d.present, true);
  assert.equal(d.tokenLength, 40, "length only — never the token");
  assert.equal(d.reason, "not_a_three_part_jwt");
  const dump = JSON.stringify(tenancy.diagnoseJwt("Bearer aaa.bbb.ccc"));
  assert.ok(!dump.includes(config.auth.jwtSecret), "the secret value is never included");
  assert.ok(!dump.includes("aaa.bbb.ccc"), "the token is never included");
  assert.equal(tenancy.diagnoseJwt(null).reason, "no_authorization_header");
});

// ---- issuer / audience validation ----
// A valid signature only proves "someone with this secret signed it" — not that OUR
// project issued it. These lock the cross-project-reuse hole shut.
const mkTok = (claims) => {
  const h = b64({ alg: "HS256", typ: "JWT" }), p = b64(claims);
  return `${h}.${p}.${crypto.createHmac("sha256", config.auth.jwtSecret).update(h + "." + p).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
};
const baseClaims = (over = {}) => ({
  iss: "https://ours.supabase.co/auth/v1", aud: "authenticated",
  sub: "8f2b1c44-0000-4444-9999-1a2b3c4d5e6f", email: "you@company.com",
  role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, ...over
});

test("a correctly-signed token from ANOTHER Supabase project is rejected", async () => {
  const saved = config.auth.supabaseUrl;
  config.auth.supabaseUrl = "https://ours.supabase.co";
  try {
    // ours: accepted
    assert.equal((await fetch(base + "/api/me", { headers: auth(mkTok(baseClaims())) })).status, 200, "our own project's token works");

    // same secret, DIFFERENT project — signature is perfectly valid, issuer is not ours
    const foreign = mkTok(baseClaims({ iss: "https://someone-else.supabase.co/auth/v1" }));
    assert.equal((await fetch(base + "/api/me", { headers: auth(foreign) })).status, 401, "a foreign issuer is refused");
    assert.equal(tenancy.diagnoseJwt("Bearer " + foreign).reason, "issuer_mismatch_token_from_a_different_project");

    // wrong audience (e.g. a service token, not a user session)
    const wrongAud = mkTok(baseClaims({ aud: "some-other-audience" }));
    assert.equal((await fetch(base + "/api/me", { headers: auth(wrongAud) })).status, 401, "a token minted for another audience is refused");
    assert.match(tenancy.diagnoseJwt("Bearer " + wrongAud).reason, /audience_mismatch/);

    // an aud ARRAY containing ours is still valid (spec allows either shape)
    assert.equal((await fetch(base + "/api/me", { headers: auth(mkTok(baseClaims({ aud: ["authenticated", "other"] }))) })).status, 200, "array aud accepted");

    // a trailing slash on SUPABASE_URL must not break a legitimate token
    config.auth.supabaseUrl = "https://ours.supabase.co/";
    assert.equal((await fetch(base + "/api/me", { headers: auth(mkTok(baseClaims())) })).status, 200, "trailing slash tolerated");
  } finally { config.auth.supabaseUrl = saved; }
});

test("iss/aud are only enforced when SUPABASE_URL is configured (dev stays usable)", async () => {
  const saved = config.auth.supabaseUrl;
  config.auth.supabaseUrl = "";                      // unconfigured => nothing to compare against
  try {
    const noIss = mkTok({ sub: "8f2b1c44-0000-4444-9999-1a2b3c4d5e6f", exp: Math.floor(Date.now() / 1000) + 3600 });
    assert.equal((await fetch(base + "/api/me", { headers: auth(noIss) })).status, 200, "a token without iss/aud still works when we have no expectation");
  } finally { config.auth.supabaseUrl = saved; }
});

// ---- identity durability ----
// Regression guard: api_keys/tenant_secrets existed only in the migration — nothing read or
// wrote them — so every minted key and every encrypted provider key died on restart.
test("minted keys and provider secrets SURVIVE a restart (hydrated from the durable store)", async () => {
  const rows = { tenants: [], apiKeys: [], secrets: [], users: [] };
  // a fake durable handle standing in for pgstore: records the write-throughs, replays them back
  const fake = {
    loadIdentity: async () => rows,
    persistTenant: (id, name) => rows.tenants.push({ id, name }),
    persistUser: (id, tenant_id, email) => rows.users.push({ id, tenant_id, email }),
    persistApiKey: (rec, key_hash) => rows.apiKeys.push({ id: rec.id, tenant_id: rec.tenantId, key_hash, last4: rec.last4, name: rec.name, revoked: false, created_at: new Date() }),
    persistRevokeKey: (id) => { const k = rows.apiKeys.find((x) => x.id === id); if (k) k.revoked = true; },
    persistTenantSecret: (tenant_id, blob) => { rows.secrets = rows.secrets.filter((s) => s.tenant_id !== tenant_id); if (blob) rows.secrets.push({ tenant_id, upstream_key_enc: blob }); }
  };
  try {
    tenancy.usePersistence(fake);
    const T = tenancy.createTenant("durable-co");
    const minted = tenancy.mintKey(T.id, "prod");
    tenancy.setUpstreamKey(T.id, "sk-provider-value");
    assert.equal(tenancy.resolveFromApiKey("Bearer " + minted.key).id, T.id, "key works before restart");

    // --- simulate a process restart: wipe the in-memory cache, hydrate from the store ---
    tenancy.reset();
    assert.equal(tenancy.resolveFromApiKey("Bearer " + minted.key), null, "cache really was cleared");
    tenancy.usePersistence(fake);
    const h = await tenancy.hydrate();
    assert.ok(h.keys >= 1 && h.secrets >= 1, "identity was loaded back");

    assert.equal(tenancy.resolveFromApiKey("Bearer " + minted.key).id, T.id, "the SAME key still authenticates after a restart");
    assert.equal(tenancy.getUpstreamKey(T.id), "sk-provider-value", "the encrypted provider key decrypts after a restart");
    assert.equal(tenancy.listKeys(T.id)[0].last4, minted.last4, "key metadata survived");

    // revocation is durable too — a revoked key must not come back to life on restart
    tenancy.revokeKey(minted.id);
    tenancy.reset(); tenancy.usePersistence(fake); await tenancy.hydrate();
    assert.equal(tenancy.resolveFromApiKey("Bearer " + minted.key), null, "a revoked key stays revoked across a restart");
  } finally { tenancy.usePersistence(null); tenancy.reset(); }
});

test("the provider key is persisted ENCRYPTED, never as plaintext", () => {
  let stored = null;
  try {
    tenancy.usePersistence({ persistTenantSecret: (_t, blob) => { stored = blob; }, persistTenant() {}, persistApiKey() {}, persistUser() {} });
    const T = tenancy.createTenant("enc");
    tenancy.setUpstreamKey(T.id, "sk-plaintext-must-not-appear");
    assert.ok(stored && stored.iv && stored.tag && stored.data, "an AES-256-GCM blob is what gets written");
    assert.ok(!JSON.stringify(stored).includes("sk-plaintext-must-not-appear"), "plaintext never reaches the database");
  } finally { tenancy.usePersistence(null); tenancy.reset(); }
});

test("identity persistence failures never throw into a request", () => {
  try {
    tenancy.usePersistence({ persistTenant() { throw new Error("db down"); }, persistApiKey() { throw new Error("db down"); } });
    const T = tenancy.createTenant("outage");           // must not throw
    const k = tenancy.mintKey(T.id, "k");               // must not throw
    assert.ok(k.key, "the key is still minted and usable in-memory during a DB outage");
    assert.equal(tenancy.resolveFromApiKey("Bearer " + k.key).id, T.id);
  } finally { tenancy.usePersistence(null); tenancy.reset(); }
});
