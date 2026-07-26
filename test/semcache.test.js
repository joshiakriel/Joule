"use strict";
process.env.DRY_RUN = "true";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const semcache = require("../src/semcache");

const tick = () => new Promise((r) => setTimeout(r, 5));
const comp = (txt) => ({ choices: [{ message: { content: txt } }] });

beforeEach(() => { semcache.reset(); semcache.configure({ enabled: true, baseThreshold: 0.8, minSimilarity: 0.5, verifyRate: 1 }); });

test("cosine: near-duplicate scores higher than unrelated", async () => {
  const a = await semcache.embed("summarise the quarterly sales report");
  const b = await semcache.embed("summarise the quarterly sales report please");
  const c = await semcache.embed("write a python function to sort a list");
  assert.ok(semcache.cosine(a, b) > semcache.cosine(a, c));
});

test("lookup hits a near-duplicate WITHIN the same namespace, misses unrelated", async () => {
  const ctx = { tenant: "acme", model: "m" };
  const v = await semcache.embed("summarise the quarterly sales report");
  semcache.addEntry({ ctx, userText: "summarise the quarterly sales report", vec: v, completion: comp("…"), promptTokens: 8, completionTokens: 8 });
  assert.ok((await semcache.lookup(ctx, "summarise the quarterly sales report please")).entry, "near-duplicate hit");
  assert.equal((await semcache.lookup(ctx, "write a haiku about the ocean")).entry, null, "unrelated miss");
});

test("TENANT ISOLATION: tenant A can never see tenant B's entry", async () => {
  const A = { tenant: "A", model: "m" }, B = { tenant: "B", model: "m" };
  const text = "summarise the quarterly sales report";
  semcache.addEntry({ ctx: A, userText: text, vec: await semcache.embed(text), completion: comp("A-only answer"), promptTokens: 8, completionTokens: 8 });
  assert.ok((await semcache.lookup(A, text + " please")).entry, "A sees its own entry");
  assert.equal((await semcache.lookup(B, text)).entry, null, "B can NEVER see A's entry");
  // same for a different system prompt (scope) — different namespace
  assert.equal((await semcache.lookup({ tenant: "A", model: "m", systemHash: "different-system" }, text)).entry, null);
});

test("sensitive-query BYPASS: patterns and header skip the semantic layer", () => {
  assert.equal(semcache.isBypassed("what's my account number and wire transfer status", null), true);
  assert.equal(semcache.isBypassed("suggest a prescription dosage for this symptom", null), true);
  assert.equal(semcache.isBypassed("summarise the sales report", null), false);
  assert.equal(semcache.isBypassed("summarise the sales report", "true"), true, "header forces bypass");
});

test("STALENESS: an entry past its TTL is never served", async () => {
  const ctx = { tenant: "acme", model: "m" };
  const text = "summarise the quarterly sales report";
  semcache.addEntry({ ctx, userText: text, vec: await semcache.embed(text), completion: comp("stale"), promptTokens: 8, completionTokens: 8 });
  semcache._entries()[0].createdAt = Date.now() - 1000 * 60 * 60 * 48; // 48h old
  semcache.configure({ ttlSec: 3600 }); // 1h TTL
  assert.equal((await semcache.lookup(ctx, text)).entry, null, "stale entry not served");
});

test("PII responses are never cached", async () => {
  const ctx = { tenant: "acme", model: "m" };
  const text = "summarise the sales report";
  semcache.addEntry({ ctx, userText: text, vec: await semcache.embed(text), completion: comp("contact alice@example.com"), promptTokens: 8, completionTokens: 8, hasPII: true });
  assert.equal(semcache._entries().length, 0, "PII answer not stored");
});

test("hard MINIMUM-SIMILARITY floor: never serve below it regardless of threshold", async () => {
  semcache.configure({ minSimilarity: 0.99, baseThreshold: 0.5 }); // floor above any loose match
  const ctx = { tenant: "acme", model: "m" };
  const v = await semcache.embed("summarise the quarterly sales report");
  semcache.addEntry({ ctx, userText: "summarise the quarterly sales report", vec: v, completion: comp("x"), promptTokens: 8, completionTokens: 8 });
  assert.equal((await semcache.lookup(ctx, "summarise the quarterly sales report please")).entry, null, "loose match blocked by the floor");
});

test("input SANITISATION rejects empty/oversized input", () => {
  assert.equal(semcache.sanitize(""), null);
  assert.equal(semcache.sanitize("   "), null);
  assert.equal(semcache.sanitize("x".repeat(20000)), null, "oversized rejected");
  assert.equal(semcache.sanitize("  hello   world  "), "hello world");
});

test("AUTO-DISABLE + alert when realised error stays over the disable rate", async () => {
  semcache.configure({ disableMinSamples: 5, disableErrorRate: 0.1, verifyRate: 1 });
  const ctx = { tenant: "acme", model: "m" };
  const e = { ns: semcache.nsOf(ctx), threshold: 0.8, hits: 0, errors: 0 };
  semcache._entries().push(e);
  for (let i = 0; i < 6; i++) { semcache.onServe(e, 0.9, () => false); await tick(); } // all wrong
  assert.equal(semcache._autoDisabled(), true, "layer auto-disabled");
  assert.equal(semcache.enabled(), false, "no longer active — falls back to exact/prefix");
  assert.ok(semcache.stats().autoDisabledReason);
});

test("realisedErrorRate is null until measured (no safe claim without it)", () => {
  const s = semcache.stats();
  assert.equal(s.realisedErrorRate, null, "not yet measured");
  assert.ok("targetError" in s && "minSimilarity" in s && "version" in s && "ttlSec" in s);
});
