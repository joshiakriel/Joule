"use strict";
process.env.DRY_RUN = "true";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const semcache = require("../src/semcache");

beforeEach(() => { semcache.reset(); semcache.configure({ enabled: true, baseThreshold: 0.8, verifyRate: 1 }); });

test("cosine similarity: near-duplicate text scores higher than unrelated", async () => {
  const a = await semcache.embed("summarise the quarterly sales report");
  const b = await semcache.embed("summarise the quarterly sales report please");
  const c = await semcache.embed("write a python function to sort a list");
  assert.ok(semcache.cosine(a, b) > semcache.cosine(a, c), "duplicate closer than unrelated");
});

test("lookup returns a hit only above the entry threshold; miss otherwise", async () => {
  const vec = await semcache.embed("summarise the quarterly sales report");
  semcache.addEntry({ model: "m", userText: "summarise the quarterly sales report", vec, completion: { choices: [{ message: { content: "…" } }] }, promptTokens: 8, completionTokens: 8 });
  const hit = await semcache.lookup("m", "summarise the quarterly sales report please");
  assert.ok(hit.entry, "near-duplicate is a hit");
  const miss = await semcache.lookup("m", "write a haiku about the ocean");
  assert.equal(miss.entry, null, "unrelated prompt misses");
});

test("embeddings are cached — identical prompt is never re-embedded", async () => {
  semcache.reset(); semcache.configure({ enabled: true });
  await semcache.embed("identical prompt text");
  const before = semcache.stats().embedTokens;
  await semcache.embed("identical prompt text"); // should be a no-op cost-wise
  assert.equal(semcache.stats().embedTokens, before, "no extra embed tokens for a repeat");
});

test("a wrong served hit raises that entry's threshold (bounds future error)", async () => {
  const vec = await semcache.embed("the base prompt about invoices");
  semcache.addEntry({ model: "m", userText: "the base prompt about invoices", vec, completion: { choices: [{ message: { content: "x" } }] }, promptTokens: 6, completionTokens: 6 });
  const e = semcache._entries()[0];
  const t0 = e.threshold;
  // serve a loose match (sim < 0.98 dryCorrect) and learn it was wrong
  semcache.onServe(e, 0.9, () => false);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(e.threshold > t0, "threshold raised after a served error");
  assert.ok(e.threshold >= 0.9, "raised above the offending similarity");
  const s = semcache.stats();
  assert.equal(s.servedErrors, 1);
  assert.ok(s.realisedErrorRate > 0);
});

test("net savings are reported net of embedding spend", async () => {
  semcache.reset(); semcache.configure({ enabled: true });
  await semcache.embed("some prompt to price");
  assert.ok(semcache.stats().embedCostUsd > 0, "embedding spend is tracked so net savings stay honest");
});
