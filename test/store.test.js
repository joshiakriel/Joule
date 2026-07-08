"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const store = require("../src/store");

let tmpDir;

// Build a log record with the fields aggregate()/toCsv() rely on.
function makeRec({ tier = "small", cached = false, tokens = 100, actEnergy, baseEnergy, ts, mode, model, session = null, latencyMs = 10 }) {
  const actCost = 0.001, baseCost = 0.01;
  return {
    ts: ts || new Date().toISOString(), mode: mode || (cached ? "cache" : "dry_run"), cached,
    model: model || (tier === "small" ? "gpt-4o-mini" : "gpt-4o"), tier,
    signals: ["x"], confidence: 80, session, latencyMs,
    promptTokens: tokens / 2, completionTokens: tokens / 2, totalTokens: tokens,
    actual: { costUsd: actCost, energyWh: actEnergy, carbonG: actEnergy * 0.45 },
    baseline: { costUsd: baseCost, energyWh: baseEnergy, carbonG: baseEnergy * 0.45 },
    saved: { costUsd: baseCost - actCost, energyWh: baseEnergy - actEnergy, carbonG: (baseEnergy - actEnergy) * 0.45 },
    grid: { zone: "AE", gPerKwh: 450, source: "fallback (test)" }
  };
}

// fresh, isolated store for a single test (clears the on-disk log first so
// init()'s reload starts from empty)
function reset() {
  fs.rmSync(path.join(tmpDir, "log.jsonl"), { force: true });
  store.init(tmpDir);
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "joule-store-"));
  store.init(tmpDir); // isolated data dir — does not touch data/log.jsonl
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("aggregate() sums totals, counts tiers/cache, and computes savedPct", () => {
  reset();
  // actual energy: 1 + 2 + 0 = 3 ; baseline energy: 4 + 6 + 5 = 15 -> savedPct = round((1-3/15)*100) = 80
  store.add(makeRec({ tier: "small", tokens: 100, actEnergy: 1, baseEnergy: 4 }));
  store.add(makeRec({ tier: "large", tokens: 200, actEnergy: 2, baseEnergy: 6 }));
  store.add(makeRec({ tier: "small", cached: true, tokens: 50, actEnergy: 0, baseEnergy: 5 }));

  const t = store.aggregate();
  assert.equal(t.requests, 3);
  assert.equal(t.cacheHits, 1);
  assert.equal(t.routedSmall, 2);
  assert.equal(t.routedLarge, 1);
  assert.equal(t.tokens, 350);
  assert.equal(t.savedPct, Math.round((1 - t.energyWh.actual / t.energyWh.baseline) * 100));
  assert.equal(t.savedPct, 80);
  // sums line up
  assert.ok(Math.abs(t.energyWh.actual - 3) < 1e-9);
  assert.ok(Math.abs(t.energyWh.baseline - 15) < 1e-9);
});

test("toCsv() emits a header plus one row per record", () => {
  reset();
  store.add(makeRec({ tier: "small", tokens: 100, actEnergy: 1, baseEnergy: 4 }));
  store.add(makeRec({ tier: "large", tokens: 200, actEnergy: 2, baseEnergy: 6 }));

  const lines = store.toCsv().split("\n");
  assert.equal(lines.length, 3, "header + 2 rows");
  assert.ok(lines[0].startsWith("timestamp,mode,model,tier,cached,"));
  assert.ok(lines[0].endsWith(",session"), "session column present");
  assert.equal(lines[0].split(",").length, 18, "18 columns in header");
  assert.equal(lines[1].split(",").length, 18, "row column count matches header");
});

test("aggregate() on an empty store is zeroed with savedPct 0", () => {
  reset();
  const t = store.aggregate();
  assert.equal(t.requests, 0);
  assert.equal(t.savedPct, 0);
});

test("records persist to log.jsonl in the configured data dir", () => {
  reset();
  store.add(makeRec({ tier: "small", tokens: 100, actEnergy: 1, baseEnergy: 4 }));
  const file = path.join(tmpDir, "log.jsonl");
  assert.ok(fs.existsSync(file));
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).tier, "small");
});

// ---- filtering / aggregation (shared with the server) ----------------------
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;

