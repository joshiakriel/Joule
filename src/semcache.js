"use strict";
const config = require("./config");

/**
 * Layer 2 — SEMANTIC cache (opt-in). Returns a cached answer for a *semantically
 * similar* (not identical) prompt. This CAN return a different question's answer,
 * so it is a GENUINE QUALITY RISK — never described as risk-free.
 *
 * We bound the risk vCache-style: each cached entry carries its OWN learned
 * similarity threshold (not one global cosine cutoff). A sample of served hits is
 * verified; when a served answer is wrong we RAISE that entry's threshold above
 * the offending similarity, and if the realised error rate exceeds the target we
 * tighten globally. The realised error rate is tracked and reported honestly, and
 * savings are reported NET of embedding spend. Runs ONLY on a Layer-1 miss, so
 * exact/prefix hits never pay the embedding cost.
 */

const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const estTokens = (t) => Math.max(1, Math.round(String(t || "").length / 4));

// ---- state (in-memory; ephemeral — see Known limitations) ----
let entries = [];                 // { id, model, vec, completion, promptTokens, completionTokens, threshold, hits, errors, ts }
let embedCache = new Map();        // norm(text) -> vector (never re-embed an identical prompt)
let seq = 0;
let embedTokens = 0, embedCostUsd = 0;
let hits = 0, verified = 0, servedErrors = 0;
let opts = { ...config.semanticCache };
let embedder = null;               // injectable for tests

function reset() {
  entries = []; embedCache = new Map(); seq = 0; embedTokens = 0; embedCostUsd = 0;
  hits = 0; verified = 0; servedErrors = 0; opts = { ...config.semanticCache }; embedder = null;
}
function configure(p) { opts = { ...opts, ...p }; }
function setEmbedder(fn) { embedder = fn; } // (text) => number[] , for deterministic tests
const enabled = () => opts.enabled;

// deterministic offline embedding: L2-normalised hashed bag-of-words
function hashEmbed(text) {
  const dim = 64, v = new Array(dim).fill(0);
  for (const tok of norm(text).split(" ").filter(Boolean)) {
    let h = 0; for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
    v[h % dim] += 1;
  }
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

async function embed(text) {
  const key = norm(text);
  if (embedCache.has(key)) return embedCache.get(key); // never re-embed an identical prompt
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
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  const na = Math.sqrt(dot(a, a)) || 1, nb = Math.sqrt(dot(b, b)) || 1;
  return dot(a, b) / (na * nb);
}

// Look up a semantically similar cached answer for the SAME model. Embeds the
// query (paid here — a Layer-1 miss). Returns a hit only when similarity clears
// the matched entry's OWN learned threshold.
async function lookup(model, userText) {
  if (!opts.enabled) return null;
  const vec = await embed(userText);
  let best = null, bestSim = -1;
  for (const e of entries) {
    if (e.model !== model) continue;
    const sim = cosine(vec, e.vec);
    if (sim > bestSim) { bestSim = sim; best = e; }
  }
  if (best && bestSim >= best.threshold) return { entry: best, sim: bestSim, vec };
  return { entry: null, sim: bestSim, vec }; // miss — caller will addEntry after generating
}

function addEntry({ model, userText, vec, completion, promptTokens, completionTokens }) {
  if (!opts.enabled) return;
  entries.push({ id: "sc-" + (seq++), model, vec: vec || hashEmbed(userText), completion, promptTokens, completionTokens, threshold: opts.baseThreshold, hits: 0, errors: 0, ts: Date.now() });
  while (entries.length > opts.maxEntries) entries.shift();
}

// Record that we SERVED a semantic hit; sample a fraction to learn thresholds.
function onServe(entry, sim, correctnessProbe) {
  hits++; entry.hits++;
  if (Math.random() >= opts.verifyRate) return;
  // correctnessProbe() -> boolean (or a Promise); learn from the outcome
  Promise.resolve(correctnessProbe ? correctnessProbe() : true).then((correct) => {
    verified++;
    if (!correct) {
      servedErrors++; entry.errors++;
      entry.threshold = Math.min(0.999, Math.max(entry.threshold, sim + 0.02)); // never serve this loose again
    }
    // if the realised error rate exceeds target, tighten globally (raise the floor)
    if (verified >= 5 && servedErrors / verified > opts.targetError) {
      opts.baseThreshold = Math.min(0.999, opts.baseThreshold + 0.005);
      for (const e of entries) e.threshold = Math.max(e.threshold, opts.baseThreshold);
    }
  }).catch(() => { /* learning is best-effort */ });
}

// Default DRY_RUN correctness proxy: only near-identical prompts are truly "correct".
const dryCorrect = (sim) => sim >= 0.98;

function stats() {
  const avgThreshold = entries.length ? entries.reduce((s, e) => s + e.threshold, 0) / entries.length : opts.baseThreshold;
  return {
    enabled: opts.enabled, entries: entries.length, hits, verified,
    servedErrors, realisedErrorRate: verified ? servedErrors / verified : null,
    targetError: opts.targetError, baseThreshold: opts.baseThreshold, avgThreshold,
    embedTokens, embedCostUsd
  };
}

module.exports = {
  enabled, lookup, addEntry, onServe, stats, embed, cosine, dryCorrect,
  reset, configure, setEmbedder, _entries: () => entries
};
