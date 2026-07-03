"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const store = require("../src/store");

let tmpDir;

// Build a log record with the fields aggregate()/toCsv() rely on.
function makeRec({ tier = "small", cached = false, tokens = 100, actEnergy, baseEnergy }) {
  const actCost = 0.001, baseCost = 0.01;
  return {
    ts: new Date().toISOString(), mode: cached ? "cache" : "dry_run", cached,
    model: tier === "small" ? "gpt-4o-mini" : "gpt-4o", tier,
    signals: ["x"], confidence: 80,
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
  assert.equal(lines[0].split(",").length, 17, "17 columns in header");
  assert.equal(lines[1].split(",").length, 17, "row column count matches header");
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
