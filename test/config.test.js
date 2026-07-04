"use strict";
// Offline test of the runtime-config layer. Env set BEFORE requiring src modules.
process.env.DRY_RUN = "true";
delete process.env.UPSTREAM_API_KEY;
delete process.env.ELECTRICITYMAPS_TOKEN;
delete process.env.MODEL_SMALL;
delete process.env.GRID_ZONE;

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../src/config");
const store = require("../src/store");
const app = require("../src/server");

let server, base, tmpDir;
const SECRET = "sk-supersecret-abcd1234";

const getCfg = async () => (await fetch(base + "/api/config")).json();
const postCfg = (body) =>
  fetch(base + "/api/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "joule-cfg-"));
  store.init(tmpDir);
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => config.clearOverrides()); // isolate each test from prior overrides

test("GET /api/config is masked: no raw secret, only booleans + last4 + sources", async () => {
  config.setOverrides({ upstreamApiKey: SECRET });
  const c = await getCfg();
  assert.equal(c.hasUpstreamKey, true);
  assert.equal(c.upstreamKeyLast4, "1234");
  assert.equal(c.upstreamApiKey, undefined, "raw key must not be a field");
  assert.ok(!JSON.stringify(c).includes(SECRET), "raw secret must never appear in the response");
  assert.equal(c.sources.upstreamApiKey, "runtime");
  assert.equal(c.sources.dryRun, "env"); // provided via env in this test
});

test("POST applies whitelisted overrides and reports source 'runtime'", async () => {
  const res = await postCfg({ modelSmall: "my-small-model", routingEnabled: false });
  assert.equal(res.status, 200);
  const c = await res.json();
  assert.equal(c.modelSmall, "my-small-model");
  assert.equal(c.routingEnabled, false);
  assert.equal(c.sources.modelSmall, "runtime");
});

test("POST an upstreamApiKey -> hasUpstreamKey + last4; GET never returns the key", async () => {
  const res = await postCfg({ upstreamApiKey: SECRET });
  const c = await res.json();
  assert.equal(c.hasUpstreamKey, true);
  assert.equal(c.upstreamKeyLast4, "1234");
  assert.ok(!JSON.stringify(c).includes(SECRET));
  // and via /api/stats too
  const stats = await (await fetch(base + "/api/stats")).json();
  assert.equal(stats.config.hasUpstreamKey, true);
  assert.ok(!JSON.stringify(stats).includes(SECRET));
});

test("unknown fields are rejected with 400", async () => {
  const res = await postCfg({ modelSmall: "ok", nope: 1, PORT: 9 });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /unknown field/);
});

test("validation: bad gridZone and bad upstreamBaseUrl are rejected", async () => {
  assert.equal((await postCfg({ gridZone: "not/a zone!" })).status, 400);
  assert.equal((await postCfg({ upstreamBaseUrl: "not-a-url" })).status, 400);
  assert.equal((await postCfg({ upstreamBaseUrl: "ftp://x.y" })).status, 400);
  assert.equal((await postCfg({ dryRun: "maybe" })).status, 400);
});

test("gridZone override changes the zone carbon.js reports (cache invalidated)", async () => {
  await postCfg({ gridZone: "ZA" });
  let stats = await (await fetch(base + "/api/stats")).json();
  assert.equal(stats.grid.zone, "ZA");
  await postCfg({ gridZone: "AE" });
  stats = await (await fetch(base + "/api/stats")).json();
  assert.equal(stats.grid.zone, "AE");
});

test("blank secret is a no-op (does not wipe an existing key)", async () => {
  config.setOverrides({ upstreamApiKey: SECRET });
  const res = await postCfg({ upstreamApiKey: "" });
  const c = await res.json();
  assert.equal(c.hasUpstreamKey, true, "blank submit leaves the key intact");
  assert.equal(c.upstreamKeyLast4, "1234");
});

test("a runtime secret never appears in console logs", async () => {
  const captured = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => captured.push(a.join(" "));
  try {
    await postCfg({ upstreamApiKey: SECRET });
    await getCfg();
    await fetch(base + "/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hello there" }] })
    });
    await (await fetch(base + "/api/stats")).json();
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(!captured.join("\n").includes(SECRET), "secret must never be logged");
});