test("predicateFor + aggregate() filter by range, tier, mode and model search", () => {
  reset();
  store.add(makeRec({ tier: "small", mode: "dry_run", model: "gpt-4o-mini", ts: iso(2 * MIN), actEnergy: 1, baseEnergy: 4 }));
  store.add(makeRec({ tier: "large", mode: "live", model: "gpt-4o", ts: iso(30 * MIN), actEnergy: 2, baseEnergy: 2 }));
  store.add(makeRec({ tier: "small", mode: "cache", model: "gpt-4o-mini", ts: iso(3 * DAY), actEnergy: 1, baseEnergy: 5 }));

  assert.equal(store.aggregate(store.predicateFor({ range: "all" })).requests, 3);
  assert.equal(store.aggregate(store.predicateFor({ range: "1h" })).requests, 2, "last hour excludes the 3-day-old record");
  assert.equal(store.aggregate(store.predicateFor({ range: "24h" })).requests, 2);
  assert.equal(store.aggregate(store.predicateFor({ tier: "large" })).requests, 1);
  assert.equal(store.aggregate(store.predicateFor({ mode: "cache" })).requests, 1);
  assert.equal(store.aggregate(store.predicateFor({ q: "mini" })).requests, 2, "model substring match");
  assert.equal(store.aggregate(store.predicateFor({ range: "1h", tier: "small" })).requests, 1, "filters compose");
});

test("perModel() breaks down calls/tokens/cost/energy/latency per model", () => {
  reset();
  store.add(makeRec({ model: "gpt-4o-mini", tier: "small", tokens: 100, actEnergy: 1, baseEnergy: 4, latencyMs: 10 }));
  store.add(makeRec({ model: "gpt-4o-mini", tier: "small", tokens: 100, actEnergy: 1, baseEnergy: 4, latencyMs: 30 }));
  store.add(makeRec({ model: "gpt-4o", tier: "large", tokens: 200, actEnergy: 2, baseEnergy: 2, latencyMs: 50 }));

  const pm = store.perModel();
  assert.equal(pm.length, 2);
  assert.equal(pm[0].model, "gpt-4o-mini", "sorted by call count desc");
  assert.equal(pm[0].calls, 2);
  assert.equal(pm[0].tokens, 200);
  assert.equal(pm[0].avgLatencyMs, 20, "average of 10 and 30");
  const large = pm.find((m) => m.model === "gpt-4o");
  assert.equal(large.calls, 1);
});

test("series() returns fixed-length buckets whose call counts sum to the total", () => {
  reset();
  for (let i = 0; i < 5; i++) store.add(makeRec({ ts: iso(i * 10 * MIN), actEnergy: 1, baseEnergy: 4 }));
  const s = store.series(store.predicateFor({ range: "all" }), { buckets: 24 });
  assert.equal(s.length, 24);
  assert.equal(s.reduce((n, b) => n + b.calls, 0), 5, "every record lands in exactly one bucket");
});

test("sessions(): tagged calls group by session id; untagged split by time gap", () => {
  reset();
  // one tagged agent run (3 calls, 2 small + 1 large)
  store.add(makeRec({ session: "run-A", tier: "small", ts: iso(9 * MIN), actEnergy: 1, baseEnergy: 4 }));
  store.add(makeRec({ session: "run-A", tier: "small", ts: iso(8 * MIN), actEnergy: 1, baseEnergy: 4 }));
  store.add(makeRec({ session: "run-A", tier: "large", ts: iso(7 * MIN), actEnergy: 2, baseEnergy: 2 }));
  // two untagged calls far apart in time -> two ad-hoc buckets
  store.add(makeRec({ ts: iso(2 * DAY), actEnergy: 1, baseEnergy: 4 }));
  store.add(makeRec({ ts: iso(1 * MIN), actEnergy: 1, baseEnergy: 4 }));

  const sess = store.sessions();
  const tagged = sess.find((s) => s.id === "run-A");
  assert.ok(tagged, "tagged session present");
  assert.equal(tagged.tagged, true);
  assert.equal(tagged.calls, 3);
  assert.equal(tagged.small, 2);
  assert.equal(tagged.large, 1);
  assert.equal(sess.filter((s) => !s.tagged).length, 2, "untagged calls split into two gap buckets");
});

test("clear() empties the store in memory and on disk", () => {
  reset();
  store.add(makeRec({ actEnergy: 1, baseEnergy: 4 }));
  assert.equal(store.aggregate().requests, 1);
  const removed = store.clear();
  assert.equal(removed, 1);
  assert.equal(store.aggregate().requests, 0);
  const file = path.join(tmpDir, "log.jsonl");
  assert.equal(fs.readFileSync(file, "utf8"), "", "on-disk log truncated");
});

test("summary() bundles totals + series + perModel + sessions for a filter", () => {
  reset();
  store.add(makeRec({ session: "run-A", tier: "small", ts: iso(5 * MIN), actEnergy: 1, baseEnergy: 4 }));
  store.add(makeRec({ session: "run-A", tier: "large", ts: iso(4 * MIN), actEnergy: 2, baseEnergy: 2 }));
  const sum = store.summary({ range: "1h" });
  assert.equal(sum.totals.requests, 2);
  assert.equal(sum.series.length, 24);
  assert.equal(sum.perModel.reduce((n, m) => n + m.calls, 0), 2);
  assert.equal(sum.sessions.find((s) => s.id === "run-A").calls, 2);
  assert.equal(sum.recent.length, 2);
});
