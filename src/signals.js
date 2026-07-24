"use strict";
const config = require("./config");

/**
 * Cheap uncertainty signals — NO extra model call.
 *
 * Routing-time signal (available BEFORE generation): the router's own margin —
 * how far the complexity score sits from the small/large boundary. This is what
 * we calibrate and gate on, because it's the only thing we know before choosing a
 * model. Post-generation signals (finish_reason, length, deterministic checks) are
 * used to LABEL a sample and as guardrails, never to gate the same request.
 */

const isJson = (s) => { try { JSON.parse(s); return true; } catch { return false; } };

// Pre-generation routing signal in (0,1): confidence the SMALL model suffices.
// Higher = clearly-simple prompt = safer to route small. 0.5 exactly at the boundary.
function routingSignal(decision) {
  const margin = (config.complexityThreshold - (decision && decision.score || 0)); // >0 => clearly small
  return 1 / (1 + Math.exp(-margin / 1.5)); // logistic squash
}

// Post-generation deterministic checks + cheap response signals.
function responseSignals({ completion, answer, body }) {
  const choice = completion && completion.choices && completion.choices[0];
  const finish = choice ? choice.finish_reason : null;
  const wantsJson = Boolean(body && body.response_format && body.response_format.type === "json_object");
  const wantsTool = Boolean(body && ((body.tools && body.tools.length) || (body.functions && body.functions.length)));
  const msg = choice && choice.message;
  const checks = {
    nonEmpty: Boolean(answer && String(answer).trim()),
    notTruncated: finish !== "length",
    validJson: !wantsJson || isJson(answer),
    toolCall: !wantsTool || Boolean(msg && (msg.tool_calls || msg.function_call))
  };
  return { finishReason: finish, lengthChars: (answer || "").length, checks, hardPass: Object.values(checks).every(Boolean) };
}

// Cheap, embedding-free prompt features for drift tracking.
function promptFeatures(userText, decision) {
  return { len: (userText || "").length, words: (decision && decision.words) || 0, routing: routingSignal(decision) };
}

module.exports = { routingSignal, responseSignals, promptFeatures };
