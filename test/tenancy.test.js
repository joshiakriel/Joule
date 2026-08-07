"use strict";
// Phase 1.1 Step 1 — authentication + proxy-path tenant isolation. DRY_RUN, offline.
// Headline: a customer Joule key resolves to a tenant, and tenant B can NEVER receive
// tenant A's cached response. Missing/invalid key -> clean 401. Default-tenant fallback
// keeps the Phase 0 single-tenant demo + offline tests working.
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
const app = require("../src/server");

let server, base, tmpDir;
const post = (body, headers = {}) => fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const bearer = (k) => ({ authorization: "Bearer " + k });

// mint an HS256 JWT the way Supabase would (for the dashboard-auth test)
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function makeJwt(payload, secret) {
  const h = b64url({ alg: "HS256", typ: "JWT" });
  const p = b64url(payload);
  const sig = crypto.createHmac("sha256", secret).update(h + "." + p).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${h}.${p}.${sig}`;
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "joule-tenant-"));
  store.init(tmpDir); require("../src/calibrate").setDir(tmpDir);
  verify.reset(); budget.reset();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); config.auth.required = false; fs.rmSync(tmpDir, { recursive: true, force: true }); });
beforeEach(() => { tenancy.reset(); store.clear(); config.auth.required = false; config.auth.jwtSecret = ""; });

test("missing or invalid Joule key -> clean 401 when auth is required", async () => {
  config.auth.required = true;
  const none = await post({ model: "auto", messages: [{ role: "user", content: "no key at all" }] });
  assert.equal(none.status, 401);
  assert.equal((await none.json()).error.code, "unauthenticated");

  const bogus = await post({ model: "auto", messages: [{ role: "user", content: "bad key" }] }, bearer("jk_live_deadbeefnotreal"));
  assert.equal(bogus.status, 401, "an unknown key is rejected");
});

test("ISOLATION: tenant B can NEVER receive tenant A's cached response (exact cache)", async () => {
  config.auth.required = true;
  const A = tenancy.createTenant("tenant-A");
  const B = tenancy.createTenant("tenant-B");
  const keyA = tenancy.mintKey(A.id, "A-app").key;
  const keyB = tenancy.mintKey(B.id, "B-app").key;
  const prompt = { model: "auto", messages: [{ role: "user", content: "the exact same prompt for both tenants" }] };

  const a1 = await post(prompt, bearer(keyA));
  assert.notEqual(a1.headers.get("x-joule-mode"), "cache", "A's first call is a miss");
  const a2 = await post(prompt, bearer(keyA));
  assert.equal(a2.headers.get("x-joule-mode"), "cache", "A's identical call hits A's own cache");

  // the deliberate break attempt: B sends the byte-identical prompt
  const b1 = await post(prompt, bearer(keyB));
  assert.notEqual(b1.headers.get("x-joule-mode"), "cache", "B must NOT read A's cached answer — isolation holds");

  // records are tagged with the correct tenant, and never cross
  const aRecs = store.all().filter((r) => r.tenant === A.id);
  const bRecs = store.all().filter((r) => r.tenant === B.id);
  assert.ok(aRecs.length >= 2 && bRecs.length >= 1, "each tenant's requests are tagged to that tenant");
  assert.ok(aRecs.every((r) => r.tenant !== B.id) && bRecs.every((r) => r.tenant !== A.id), "no record is cross-tagged");
});

test("default-tenant fallback: no key + auth not required -> served as the default tenant", async () => {
  config.auth.required = false;
  const res = await post({ model: "auto", messages: [{ role: "user", content: "phase-0 style unauthenticated call" }] });
  assert.equal(res.status, 200);
  const rec = store.all().slice(-1)[0];
  assert.equal(rec.tenant, tenancy.DEFAULT_TENANT_ID, "tagged to the default tenant, still tenant-scoped");
});

test("batch jobs cannot be polled cross-tenant", async () => {
  config.auth.required = true;
  const A = tenancy.createTenant("A"); const B = tenancy.createTenant("B");
  const keyA = tenancy.mintKey(A.id).key; const keyB = tenancy.mintKey(B.id).key;
  const submit = await fetch(base + "/v1/batch", { method: "POST", headers: { "content-type": "application/json", ...bearer(keyA) }, body: JSON.stringify({ requests: [{ custom_id: "x", messages: [{ role: "user", content: "batch item" }] }] }) });
  assert.equal(submit.status, 202);
  const { id } = await submit.json();
  const asB = await fetch(base + "/v1/batch/" + id, { headers: bearer(keyB) });
  assert.equal(asB.status, 404, "tenant B cannot see tenant A's batch job (404, indistinguishable from missing)");
  const asA = await fetch(base + "/v1/batch/" + id, { headers: bearer(keyA) });
  assert.equal(asA.status, 200, "the owning tenant can poll it");
});

test("minted keys: shown once, resolve to their tenant, and revoke works", () => {
  const T = tenancy.createTenant("t");
  const minted = tenancy.mintKey(T.id, "app");
  assert.ok(minted.key.startsWith(config.auth.keyPrefix), "returns the plaintext key once");
  assert.equal(minted.last4, minted.key.slice(-4));
  assert.deepEqual(tenancy.resolveFromApiKey("Bearer " + minted.key), { id: T.id, keyId: minted.id });
  assert.ok(tenancy.revokeKey(minted.id));
  assert.equal(tenancy.resolveFromApiKey("Bearer " + minted.key), null, "a revoked key no longer resolves");
});

test("FULL ISOLATION via the dashboard API + per-tenant reconciliation (deliberate break attempts)", async () => {
  config.auth.required = true;
  config.auth.jwtSecret = "iso-secret";
  budget.reset();
  const A = tenancy.createTenant("A"); const B = tenancy.createTenant("B");
  const keyA = tenancy.mintKey(A.id).key; const keyB = tenancy.mintKey(B.id).key;
  const jwtA = makeJwt({ sub: "ua", app_metadata: { tenant_id: A.id }, exp: Math.floor(Date.now() / 1000) + 3600 }, config.auth.jwtSecret);
  const jwtB = makeJwt({ sub: "ub", app_metadata: { tenant_id: B.id }, exp: Math.floor(Date.now() / 1000) + 3600 }, config.auth.jwtSecret);

  // A makes 5 requests, B makes 2 — via their own Joule keys
  for (let i = 0; i < 5; i++) await post({ model: "auto", messages: [{ role: "user", content: `A request ${i}` }] }, bearer(keyA));
  for (let i = 0; i < 2; i++) await post({ model: "auto", messages: [{ role: "user", content: `B request ${i}` }] }, bearer(keyB));

  const statsA = await (await fetch(base + "/api/stats", { headers: bearer(jwtA) })).json();
  const statsB = await (await fetch(base + "/api/stats", { headers: bearer(jwtB) })).json();

  // each tenant sees ONLY its own request count — no cross-tenant totals
  assert.equal(statsA.totals.requests, 5, "A sees only A's 5 requests");
  assert.equal(statsB.totals.requests, 2, "B sees only B's 2 requests");
  assert.ok(!statsA.recent.some((r) => r.tenant === B.id), "A's recent list contains no B rows");
  assert.ok(!statsB.recent.some((r) => r.tenant === A.id), "B's recent list contains no A rows");

  // per-tenant RECONCILIATION: /api/stats == /api/report == store.aggregate(tenant), each side
  for (const [jwt, T, n] of [[jwtA, A, 5], [jwtB, B, 2]]) {
    const s = (await (await fetch(base + "/api/stats", { headers: bearer(jwt) })).json()).totals;
    const rep = (await (await fetch(base + "/api/report?format=json", { headers: bearer(jwt) })).json()).totals;
    const agg = JSON.parse(JSON.stringify(store.aggregate(store.predicateFor({ tenant: T.id }))));
    assert.equal(s.requests, n);
    assert.deepEqual(s, rep, "stats == report for the tenant");
    assert.deepEqual(s, agg, "stats == store.aggregate(tenant)");
  }

  // BUDGET isolation: A clears its data; B's is untouched
  const cleared = await (await fetch(base + "/api/clear", { method: "POST", headers: bearer(jwtA) })).json();
  assert.equal(cleared.removed, 5, "A cleared exactly its own 5 rows");
  assert.equal((await (await fetch(base + "/api/stats", { headers: bearer(jwtA) })).json()).totals.requests, 0, "A now empty");
  assert.equal((await (await fetch(base + "/api/stats", { headers: bearer(jwtB) })).json()).totals.requests, 2, "B's data survived A's clear — isolation");

  // deliberate break: A's JWT cannot be used to read B by swapping the key — the tenant is bound to the signed token
  const forgedClaim = makeJwt({ sub: "ua", app_metadata: { tenant_id: B.id }, exp: Math.floor(Date.now() / 1000) + 3600 }, "not-the-secret");
  assert.equal((await fetch(base + "/api/stats", { headers: bearer(forgedClaim) })).status, 401, "forging B's tenant_id in an unsigned token fails");
});

test("dashboard /api requires a valid Supabase JWT when auth is required", async () => {
  config.auth.required = true;
  config.auth.jwtSecret = "test-supabase-jwt-secret";
  const T = tenancy.createTenant("dash");

  const noTok = await fetch(base + "/api/stats");
  assert.equal(noTok.status, 401, "no JWT -> 401");

  const forged = makeJwt({ sub: "user-1", app_metadata: { tenant_id: T.id }, exp: Math.floor(Date.now() / 1000) + 3600 }, "WRONG-secret");
  assert.equal((await fetch(base + "/api/stats", { headers: bearer(forged) })).status, 401, "a wrongly-signed JWT is rejected");

  const valid = makeJwt({ sub: "user-1", app_metadata: { tenant_id: T.id }, exp: Math.floor(Date.now() / 1000) + 3600 }, config.auth.jwtSecret);
  assert.equal((await fetch(base + "/api/stats", { headers: bearer(valid) })).status, 200, "a correctly-signed JWT is accepted");

  // /api/health stays open (liveness)
  assert.equal((await fetch(base + "/api/health")).status, 200);
});
