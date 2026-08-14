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
const post = (body, headers = {}) => fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

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

// ---- §8 Profile: account settings ----
const pfTok = () => { const T = tenancy.createTenant("pf"); return { T, tok: jwtFor(T.id, { email: "me@co.com" }) }; };

test("email change is gated by a SERVER-side 30-day cooldown", async () => {
  const { T, tok } = pfTok();
  const uid = "u-" + T.id.slice(0, 6);   // jwtFor builds sub this way

  const first = await postJson("/api/profile/email-change", {}, auth(tok));
  assert.equal(first.status, 200, "first change is permitted");
  assert.equal((await first.json()).allowed, true);

  // confirm it happened -> the clock starts
  const rec = await postJson("/api/profile/email-change", { confirm: true }, auth(tok));
  assert.equal((await rec.json()).ok, true);

  // a second attempt inside the window is REFUSED by the server, with the date
  const second = await postJson("/api/profile/email-change", {}, auth(tok));
  assert.equal(second.status, 429, "blocked inside the cooldown");
  const body = await second.json();
  assert.equal(body.allowed, false);
  assert.ok(body.daysRemaining > 0 && body.daysRemaining <= 30);
  assert.match(body.message, /You can change your email again on/);

  // and the state is reflected on /api/profile
  const prof = await (await fetch(base + "/api/profile", { headers: auth(tok) })).json();
  assert.equal(prof.emailChange.allowed, false);
  assert.equal(prof.emailChange.cooldownDays, 30);
  assert.equal(tenancy.emailChangeState(uid).allowed, false, "cooldown is keyed to the user");
});

