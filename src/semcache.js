"use strict";
const config = require("./config");

/**
 * Layer 2 — SEMANTIC cache (opt-in, default OFF). Returns a cached answer for a
 * *semantically similar* (not identical) prompt, so it CAN return a different
 * question's answer — a genuine QUALITY RISK, never risk-free. Semantic caching
 * also fails SILENTLY (a wrong hit is a confident 200 OK), so this module is built
 * to fail LOUDLY and never leak:
 *
 *  - TENANT/SCOPE ISOLATION: every entry is namespaced by tenant + project + user
 *    tier + model + system-prompt hash + version. A lookup can ONLY match inside the
 *    same namespace — tenant A can never see tenant B's answer.
 *  - BYPASS: sensitive prompts (financial/medical/legal/secret patterns, or the
 *    X-Joule-Cache-Bypass header) skip the semantic layer entirely.
 *  - STALENESS: per-entry TTL + version-tagged keys — never serve past TTL or across
 *    a SOURCE_VERSION bump.
 *  - HARDENING: a hard minimum-similarity floor, input sanitisation before embedding.
 *  - SAFETY: a sample of hits is verified; realised error is MEASURED. Over target ->
 *    auto-tighten; if it stays high -> auto-DISABLE the layer + alert.
 *  - PII: responses/prompts carrying personal data are never cached.
 *
 * Prefix/exact caching (Layer 1) is unaffected — it recomputes freshly and is safe.
 */

const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const estTokens = (t) => Math.max(1, Math.round(String(t || "").length / 4));
function hashHex(str) { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return (h >>> 0).toString(16); }

// ---- state (in-memory; ephemeral) ----
let entries = [];                 // { id, ns, model, vec, completion, promptTokens, completionTokens, threshold, hits, errors, createdAt }
let embedCache = new Map();        // norm(text) -> vector (never re-embed an identical prompt)
let seq = 0;
let embedTokens = 0, embedCostUsd = 0;
let hits = 0, verified = 0, servedErrors = 0, bypassCount = 0, staleServedAvoided = 0;
let simBuckets = { "0.85-0.9": 0, "0.9-0.95": 0, "0.95-1.0": 0 };
let byNamespace = new Map();       // ns -> { entries, hits }
let autoDisabled = false, autoDisabledReason = null;
let opts = { ...config.semanticCache };
let embedder = null;               // injectable for tests

function reset() {
  entries = []; embedCache = new Map(); seq = 0; embedTokens = 0; embedCostUsd = 0;
  hits = 0; verified = 0; servedErrors = 0; bypassCount = 0; staleServedAvoided = 0;
  simBuckets = { "0.85-0.9": 0, "0.9-0.95": 0, "0.95-1.0": 0 }; byNamespace = new Map();
  autoDisabled = false; autoDisabledReason = null;
  opts = { ...config.semanticCache }; embedder = null;
}
function configure(p) { opts = { ...opts, ...p }; }
function setEmbedder(fn) { embedder = fn; }
const enabled = () => opts.enabled && !autoDisabled;

// Namespace = tenant/scope isolation. Only entries in the SAME namespace can match.
function nsOf(ctx) {
  ctx = ctx || {};
  return hashHex([ctx.tenant || "_", ctx.project || "_", ctx.userTier || "_", ctx.model || "_", ctx.systemHash || "_", opts.version].join("|"));
}

// Sensitive-query bypass: header or a configured pattern -> skip the semantic layer.
function isBypassed(userText, headerBypass) {
  if (headerBypass && /^(1|true|yes)$/i.test(String(headerBypass))) return true;
  const t = String(userText || "");
  for (const p of opts.bypassPatterns || []) { try { if (new RegExp(p, "i").test(t)) return true; } catch { /* bad pattern */ } }
  return false;
}
function recordBypass() { bypassCount++; }

