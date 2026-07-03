"use strict";
// Offline integration test: DRY_RUN, no API key, no external network. Must be set
// BEFORE requiring any src module (config reads env once at require time).
process.env.DRY_RUN = "true";
process.env.ROUTING_ENABLED = "true";
delete process.env.UPSTREAM_API_KEY;
delete process.env.ELECTRICITYMAPS_TOKEN;

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("../src/store");
const app = require("../src/server");

let server, base, tmpDir;

const post = (body) =>
  fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "joule-int-"));
  store.init(tmpDir); // isolate: server + store now write here, not data/log.jsonl
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("non-streaming returns OpenAI-shaped JSON and all eight x-joule-* headers", async () => {
  const res = await post({ model: "auto", messages: [{ role: "user", content: "hi thanks" }] });
  assert.equal(res.status, 200);
  const headers = ["mode", "tier", "model", "cost-usd", "energy-wh", "co2-g", "saved-usd", "saved-co2-g"];
  for (const h of headers) assert.ok(res.headers.get("x-joule-" + h) !== null, `missing x-joule-${h}`);
  const body = await res.json();
  assert.equal(body.object, "chat.completion");
  assert.ok(body.choices?.[0]?.message?.content, "has an assistant message");
  assert.ok(body.usage?.total_tokens > 0, "reports token usage");
});

test("streaming (stream:true) returns SSE chunks ending in [DONE]", async () => {
  const res = await post({ model: "auto", stream: true, messages: [{ role: "user", content: "stream me a short answer please" }] });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /^data: /m, "has SSE data lines");
  assert.match(text, /"delta"/, "has chat.completion.chunk deltas");
  assert.ok(text.trimEnd().endsWith("data: [DONE]"), "stream ends in [DONE]");
});

test("both paths increment /api/stats totals and appear in /api/report", async () => {
  const before = (await (await fetch(base + "/api/stats")).json()).totals.requests;
  await post({ model: "auto", messages: [{ role: "user", content: "one non streaming request" }] });
  await post({ model: "auto", stream: true, messages: [{ role: "user", content: "one streaming request" }] });

  const totals = (await (await fetch(base + "/api/stats")).json()).totals;
  assert.equal(totals.requests, before + 2, "stats counts both requests");

  const reportJson = await (await fetch(base + "/api/report?format=json")).json();
  assert.ok(reportJson.totals.requests >= before + 2);
  assert.ok(reportJson.methodology, "report carries the methodology block");

  const csv = await (await fetch(base + "/api/report?format=csv")).text();
  const rows = csv.split("\n").filter(Boolean);
  assert.ok(rows[0].startsWith("timestamp,mode,model,tier,cached,"));
  assert.equal(rows.length - 1, totals.requests, "one CSV row per logged request");
});

test("a repeated identical request reports mode:cache and increments cacheHits", async () => {
  const msg = [{ role: "user", content: "identical prompt used twice for cache" }];
  const hitsBefore = (await (await fetch(base + "/api/stats")).json()).totals.cacheHits;

  const first = await post({ model: "auto", messages: msg });
  assert.notEqual(first.headers.get("x-joule-mode"), "cache", "first call is not a cache hit");
  const second = await post({ model: "auto", messages: msg });
  assert.equal(second.headers.get("x-joule-mode"), "cache", "second identical call hits cache");

  const hitsAfter = (await (await fetch(base + "/api/stats")).json()).totals.cacheHits;
  assert.equal(hitsAfter, hitsBefore + 1);
});

test("routing: trivial prompt logs tier small, reasoning prompt logs large", async () => {
  const trivial = await post({ model: "auto", messages: [{ role: "user", content: "hey there thanks" }] });
  assert.equal(trivial.headers.get("x-joule-tier"), "small");

  const reasoning = await post({
    model: "auto",
    messages: [{ role: "user", content: "Prove step by step and analyse why this algorithm has a race condition and refactor it" }]
  });
  assert.equal(reasoning.headers.get("x-joule-tier"), "large");
});