test("the server never handles passwords, and states billing honestly", async () => {
  const { tok } = pfTok();
  const prof = await (await fetch(base + "/api/profile", { headers: auth(tok) })).json();
  // no password field anywhere in the account payload
  assert.ok(!/password/i.test(JSON.stringify(prof)), "no password is stored or returned");
  // billing is not faked
  assert.equal(prof.subscription.billingConfigured, false);
  assert.match(prof.subscription.note, /isn't connected/i);
  // the UI performs email/password changes against the managed provider, not our server
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  assert.match(js, /auth\/v1\/user/, "changes go through the auth provider's endpoint");
  assert.match(js, /grant_type=password/, "current password is re-authenticated before a change");
  assert.match(js, /never sees or stores it/i, "and the UI says so");
});

test("logo upload validates type and size, and is tenant-scoped", async () => {
  const { T, tok } = pfTok();
  const png = "data:image/png;base64," + Buffer.from("fake-png-bytes").toString("base64");

  assert.equal((await postJson("/api/profile/logo", { dataUrl: "not-an-image" }, auth(tok))).status, 400, "rejects non-images");
  assert.equal((await postJson("/api/profile/logo", { dataUrl: "data:application/pdf;base64,AAAA" }, auth(tok))).status, 400, "rejects disallowed types");
  const huge = "data:image/png;base64," + "A".repeat(400 * 1024);
  assert.equal((await postJson("/api/profile/logo", { dataUrl: huge }, auth(tok))).status, 413, "rejects oversized images");

  assert.equal((await postJson("/api/profile/logo", { dataUrl: png }, auth(tok))).status, 200, "accepts a valid PNG");
  assert.equal(tenancy.getLogo(T.id), png, "stored for this tenant");

  // another workspace does not inherit it
  const other = tenancy.createTenant("other");
  assert.equal(tenancy.getLogo(other.id), null, "logo is tenant-scoped");

  // and it is exposed for the sidebar, then removable
  const me = await (await fetch(base + "/api/me", { headers: auth(tok) })).json();
  assert.equal(me.branding.logo, png);
  await fetch(base + "/api/profile/logo", { method: "DELETE", headers: auth(tok) });
  assert.equal(tenancy.getLogo(T.id), null, "removable, falls back to the Joule mark");
});

test("account deletion requires typed confirmation and removes everything for that tenant only", async () => {
  const A = tenancy.createTenant("gone"), B = tenancy.createTenant("stays");
  const tokA = jwtFor(A.id, { email: "a@co.com" });
  const keyA = tenancy.mintKey(A.id, "k").key, keyB = tenancy.mintKey(B.id, "k").key;
  tenancy.setUpstreamKey(A.id, "sk-a"); tenancy.setUpstreamKey(B.id, "sk-b");
  for (let i = 0; i < 3; i++) await post({ model: "auto", messages: [{ role: "user", content: "a" + i }] }, auth(keyA));
  await post({ model: "auto", messages: [{ role: "user", content: "b" }] }, auth(keyB));

  // wrong confirmation is refused
  assert.equal((await postJson("/api/profile/delete", { confirm: "yes" }, auth(tokA))).status, 400);
  assert.equal(store.all(A.id).length, 3, "nothing deleted without the typed confirmation");

  const del = await postJson("/api/profile/delete", { confirm: "DELETE", reason: "Too expensive" }, auth(tokA));
  assert.equal(del.status, 200);
  const d = await del.json();
  assert.equal(d.removedRecords, 3, "A's request log is gone");
  assert.ok(d.revokedKeys >= 1, "A's keys are gone");
  assert.match(d.authAccountNote, /authentication provider/i, "honest about what we cannot delete");

  assert.equal(store.all(A.id).length, 0, "A has no records left");
  assert.equal(tenancy.getUpstreamKey(A.id), null, "A's provider key is gone");
  assert.equal(tenancy.resolveFromApiKey("Bearer " + keyA), null, "A's key no longer authenticates");

  // B is completely untouched
  assert.equal(store.all(B.id).length, 1, "B's data survives");
  assert.equal(tenancy.getUpstreamKey(B.id), "sk-b", "B's provider key survives");
  assert.equal(tenancy.resolveFromApiKey("Bearer " + keyB).id, B.id, "B's key still works");
});

// ---- provider key: stored-but-undecryptable must not masquerade as "never configured" ----
// This is why the setup wizard reappeared on every login for a configured workspace: the
// decrypt failure returned null, which onboarding read as "no provider key".
test("a key that cannot be decrypted reports 'unreadable', not 'none'", async () => {
  const T = tenancy.createTenant("enc-rot");
  const tok = jwtFor(T.id, { email: "e@co.com" });
  const savedEnc = config.auth.encKey;
  try {
    config.auth.encKey = "original-encryption-key";
    tenancy.setUpstreamKey(T.id, "sk-provider-abc");
    assert.equal(tenancy.providerKeyState(T.id), "ok");
    assert.equal(tenancy.getUpstreamKey(T.id), "sk-provider-abc");

    // the operator rotates JOULE_ENC_KEY — the ciphertext is now undecryptable
    config.auth.encKey = "a-different-encryption-key";
    assert.equal(tenancy.getUpstreamKey(T.id), null, "it genuinely cannot be used");
    assert.equal(tenancy.providerKeyState(T.id), "unreadable", "but it is NOT 'none' — a key IS stored");

    // onboarding says so, so the UI can explain instead of silently restarting setup
    const me = await (await fetch(base + "/api/me", { headers: auth(tok) })).json();
    assert.equal(me.onboarding.providerKeyState, "unreadable");
    assert.equal(me.onboarding.steps.providerKey, false, "still blocks completion — it must be re-entered");
    assert.equal(me.provider.state, "unreadable");
    assert.ok(!JSON.stringify(me).includes("sk-provider-abc"), "the key is still never returned");

    // re-entering a key clears the condition
    config.auth.encKey = "a-different-encryption-key";
    tenancy.setUpstreamKey(T.id, "sk-provider-new");
    assert.equal(tenancy.providerKeyState(T.id), "ok");
    assert.equal(tenancy.getUpstreamKey(T.id), "sk-provider-new");
  } finally { config.auth.encKey = savedEnc; }
});

test("a workspace that never set a key reports 'none' (genuine first-time setup)", async () => {
  const T = tenancy.createTenant("fresh-ws");
  assert.equal(tenancy.providerKeyState(T.id), "none");
  const me = await (await fetch(base + "/api/me", { headers: auth(jwtFor(T.id, { email: "f@co.com" })) })).json();
  assert.equal(me.onboarding.providerKeyState, "none");
});

// ---- encryption-key rotation must never orphan a stored provider key ----
test("a secret encrypted under an OLDER key is recovered and re-encrypted, not lost", async () => {
  const saved = { cur: config.auth.encKey, prev: config.auth.encKeyPrevious };
  try {
    // 1. stored while JOULE_ENC_KEY was UNSET (the built-in default) — the common real case
    config.auth.encKey = ""; config.auth.encKeyPrevious = "";
    const T = tenancy.createTenant("rotate");
    tenancy.setUpstreamKey(T.id, "sk-original");
    assert.equal(tenancy.providerKeyState(T.id), "ok");

    // 2. the operator now SETS JOULE_ENC_KEY and redeploys
    config.auth.encKey = "newly-set-encryption-key";
    assert.equal(tenancy.getUpstreamKey(T.id), "sk-original", "the key is recovered, not orphaned");
    assert.equal(tenancy.providerKeyState(T.id), "ok", "and no longer reports 'unreadable'");

    // 3. it was re-encrypted under the NEW key, so removing the fallback keeps it working
    config.auth.encKeyPrevious = "";
    assert.equal(tenancy.getUpstreamKey(T.id), "sk-original", "rotation completed itself");

    // 4. an explicit rotation via JOULE_ENC_KEY_PREVIOUS also recovers
    config.auth.encKeyPrevious = "newly-set-encryption-key";
    config.auth.encKey = "second-rotation-key";
    assert.equal(tenancy.getUpstreamKey(T.id), "sk-original", "previous-key rotation recovers");
    config.auth.encKeyPrevious = "";
    assert.equal(tenancy.getUpstreamKey(T.id), "sk-original", "and completes itself again");
  } finally { config.auth.encKey = saved.cur; config.auth.encKeyPrevious = saved.prev; }
});

test("a secret encrypted under a key we no longer have is reported, never silently 'none'", () => {
  const saved = { cur: config.auth.encKey, prev: config.auth.encKeyPrevious };
  try {
    config.auth.encKey = "key-A"; config.auth.encKeyPrevious = "";
    const T = tenancy.createTenant("lost");
    tenancy.setUpstreamKey(T.id, "sk-lost");
    // rotate twice with no JOULE_ENC_KEY_PREVIOUS — the original key is genuinely gone
    config.auth.encKey = "key-B";
    assert.equal(tenancy.getUpstreamKey(T.id), null);
    assert.equal(tenancy.providerKeyState(T.id), "unreadable", "stored but unreadable — NOT 'none'");
    // and naming the old key recovers it
    config.auth.encKeyPrevious = "key-A";
    assert.equal(tenancy.getUpstreamKey(T.id), "sk-lost", "JOULE_ENC_KEY_PREVIOUS recovers it");
  } finally { config.auth.encKey = saved.cur; config.auth.encKeyPrevious = saved.prev; }
});

// ---- session: httpOnly refresh cookie ----
test("the refresh cookie is httpOnly, SameSite=Strict and path-scoped", async () => {
  const savedUrl = config.auth.supabaseUrl, savedAnon = config.auth.supabaseAnonKey;
  const realFetch = global.fetch;
  try {
    config.auth.supabaseUrl = "https://proj.supabase.co";
    config.auth.supabaseAnonKey = "anon";
    // stub the auth provider's refresh exchange
    global.fetch = async (url, opts) => {
      if (String(url).includes("/auth/v1/token")) {
        const body = JSON.parse(opts.body);
        if (body.refresh_token === "good-rt") {
          return { ok: true, status: 200, json: async () => ({ access_token: "fresh-at", refresh_token: "rotated-rt", expires_in: 3600 }) };
        }
        return { ok: false, status: 400, json: async () => ({}) };
      }
      return realFetch(url, opts);
    };

    const r = await realFetch(base + "/api/auth/session", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh_token: "good-rt" })
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.access_token, "fresh-at", "the access token comes back for in-memory use");
    assert.ok(!("refresh_token" in body), "the refresh token is NEVER returned to the browser");

    const cookie = r.headers.get("set-cookie") || "";
    assert.match(cookie, /joule_rt=/, "session cookie is set");
    assert.match(cookie, /HttpOnly/i, "httpOnly — script cannot read it");
    assert.match(cookie, /SameSite=Strict/i, "SameSite=Strict — closes the CSRF hole a cookie opens");
    assert.match(cookie, /Path=\/api\/auth/i, "scoped to the session endpoints only");
    assert.match(cookie, /rotated-rt/, "stores the ROTATED token the provider returned");

    // refresh with the cookie yields a new access token and rotates the cookie
    const rt = /joule_rt=([^;]+)/.exec(cookie)[1];
    const ref = await realFetch(base + "/api/auth/refresh", { method: "POST", headers: { cookie: "joule_rt=" + rt } });
    assert.equal(ref.status, 401, "a rotated-away token is no longer accepted by the provider stub");

    // without a cookie there is no session at all
    const none = await realFetch(base + "/api/auth/refresh", { method: "POST" });
    assert.equal(none.status, 401);
    assert.match((await none.json()).message, /no session/i);

    // logout expires the cookie
    const out = await realFetch(base + "/api/auth/logout", { method: "POST" });
    assert.match(out.headers.get("set-cookie") || "", /Max-Age=0/, "logout expires the cookie");
  } finally {
    global.fetch = realFetch;
    config.auth.supabaseUrl = savedUrl; config.auth.supabaseAnonKey = savedAnon;
  }
});

