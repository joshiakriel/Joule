"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config");
const reasoning = require("../src/reasoning");

test("detects reasoning models by the config table", () => {
  assert.ok(reasoning.isReasoning("o3"));
  assert.ok(reasoning.isReasoning("deepseek-r1"));
  assert.ok(reasoning.isReasoning("claude-3-7-sonnet-thinking"));
  assert.equal(reasoning.isReasoning("gpt-4o-mini"), false);
  assert.equal(reasoning.isReasoning("gpt-4o"), false);
});

test("complexity-aware effort, bounded by REASONING_MAX_THINKING_TOKENS", () => {
  const simple = reasoning.planFor("o3", { score: -3 }, null); // clearly simple
  const hard = reasoning.planFor("o3", { score: 6 }, null);    // clearly hard
  assert.equal(simple.effort, "low");
  assert.equal(hard.effort, "high");
  assert.ok(hard.capTokens <= config.reasoning.maxThinkingTokens, "capped to the max");
  assert.ok(simple.capTokens <= hard.capTokens);
});

test("explicit effort override is respected", () => {
  const plan = reasoning.planFor("o3", { score: 6 }, "low"); // hard prompt but caller forces low
  assert.equal(plan.effort, "low");
});

test("injects the provider-specific thinking-budget param", () => {
  const openai = reasoning.applyToBody({ messages: [] }, reasoning.planFor("o3", { score: 6 }, "low"));
  assert.equal(openai.reasoning_effort, "low");
  const anthropic = reasoning.applyToBody({ messages: [] }, reasoning.planFor("claude-3-7-thinking", { score: 6 }, "high"));
  assert.ok(anthropic.thinking && anthropic.thinking.budget_tokens > 0);
  const open = reasoning.applyToBody({ messages: [] }, reasoning.planFor("deepseek-r1", { score: 6 }, "high"));
  assert.ok(open.max_thinking_tokens > 0);
});

test("extracts reasoning tokens from provider usage shapes", () => {
  assert.equal(reasoning.reasoningTokens({ completion_tokens_details: { reasoning_tokens: 512 } }), 512);
  assert.equal(reasoning.reasoningTokens({ reasoning_tokens: 100 }), 100);
  assert.equal(reasoning.reasoningTokens({}), 0);
  assert.equal(reasoning.reasoningTokens(null), 0);
});
