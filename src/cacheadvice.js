"use strict";
const config = require("./config");

/**
 * Cache advisory (Layer 1) — since Joule sees every request, it can advise on
 * cache hit rate and flag CACHE-HOSTILE prompt structure. Provider prefix caching
 * only works when the *front* of the prompt is stable; variable content near the
 * start (timestamps, IDs, UUIDs) busts the prefix and forces a recompute.
 * Cheap regex on the prompt head — no model call, no added latency.
 */

// Does this prompt's structure defeat prefix caching? Looks at the HEAD only.
function analyzePrompt(text) {
  const head = String(text || "").slice(0, 240);
  const reasons = [];
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(head)) reasons.push("UUID near the start");
  if (/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(head)) reasons.push("timestamp near the start");
  if (/\b\d{7,}\b/.test(head)) reasons.push("long numeric id near the start");
  if (/^\s*(request id|trace id|session|user id|order)\b/i.test(head)) reasons.push("per-request identifier before the instructions");
  return { hostile: reasons.length > 0, reasons };
}

// Prefix-cache breakeven reuse rate: a cache with a write premium only pays off
// once reuse clears this fraction. write premium = writeMult-1; read saving = 1-readMult.
function breakevenHitRate(readMult = config.cache.readMultiplier, writeMult = config.cache.writeMultiplier) {
  const writePrem = Math.max(0, writeMult - 1), readSave = Math.max(0, 1 - readMult);
  const denom = writePrem + readSave;
  return denom > 0 ? writePrem / denom : 0;
}

// Human-readable tips from the aggregate cache stats.
function tips(s) {
  const t = [];
  if (s.hostileRate > 0.2) t.push("Move stable content (system prompt, instructions, few-shot examples) to the FRONT and put per-request/variable data at the END — a stable prefix is what providers cache.");
  if (s.requests > 10 && s.exactHitRate < 0.1) t.push("Exact-cache hit rate is low: identical repeated calls are rare. Prefix caching (and, later, semantic caching) will save more than exact-match.");
  if (s.belowBreakeven) t.push(`Prefix-cache reuse (${(s.prefixReuse * 100).toFixed(0)}%) is below breakeven (${(s.breakevenHitRate * 100).toFixed(0)}%): the cache-write premium currently exceeds read savings — batch or consolidate callers to raise reuse.`);
  if (!t.length && s.requests > 0) t.push("Cache structure looks healthy — stable prefixes and reasonable reuse.");
  return t;
}

module.exports = { analyzePrompt, breakevenHitRate, tips };
