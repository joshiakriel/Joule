"use strict";
const config = require("./config");

/**
 * Heuristic complexity classifier. Reads the latest user prompt and decides
 * whether it truly needs the large model. This is deliberately transparent and
 * cheap; a production version swaps in a small fine-tuned classifier, but the
 * routing *interface* stays identical.
 */
const RX = {
  trivial: /(^\s*hi\b|^\s*hey\b|thank|thanks|hello|good morning|good evening|capital of|what'?s \d|how are you)/i,
  format: /(summar|reformat|rewrite|bullet|translate|shorten|tidy|clean up|extract|list|rename|convert this)/i,
  reason: /(prove|derive|analy|debug|architect|design|trade-?off|strategy|optimi|refactor|why does|explain how|step by step|plan|evaluate|compare|reason)/i,
  code: /(code|function|async|race condition|regex|sql|kubernetes|\bapi\b|algorithm|node\.?js|python|typescript|compile|stack trace)/i
};

function classify(promptText) {
  const q = (promptText || "").trim();
  const words = q ? q.split(/\s+/).length : 0;
  let score = 0;
  const signals = [];

  if (RX.trivial.test(q)) { score -= 3; signals.push("greeting/low-value lookup"); }
  if (RX.format.test(q)) { score += 1; signals.push("mechanical text transform"); }
  if (RX.reason.test(q)) { score += 3; signals.push("multi-step reasoning"); }
  if (RX.code.test(q)) { score += 2; signals.push("technical/code"); }
  if (words > 22) { score += 2; signals.push("long, detailed prompt"); }
  else if (words > 0 && words < 7) { score -= 1; signals.push("very short prompt"); }

  const tier = score > config.complexityThreshold ? "large" : "small";
  // rough confidence: distance of score from the decision boundary
  const conf = Math.max(60, Math.min(98, 78 + Math.abs(score - config.complexityThreshold) * 6));
  if (!signals.length) signals.push("general prompt, mid complexity");

  return { tier, score, signals, confidence: conf, words };
}

function selectModel(tier) {
  return tier === "large" ? config.modelLarge : config.modelSmall;
}

// Infer a tier from a model name (used when routing is disabled but we still meter).
function tierForModel(model) {
  if (model === config.modelSmall) return "small";
  if (model === config.modelLarge) return "large";
  return /mini|small|nano|haiku|flash|8b|7b|lite/i.test(model || "") ? "small" : "large";
}

module.exports = { classify, selectModel, tierForModel };