// Adversarial guard: reject empty/oversized input before embedding; strip control chars.
function sanitize(text) {
  const t = String(text || "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.length > opts.maxInputChars) return null; // empty or oversized/crafted -> do not embed
  return t;
}

function hashEmbed(text) {
  const dim = 64, v = new Array(dim).fill(0);
  for (const tok of norm(text).split(" ").filter(Boolean)) { let h = 0; for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0; v[h % dim] += 1; }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

async function embed(text) {
  const key = norm(text);
  if (embedCache.has(key)) return embedCache.get(key);
  let vec;
  if (embedder) { vec = embedder(text); }
  else if (config.dryRun) { vec = hashEmbed(text); }
  else {
    const res = await fetch(config.upstreamBaseUrl + "/embeddings", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + config.upstreamApiKey },
      body: JSON.stringify({ model: opts.embeddingModel, input: text }), signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error("embeddings upstream " + res.status);
    const data = await res.json();
    vec = data.data && data.data[0] && data.data[0].embedding;
    embedTokens += (data.usage && data.usage.total_tokens) || estTokens(text);
  }
  if (config.dryRun || embedder) embedTokens += estTokens(text);
  embedCostUsd += (estTokens(text) / 1e6) * opts.embedPricePerM;
  embedCache.set(key, vec);
  return vec;
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
function cosine(a, b) { if (!a || !b || a.length !== b.length) return 0; const na = Math.sqrt(dot(a, a)) || 1, nb = Math.sqrt(dot(b, b)) || 1; return dot(a, b) / (na * nb); }

const isFresh = (e) => (Date.now() - e.createdAt) <= opts.ttlSec * 1000;

// Look up a semantically similar cached answer WITHIN the request's namespace only.
// Serves only above BOTH the entry's learned threshold AND the hard minimum floor,
// and never a stale entry. Returns { entry, sim, vec, ns }.
async function lookup(ctx, rawText) {
  if (!enabled()) return { entry: null, sim: -1, vec: null, ns: null, disabled: autoDisabled };
  const userText = sanitize(rawText);
  if (!userText) return { entry: null, sim: -1, vec: null, ns: null };
  const vec = await embed(userText);
  const ns = nsOf(ctx);
  let best = null, bestSim = -1;
  for (const e of entries) {
    if (e.ns !== ns) continue;                 // ISOLATION: only same-namespace entries
    if (!isFresh(e)) continue;                 // never consider a stale entry
    const sim = cosine(vec, e.vec);
    if (sim > bestSim) { bestSim = sim; best = e; }
  }
  const floor = Math.max(opts.minSimilarity, best ? best.threshold : opts.minSimilarity);
  if (best && bestSim >= floor) {
    if (bestSim >= 0.95) simBuckets["0.95-1.0"]++; else if (bestSim >= 0.9) simBuckets["0.9-0.95"]++; else simBuckets["0.85-0.9"]++;
    return { entry: best, sim: bestSim, vec, ns, createdAt: best.createdAt };
  }
  return { entry: null, sim: bestSim, vec, ns };
}

// Store a fresh answer under the request's namespace. PII responses are NEVER cached.
function addEntry({ ctx, userText, vec, completion, promptTokens, completionTokens, hasPII }) {
  if (!enabled() || hasPII) return;
  const clean = sanitize(userText); if (!clean) return;
  const ns = nsOf(ctx);
  entries.push({ id: "sc-" + (seq++), ns, model: (ctx && ctx.model) || null, vec: vec || hashEmbed(clean), completion, promptTokens, completionTokens, threshold: opts.baseThreshold, hits: 0, errors: 0, createdAt: Date.now() });
  byNamespace.set(ns, { entries: (byNamespace.get(ns)?.entries || 0) + 1, hits: byNamespace.get(ns)?.hits || 0 });
  while (entries.length > opts.maxEntries) entries.shift();
}

// Sample a served hit through the verifier; learn thresholds; auto-tighten then
// auto-DISABLE if realised error stays over the disable rate.
function onServe(entry, sim, correctnessProbe) {
  hits++; entry.hits++;
  const nsRec = byNamespace.get(entry.ns); if (nsRec) nsRec.hits++;
  if (Math.random() >= opts.verifyRate) return;
  Promise.resolve(correctnessProbe ? correctnessProbe() : true).then((correct) => {
    verified++;
    if (!correct) {
      servedErrors++; entry.errors++;
      entry.threshold = Math.min(0.999, Math.max(entry.threshold, sim + 0.02));
    }
    const rate = servedErrors / verified;
    if (verified >= 5 && rate > opts.targetError) { // auto-tighten
      opts.baseThreshold = Math.min(0.999, opts.baseThreshold + 0.005);
      for (const e of entries) e.threshold = Math.max(e.threshold, opts.baseThreshold);
    }
    if (verified >= opts.disableMinSamples && rate > opts.disableErrorRate && !autoDisabled) { // auto-disable + alert
      autoDisabled = true; autoDisabledReason = `realised error ${(rate * 100).toFixed(1)}% > disable threshold ${(opts.disableErrorRate * 100).toFixed(0)}% over ${verified} samples`;
      console.error(`[semcache] ALERT: semantic cache AUTO-DISABLED — ${autoDisabledReason}. Falling back to exact/prefix only.`);
    }
  }).catch(() => { /* learning is best-effort */ });
}

const dryCorrect = (sim) => sim >= 0.98;

function stats() {
  const avgThreshold = entries.length ? entries.reduce((s, e) => s + e.threshold, 0) / entries.length : opts.baseThreshold;
  return {
    enabled: opts.enabled, active: enabled(), autoDisabled, autoDisabledReason,
    entries: entries.length, namespaces: byNamespace.size,
    hits, verified, servedErrors,
    realisedErrorRate: verified ? servedErrors / verified : null, // null = NOT YET MEASURED (don't claim safe)
    targetError: opts.targetError, disableErrorRate: opts.disableErrorRate,
    baseThreshold: opts.baseThreshold, avgThreshold, minSimilarity: opts.minSimilarity,
    ttlSec: opts.ttlSec, version: opts.version, bypassCount, similarityDistribution: { ...simBuckets },
    embedTokens, embedCostUsd
  };
}

module.exports = {
  enabled, isBypassed, recordBypass, sanitize, lookup, addEntry, onServe, stats, embed, cosine, dryCorrect, nsOf,
  reset, configure, setEmbedder, _entries: () => entries, _autoDisabled: () => autoDisabled
};
