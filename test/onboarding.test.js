"use strict";
// Phase 1.2 — self-serve onboarding, end to end. A brand-new tenant completes all three
// steps and sees a REAL first metered request, with no manual DB setup and no help from us.
process.env.DRY_RUN = "true";
process.env.ROUTING_ENABLED = "true";
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
const bearer = (k) => ({ authorization: "Bearer " + k });
const jsonPost = (url, body, headers) => fetch(base + url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body || {}) });
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function makeJwt(payload, secret) {
  const h = b64url({ alg: "HS256", typ: "JWT" }), p = b64url(payload);
  const sig = crypto.createHmac("sha256", secret).update(h + "." + p).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${h}.${p}.${sig}`;
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "joule-onb-"));
  store.init(tmpDir); require("../src/calibrate").setDir(tmpDir);
  verify.reset(); budget.reset();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  config.auth.required = false; config.auth.jwtSecret = ""; upstream.setFetch(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => { tenancy.reset(); store.clear(); budget.reset(); config.auth.required = true; config.auth.jwtSecret = "onb-secret"; upstream.setFetch(null); });

// a signed-in brand-new user (fresh tenant, nothing configured)
function newUser(name) {
  const t = tenancy.createTenant(name || "fresh");
  const jwt = makeJwt({ sub: "u-" + t.id.slice(0, 8), email: "new@user.test", app_metadata: { tenant_id: t.id }, exp: Math.floor(Date.now() / 1000) + 3600 }, config.auth.jwtSecret);
  return { tenant: t, jwt, auth: bearer(jwt) };
}

test("E2E: brand-new user completes all 3 steps and sees a real first metered request", async () => {
  const u = newUser("acme");

  // --- lands in an empty workspace: nothing done, no fabricated data ---
  const me0 = await (await fetch(base + "/api/me", { headers: u.auth })).json();
  assert.deepEqual(me0.onboarding.steps, { providerKey: false, jouleKey: false, firstRequest: false }, "all three steps outstanding");
  assert.equal(me0.onboarding.complete, false);
  assert.equal(me0.onboarding.requests, 0);
  assert.deepEqual(me0.keys, [], "no keys yet");
  assert.match(me0.endpoint, /^http:\/\/localhost:\d+\/v1$/, "exact baseURL for their SDK is prefilled");

  // --- STEP 1: add provider key (validated with a real lightweight call) ---
  upstream.setFetch(async (url, opts) => {
    assert.match(String(url), /\/models$/, "validation uses the cheap GET /models probe");
    assert.equal(opts.headers.authorization, "Bearer sk-good-key");
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  });
  const s1 = await jsonPost("/api/provider-key", { apiKey: "sk-good-key" }, u.auth);
  assert.equal(s1.status, 200);
  const s1b = await s1.json();
  assert.equal(s1b.valid, true);
  assert.equal(s1b.last4, "-key");
  assert.equal(s1b.onboarding.steps.providerKey, true, "step 1 ticks green");
  upstream.setFetch(null);

  // the key is stored ENCRYPTED and never readable back over the API
  const cfgTxt = JSON.stringify(await (await fetch(base + "/api/me", { headers: u.auth })).json());
  assert.ok(!cfgTxt.includes("sk-good-key"), "the provider key is never returned by the API");
  assert.equal(tenancy.getUpstreamKey(u.tenant.id), "sk-good-key", "server-side it decrypts for real calls");

  // --- STEP 2: mint the Joule key (shown once) ---
  const s2 = await jsonPost("/api/keys", { name: "prod app" }, u.auth);
  assert.equal(s2.status, 201);
  const minted = await s2.json();
  assert.ok(minted.key.startsWith(config.auth.keyPrefix), "plaintext Joule key returned once");
  assert.equal(minted.onboarding.steps.jouleKey, true, "step 2 ticks green");
  // listing keys NEVER returns the plaintext again
  const listed = await (await fetch(base + "/api/keys", { headers: u.auth })).json();
  assert.equal(listed.keys.length, 1);
  assert.ok(!JSON.stringify(listed).includes(minted.key), "plaintext is never shown again — only last4");
  assert.equal(listed.keys[0].last4, minted.last4);

  // --- STEP 3: their own app sends a request with the Joule key ---
  const waiting = await (await fetch(base + "/api/onboarding", { headers: u.auth })).json();
  assert.equal(waiting.steps.firstRequest, false, "still waiting for the first request");
  assert.equal(waiting.firstRequest, null, "nothing fabricated while waiting");

  const call = await jsonPost("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "summarise this in one line" }] }, bearer(minted.key));
  assert.equal(call.status, 200, "their Joule key authenticates the OpenAI-compatible call");

  // --- ACTIVATION MOMENT: auto-detected, real numbers only ---
  const done = await (await fetch(base + "/api/onboarding", { headers: u.auth })).json();
  assert.equal(done.steps.firstRequest, true, "auto-detected the incoming request");
  assert.equal(done.complete, true, "onboarding complete — all three steps done");
  assert.equal(done.requests, 1);
  const fr = done.firstRequest;
  assert.ok(fr, "the first request is surfaced for the celebration");
  assert.ok(fr.model && fr.tier, "shows what it routed to");
  assert.ok(fr.costUsd >= 0 && fr.totalTokens > 0, "real metered cost + tokens");
  assert.equal(fr.qualityScore, null, "quality is 'pending verification', never a fake score");
});

test("provider-key validation accepts a good key and clearly rejects a bad one", async () => {
  const u = newUser();
  // bad key -> provider 401 -> clean, actionable message; nothing stored
  upstream.setFetch(async () => ({ ok: false, status: 401, json: async () => ({ error: { message: "invalid_api_key" } }) }));
  const bad = await jsonPost("/api/provider-key", { apiKey: "sk-bad" }, u.auth);
  assert.equal(bad.status, 400);
  const badBody = await bad.json();
  assert.equal(badBody.valid, false);
  assert.match(badBody.message, /rejected this key/i, "tells the user what's wrong in plain English");
  assert.equal(tenancy.getUpstreamKey(u.tenant.id), null, "a rejected key is NOT stored");

  // unreachable provider -> distinct message, still no storage
  upstream.setFetch(async () => { throw new Error("getaddrinfo ENOTFOUND"); });
  const down = await jsonPost("/api/provider-key", { apiKey: "sk-x" }, u.auth);
  assert.match((await down.json()).message, /could not reach the provider/i);
  assert.equal(tenancy.getUpstreamKey(u.tenant.id), null);

  // empty submission -> asks for the key, no provider call at all
  const empty = await jsonPost("/api/provider-key", { apiKey: "  " }, u.auth);
  assert.equal(empty.status, 400);
  assert.match((await empty.json()).message, /paste your provider api key/i);

  // good key -> stored
  upstream.setFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }));
  assert.equal((await jsonPost("/api/provider-key", { apiKey: "sk-good" }, u.auth)).status, 200);
  assert.equal(tenancy.getUpstreamKey(u.tenant.id), "sk-good");
});

test("the tenant's OWN provider key is used for their live calls (not a global key)", async () => {
  const A = newUser("A"), B = newUser("B");
  tenancy.setUpstreamKey(A.tenant.id, "sk-tenant-A");
  tenancy.setUpstreamKey(B.tenant.id, "sk-tenant-B");
  const keyA = tenancy.mintKey(A.tenant.id).key, keyB = tenancy.mintKey(B.tenant.id).key;

  const seen = [];
  config.setOverrides({ dryRun: false, upstreamApiKey: "sk-GLOBAL-should-not-be-used", upstreamBaseUrl: "http://provider.test" });
  upstream.setFetch(async (_u, opts) => {
    seen.push(opts.headers.authorization);
    return { ok: true, status: 200, json: async () => ({ choices: [{ index: 0, message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }) };
  });
  try {
    await jsonPost("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hi from A" }] }, bearer(keyA));
    await jsonPost("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hi from B" }] }, bearer(keyB));
  } finally { config.clearOverrides(); upstream.setFetch(null); }

  assert.deepEqual(seen, ["Bearer sk-tenant-A", "Bearer sk-tenant-B"], "each tenant's call used THEIR key");
  assert.ok(!seen.some((h) => h.includes("GLOBAL")), "the global env key was never used for a tenant call");
});

test("keys are tenant-scoped: you cannot list or revoke another workspace's key", async () => {
  const A = newUser("A"), B = newUser("B");
  const mintedA = await (await jsonPost("/api/keys", { name: "A key" }, A.auth)).json();

  const bList = await (await fetch(base + "/api/keys", { headers: B.auth })).json();
  assert.deepEqual(bList.keys, [], "B sees none of A's keys");

  const steal = await jsonPost(`/api/keys/${mintedA.id}/revoke`, {}, B.auth);
  assert.equal(steal.status, 404, "B cannot revoke A's key");
  assert.equal(tenancy.resolveFromApiKey("Bearer " + mintedA.key).id, A.tenant.id, "A's key still works");

  // the owner can revoke it, and it immediately stops authenticating
  assert.equal((await jsonPost(`/api/keys/${mintedA.id}/revoke`, {}, A.auth)).status, 200);
  const after = await jsonPost("/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "x" }] }, bearer(mintedA.key));
  assert.equal(after.status, 401, "a revoked key is rejected");
});

test("one workspace cannot rewrite deployment-wide config (incl. the global provider key)", async () => {
  const u = newUser();
  const attempt = await jsonPost("/api/config", { upstreamApiKey: "sk-hijack" }, u.auth);
  assert.equal(attempt.status, 403, "global config writes are refused in multi-tenant mode");
  assert.equal((await attempt.json()).error.code, "global_config_forbidden");
});

test("/api/auth-config is public pre-auth and exposes only the browser-safe values", async () => {
  const saved = { url: config.auth.supabaseUrl, anon: config.auth.supabaseAnonKey, secret: config.auth.jwtSecret };
  config.auth.supabaseUrl = "https://proj.supabase.co";
  config.auth.supabaseAnonKey = "anon-public-key";
  config.auth.jwtSecret = "SUPER-SECRET-JWT";
  try {
    const r = await fetch(base + "/api/auth-config");   // NO Authorization header
    assert.equal(r.status, 200, "reachable before sign-in, or the login screen can't load");
    const body = await r.json();
    assert.equal(body.supabaseUrl, "https://proj.supabase.co");
    assert.equal(body.supabaseAnonKey, "anon-public-key", "anon key is public by design");
    assert.equal(body.authRequired, true);
    const txt = JSON.stringify(body);
    assert.ok(!txt.includes("SUPER-SECRET-JWT"), "the JWT signing secret is NEVER exposed to the browser");
    assert.ok(!txt.includes("service_role"), "no service-role key");
  } finally { config.auth.supabaseUrl = saved.url; config.auth.supabaseAnonKey = saved.anon; config.auth.jwtSecret = saved.secret; }
});

test("dashboard HTML wires auth + onboarding correctly (no client-side secret storage)", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  // every inline script must parse — a syntax error here silently bricks the whole dashboard
  assert.doesNotThrow(() => new Function(js), "dashboard JS parses");
  // CONSTRAINT: no browser storage of anything security-related. Strip comments first so
  // this asserts on real CODE (a comment mentioning localStorage is not a violation).
  const code = js.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(code), "token is never persisted to browser storage");
  assert.match(js, /let ACCESS_TOKEN = null/, "token held in memory only");
  // the wizard + activation path exists and is driven by the real endpoints
  for (const ep of ["/api/auth-config", "/api/me", "/api/onboarding", "/api/provider-key", "/api/keys"]) {
    assert.ok(js.includes(ep), `dashboard calls ${ep}`);
  }
  // all three SDK snippets are offered
  for (const marker of ["baseURL:", "base_url=", "curl "]) assert.ok(js.includes(marker), `snippet ${marker} present`);
});

test("empty states: a workspace with no data reports zeros honestly, never fabricated", async () => {
  const u = newUser();
  const stats = await (await fetch(base + "/api/stats", { headers: u.auth })).json();
  assert.equal(stats.totals.requests, 0, "no requests");
  assert.equal(stats.quality.score, null, "quality is NULL, not a fake 100%");
  assert.equal(stats.quality.guaranteeReady, false, "no guarantee claimed with no data");
  assert.deepEqual(stats.recent, [], "no invented log rows");

  const roi = await (await fetch(base + "/api/roi", { headers: u.auth })).json();
  assert.equal(roi.empty, true, "ROI reports an explicit empty state");
  assert.equal(roi.lifetime, null, "no fabricated lifetime savings");
});
