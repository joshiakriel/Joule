"use strict";
const config = require("./config");

/**
 * Reasoning-budget control (savings-hierarchy #3). Detects reasoning models, picks
 * a complexity-aware thinking budget (capped), injects the provider-specific param,
 * and meters thinking tokens separately. Thinking tokens are GENERATED tokens — they
 * count toward the decode-weighted energy model and bill as output (never free).
 *
 * Capping the budget is low-risk (accuracy plateaus with depth). Downgrading a
 * reasoning model to a standard one is a QUALITY-RISK decision — the server routes
 * that through the same conformal verification path as tier routing.
 */

// Which reasoning-model spec (if any) matches this model name?
function detect(model) {
  for (const spec of config.reasoning.models) {
    try { if (new RegExp(spec.match, "i").test(model || "")) return spec; } catch { /* bad regex -> skip */ }
  }
  return null;
}
const isReasoning = (model) => Boolean(detect(model));

// Complexity-aware effort (unless the caller overrode it), then a token cap bounded
// by REASONING_MAX_THINKING_TOKENS. Simple prompts think little; hard prompts more.
function planFor(model, decision, override) {
  const spec = detect(model);
  if (!spec) return null;
  let effort = (override && ["low", "medium", "high"].includes(String(override).toLowerCase())) ? String(override).toLowerCase() : null;
  if (!effort) {
    const score = (decision && decision.score) || 0, thr = config.complexityThreshold;
    effort = score <= thr - 1 ? "low" : (score >= thr + 2 ? "high" : config.reasoning.defaultEffort);
  }
  const nominal = config.reasoning.effortTokens[effort] || config.reasoning.effortTokens.medium;
  const cap = Math.min(nominal, config.reasoning.maxThinkingTokens);
  // "uncapped" reference = the highest effort budget — what an untuned call could burn.
  const uncapped = config.reasoning.effortTokens.high;
  return { spec, effort, capTokens: cap, uncappedTokens: uncapped };
}

// Inject the provider-specific thinking-budget parameter into the upstream body.
function applyToBody(body, plan) {
  const b = { ...body };
  const { spec, effort, capTokens } = plan;
  if (spec.param === "reasoning_effort") b.reasoning_effort = effort;
  else if (spec.param === "budget_tokens") b.thinking = { type: "enabled", budget_tokens: capTokens };
  else if (spec.param === "thinking_budget") b.thinking_config = { thinking_budget: capTokens };
  else if (spec.param === "max_thinking_tokens") b.max_thinking_tokens = capTokens;
  return b;
}

// Thinking/reasoning tokens from a provider usage object (OpenAI + others).
function reasoningTokens(usage) {
  if (!usage) return 0;
  return Number(
    (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) ??
    usage.reasoning_tokens ?? usage.thinking_tokens ?? 0
  ) || 0;
}

module.exports = { detect, isReasoning, planFor, applyToBody, reasoningTokens };
