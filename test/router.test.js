"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { classify, selectModel, tierForModel } = require("../src/router");
const config = require("../src/config");

// Representative prompts and the tier the heuristic classifier should pick.
// These lock in current routing behaviour so a silent regression is caught.
const CASES = [
  // trivial / greeting / short -> small
  { prompt: "hi there", tier: "small" },
  { prompt: "thanks!", tier: "small" },
  { prompt: "hello, how are you", tier: "small" },
  { prompt: "what's the capital of France", tier: "small" },
  { prompt: "Tell me a fun fact about otters", tier: "small" }, // neutral, mid-length -> small
  // reasoning / code / long -> large
  { prompt: "Prove step by step that the square root of 2 is irrational and analyse the argument", tier: "large" },
  { prompt: "Write a Python function with async code to debug a race condition", tier: "large" },
  { prompt: "Design the architecture and evaluate the trade-offs of a multi-region database", tier: "large" },
  {
    prompt:
      "Please write a really long and detailed request that keeps going well past the length " +
      "threshold so that the length signal alone pushes this prompt into the large tier bucket now",
    tier: "large"
  }
];

for (const c of CASES) {
  test(`classify -> ${c.tier}: "${c.prompt.slice(0, 40)}..."`, () => {
    const d = classify(c.prompt);
    assert.equal(d.tier, c.tier, `expected ${c.tier} for: ${c.prompt}`);
    assert.ok(Array.isArray(d.signals) && d.signals.length > 0, "signals must be non-empty");
    assert.ok(typeof d.score === "number");
    assert.ok(d.confidence >= 60 && d.confidence <= 98, "confidence within bounds");
  });
}

test("empty prompt still yields a tier and a fallback signal", () => {
  const d = classify("");
  assert.ok(d.tier === "small" || d.tier === "large");
  assert.ok(d.signals.length > 0);
});

test("selectModel maps tiers to configured models", () => {
  assert.equal(selectModel("small"), config.modelSmall);
  assert.equal(selectModel("large"), config.modelLarge);
});

test("tierForModel infers tier from model name", () => {
  assert.equal(tierForModel(config.modelSmall), "small");
  assert.equal(tierForModel(config.modelLarge), "large");
  assert.equal(tierForModel("some-mini-model"), "small");
  assert.equal(tierForModel("giant-frontier-model"), "large");
});
