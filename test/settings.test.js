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
