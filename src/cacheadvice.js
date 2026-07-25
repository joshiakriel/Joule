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

// Quantified advisory from the real log (metadata only — works with LOG_PROMPTS=false).
// Estimates are clearly labelled with their method; they are NOT measured savings.
function advisory(records, opts = {}) {
  const readSave = 1 - (opts.readMultiplier != null ? opts.readMultiplier : config.cache.readMultiplier);
  const targetReuse = opts.targetReuse != null ? opts.targetReuse : 0.8; // achievable prefix reuse after fixing ordering (assumption)
  const minCacheableTokens = opts.minCacheableTokens != null ? opts.minCacheableTokens : 1024;
  const priceIn = (m) => config.priceFor(m, "large").in; // input $/1e6 tokens (approx by model)
  const total = records.length;
  const findings = [];
  if (!total) return { requests: 0, findings: [], estSavingUsdWindow: 0, note: "No requests yet." };

  const hostile = records.filter((r) => r.cacheHostile);
  if (hostile.length) {
    const est = hostile.reduce((s, r) => s + ((r.promptTokens || 0) / 1e6) * priceIn(r.model) * readSave * targetReuse, 0);
    findings.push({
      pattern: "dynamic-content-before-static", count: hostile.length, share: hostile.length / total,
      currentHitRate: 0, estimatedHitRate: targetReuse, estSavingUsd: est,
      recommendation: "Requests here place dynamic content (IDs/timestamps/session) BEFORE the static block, busting the prefix cache. Move stable content (system prompt, instructions, few-shot) to the FRONT and variable data to the END.",
      method: `estimate: ${Math.round(readSave * 100)}% cached-read discount × assumed ${Math.round(targetReuse * 100)}% achievable prefix reuse over these prompts' input tokens`
    });
  }
  const short = records.filter((r) => (r.promptTokens || 0) < minCacheableTokens);
  if (short.length / total > 0.5) {
    findings.push({
      pattern: "below-min-cacheable-length", count: short.length, share: short.length / total,
      currentHitRate: 0, estimatedHitRate: 0, estSavingUsd: 0,
      recommendation: `${Math.round(short.length / total * 100)}% of prompts are under ~${minCacheableTokens} tokens — below the provider prefix-cache minimum, so they never cache. Consolidate short calls or share a static preamble.`,
      method: "count of prompts under the provider minimum prefix length"
    });
  }
  const be = breakevenHitRate();
  const pc = records.reduce((a, r) => { const p = r.prefixCache; if (p) { a.cached += p.cachedTokens || 0; a.write += p.writeTokens || 0; } return a; }, { cached: 0, write: 0 });
  const reuse = (pc.cached + pc.write) ? pc.cached / (pc.cached + pc.write) : 0;
  if (pc.write > 0 && reuse < be) {
    findings.push({
      pattern: "below-breakeven-reuse", count: null, share: null, currentHitRate: reuse, estimatedHitRate: be, estSavingUsd: 0,
      recommendation: `Prefix-cache reuse (${Math.round(reuse * 100)}%) is below breakeven (${Math.round(be * 100)}%): the cache-write premium currently exceeds read savings. Batch/consolidate callers to raise reuse before relying on the cache.`,
      method: "reuse = cached / (cached + cache-write) input tokens vs the write-premium breakeven"
    });
  }
  return {
    requests: total, findings,
    estSavingUsdWindow: findings.reduce((s, f) => s + (f.estSavingUsd || 0), 0),
    note: "Advisory estimates are labelled; they are NOT measured savings. Prefix/exact caching itself is zero quality risk."
  };
}

module.exports = { analyzePrompt, breakevenHitRate, tips, advisory };