test("a junk refresh token is verified and refused before any cookie is stored", async () => {
  const savedUrl = config.auth.supabaseUrl, savedAnon = config.auth.supabaseAnonKey;
  const realFetch = global.fetch;
  try {
    config.auth.supabaseUrl = "https://proj.supabase.co"; config.auth.supabaseAnonKey = "anon";
    global.fetch = async (url, opts) => String(url).includes("/auth/v1/token")
      ? { ok: false, status: 400, json: async () => ({}) } : realFetch(url, opts);
    const r = await realFetch(base + "/api/auth/session", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh_token: "junk" })
    });
    assert.equal(r.status, 401, "unverifiable session refused");
    assert.match(r.headers.get("set-cookie") || "", /Max-Age=0/, "and no live cookie is left behind");
  } finally { global.fetch = realFetch; config.auth.supabaseUrl = savedUrl; config.auth.supabaseAnonKey = savedAnon; }
});

test("the browser stores NO credential of any kind", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  const code = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/localStorage/.test(code), "no localStorage");
  assert.ok(!/sessionStorage/.test(code), "no sessionStorage");
  assert.ok(!/document\.cookie/.test(code), "the page never reads or writes cookies itself");
  assert.match(code, /let ACCESS_TOKEN = null/, "only the short-lived access token, in memory");
  assert.match(code, /credentials: "same-origin"/, "the httpOnly cookie rides on same-origin requests");
  assert.match(code, /\/api\/auth\/refresh/, "the session is restored from the cookie");
});
