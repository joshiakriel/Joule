"use strict";
const path = require("path");
const express = require("express");
const config = require("./config");
const { classify, selectModel, tierForModel } = require("./router");
const { getIntensity, invalidate: invalidateIntensity } = require("./carbon");
const { compute } = require("./metrics");
const store = require("./store");
const verify = require("./verify");
const { redact } = require("./redact");

// Replace any live secret value with *** before a string leaves the process
// (error messages, etc.). Secrets are never logged or returned by any endpoint.
function scrub(s) {
  let out = String(s == null ? "" : s);
  for (const secret of [config.upstreamApiKey, config.emToken]) {
    if (secret && secret.length >= 4) out = out.split(secret).join("***");
  }
  return out;
}

store.init();
verify.init();       // load calibration + migrate existing judge scores
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// ---- tiny normalized cache (exact-match after normalization) ----
const cache = new Map(); // key -> { completion, ts }
const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > config.cacheTtlMs) { cache.delete(key); return null; }
  return hit.completion;
}
function cacheSet(key, completion) { cache.set(key, { completion, ts: Date.now() }); }

const lastUserText = (messages) => {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user") {
      const c = messages[i].content;
      return typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text || "").join(" ") : "";
    }
  }
  return "";
};

// estimate tokens when a provider doesn't return usage (~4 chars/token)
const estTokens = (text) => Math.max(1, Math.round((text || "").length / 4));

// build a full (non-stream) completion object — used to warm the cache from a
// streamed answer so later identical requests (stream or not) can hit the cache.
const buildCompletion = ({ id, created, model, content, promptTokens, completionTokens }) => ({
  id, object: "chat.completion", created, model,
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
});

// A client may tag a run of calls with an X-Joule-Session header so they group
// into one "session" in the dashboard. Sanitised so it's safe in CSV/JSON.
const sessionOf = (req) => {
  const raw = String(req.get("x-joule-session") || "").replace(/[",\r\n]/g, "").trim();
  return raw ? raw.slice(0, 64) : null;
};

// meter + log a request identically for streaming and non-streaming paths.
// Returns the compute result with the stored record attached as `.rec` (so the
// caller can hand it to the background verifier).
function meterAndLog({ started, mode, model, tier, decision, grid, promptTokens, completionTokens, session, qualityEscalated, routing, promptText, completionText }) {
  const m = compute({ model, tier, promptTokens, completionTokens, gPerKwh: grid.gPerKwh, cached: mode === "cache" });
  const rec = {
    ts: new Date().toISOString(), mode, cached: mode === "cache",
    model, tier, signals: decision.signals, confidence: decision.confidence,
    promptTokens, completionTokens, totalTokens: m.totalTokens,
    actual: m.actual, baseline: m.baseline, saved: m.saved,
    grid, latencyMs: Date.now() - started, session: session || null,
    qualityEscalated: Boolean(qualityEscalated), routing: routing || null
  };
  // Retention is OFF by default: prompt/response TEXT is persisted only when
  // LOG_PROMPTS=true, and PII-redacted first when PII_REDACT=true.
  if (config.logPrompts) {
    rec.prompt = config.piiRedact ? redact(promptText || "") : (promptText || "");
    rec.completion = config.piiRedact ? redact(completionText || "") : (completionText || "");
  }
  m.rec = store.add(rec);
  return m;
}

// ---- SSE helpers (OpenAI chat.completion.chunk shape) ----
const sseSend = (res, obj) => res.write("data: " + JSON.stringify(obj) + "\n\n");
const sseHeaders = (res) => {
  res.set({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  if (res.flushHeaders) res.flushHeaders();
};
// synthesize an SSE stream for a known answer (dry-run + cache-hit paths)
function streamText(res, { id, created, model, content }) {
  const base = { id, object: "chat.completion.chunk", created, model };
  sseSend(res, { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  const parts = String(content).match(/\S+\s*/g) || [String(content)]; // word-ish chunks
  for (const p of parts) sseSend(res, { ...base, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
  sseSend(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  res.write("data: [DONE]\n\n");
  res.end();
}

// ---------------------------------------------------------------------------
// Streaming path (body.stream === true). Emits an OpenAI-style SSE stream while
// still routing, metering and logging. NOTE: metrics can't ride on response
// headers here (they're flushed before usage is known) — streamed requests are
// metered via the store, so they still appear in /api/stats and /api/report.
// ---------------------------------------------------------------------------
async function handleStreaming({ res, started, body, userText, decision, tier, model, cacheKey, grid, session, qualityEscalated, routing }) {
  const id = "joule-stream-" + started;
  const created = Math.floor(started / 1000);

  // cache hit — replay the cached answer as an SSE stream
  const cached = cacheGet(cacheKey);
  if (cached) {
    const content = cached.choices?.[0]?.message?.content || "";
    sseHeaders(res);
    streamText(res, { id, created, model, content });
    const promptTokens = cached.usage?.prompt_tokens ?? estTokens(userText);
    const completionTokens = cached.usage?.completion_tokens ?? estTokens(content);
    meterAndLog({ started, mode: "cache", model, tier, decision, grid, promptTokens, completionTokens, session, qualityEscalated, routing, promptText: userText, completionText: content });
    return;
  }

  // dry-run — synthesize a streamed answer, no external call
  if (config.dryRun) {
    const answer = `【dry-run】 streamed from ${model} (${tier}). Set DRY_RUN=false and UPSTREAM_API_KEY to make real calls.`;
    sseHeaders(res);
    streamText(res, { id, created, model, content: answer });
    const promptTokens = estTokens(userText);
    const completionTokens = estTokens(answer);
    cacheSet(cacheKey, buildCompletion({ id, created, model, content: answer, promptTokens, completionTokens }));
    const mDry = meterAndLog({ started, mode: "dry_run", model, tier, decision, grid, promptTokens, completionTokens, session, qualityEscalated, routing, promptText: userText, completionText: answer });
    verify.maybeVerify({ rec: mDry.rec, userText, answer, body });
    return;
  }

  // live — forward with stream:true and pipe chunks through unmodified
  if (!config.upstreamApiKey) {
    return res.status(400).json({ error: { message: "UPSTREAM_API_KEY not set. Set it, or run with DRY_RUN=true to test the pipeline." } });
  }
  const upstream = await fetch(config.upstreamBaseUrl + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + config.upstreamApiKey },
    // include_usage asks the provider to emit a final usage-bearing chunk; harmless where ignored
    body: JSON.stringify({ ...body, model, stream: true, stream_options: { include_usage: true } }),
    signal: AbortSignal.timeout(120000)
  });
  if (!upstream.ok) {
    const data = await upstream.json().catch(() => ({ error: { message: "upstream error " + upstream.status } }));
    return res.status(upstream.status).json(data);
  }

  sseHeaders(res);
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", acc = "", usage = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    res.write(text); // pipe upstream chunks to the client unmodified
    buffer += text;
    // parse complete SSE lines to capture usage + accumulate assistant text
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload);
        if (obj.usage) usage = obj.usage;
        const d = obj.choices?.[0]?.delta?.content;
        if (d) acc += d;
      } catch { /* partial or non-JSON line — ignore */ }
    }
  }
  res.end();

  // token usage from the stream if the provider sent it, else estimate
  const promptTokens = usage?.prompt_tokens ?? estTokens(userText);
  const completionTokens = usage?.completion_tokens ?? estTokens(acc);
  cacheSet(cacheKey, buildCompletion({ id, created, model, content: acc, promptTokens, completionTokens }));
  const mLive = meterAndLog({ started, mode: "live", model, tier, decision, grid, promptTokens, completionTokens, session, qualityEscalated, routing, promptText: userText, completionText: acc });
  verify.maybeVerify({ rec: mLive.rec, userText, answer: acc, body, completion: buildCompletion({ id, created, model, content: acc, promptTokens, completionTokens }) });
}

// ---------------------------------------------------------------------------
// OpenAI-compatible endpoint. Point any OpenAI SDK's baseURL at http://host/v1
// ---------------------------------------------------------------------------
app.post("/v1/chat/completions", async (req, res) => {
  const started = Date.now();
  try {
    const body = req.body || {};
    const messages = body.messages || [];
    const userText = lastUserText(messages);
    const session = sessionOf(req);

    // 1) classify + route
    const decision = classify(userText);
    const routed = config.routingEnabled;
    let tier = routed ? decision.tier : tierForModel(body.model);
    // Quality gate: for small-classified requests, keep small only when the
    // calibrated score clears the conformal threshold (once calibrated); otherwise
    // fall back to the classifier/safety behaviour. Honours X-Joule-Quality-Floor.
    let qualityEscalated = false, routing = null;
    if (routed && tier === "small") {
      const floor = parseFloat(req.get("x-joule-quality-floor"));
      routing = verify.gate(decision, floor);
      if (!routing.routeSmall) { tier = "large"; qualityEscalated = true; }
    }
    const model = routed ? selectModel(tier) : (body.model || selectModel(tier));

    // 2) cache
    const cacheKey = model + "::" + norm(userText);
    const grid = await getIntensity();

    // streaming branch — SSE out, metered via the store (not response headers)
    if (body.stream === true) {
      return await handleStreaming({ res, started, body, userText, decision, tier, model, cacheKey, grid, session, qualityEscalated, routing });
    }

    const cachedCompletion = cacheGet(cacheKey);
    let completion, promptTokens, completionTokens, mode;

    if (cachedCompletion) {
      completion = cachedCompletion;
      promptTokens = completion.usage?.prompt_tokens ?? estTokens(userText);
      completionTokens = completion.usage?.completion_tokens ?? 0;
      mode = "cache";
    } else if (config.dryRun) {
      // full pipeline, synthesized answer — clearly labelled, no external call
      const answer = `【dry-run】 routed to ${model} (${tier}). Set DRY_RUN=false and UPSTREAM_API_KEY to make real calls.`;
      promptTokens = estTokens(userText);
      completionTokens = estTokens(answer);
      completion = {
        id: "joule-dry-" + started, object: "chat.completion", created: Math.floor(started / 1000),
        model, choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
      };
      mode = "dry_run";
    } else {
      // real upstream call
      if (!config.upstreamApiKey) {
        return res.status(400).json({ error: { message: "UPSTREAM_API_KEY not set. Set it, or run with DRY_RUN=true to test the pipeline." } });
      }
      const upstream = await fetch(config.upstreamBaseUrl + "/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + config.upstreamApiKey },
        body: JSON.stringify({ ...body, model }),
        signal: AbortSignal.timeout(120000)
      });
      const data = await upstream.json();
      if (!upstream.ok) return res.status(upstream.status).json(data);
      completion = data;
      promptTokens = data.usage?.prompt_tokens ?? estTokens(userText);
      completionTokens = data.usage?.completion_tokens ?? estTokens(JSON.stringify(data.choices?.[0]?.message?.content || ""));
      mode = "live";
    }

    // populate cache for any freshly-generated completion (dry_run or live)
    if (mode !== "cache") cacheSet(cacheKey, completion);

    // 3) meter + 4) log (shared with the streaming path)
    const m = meterAndLog({ started, mode, model, tier, decision, grid, promptTokens, completionTokens, session, qualityEscalated, routing, promptText: userText, completionText: completion.choices?.[0]?.message?.content || "" });

    // 5) expose metrics on headers (drop-in clients still get a clean OpenAI body)
    res.set({
      "x-joule-mode": mode,
      "x-joule-tier": tier,
      "x-joule-model": model,
      "x-joule-cost-usd": m.actual.costUsd.toFixed(6),
      "x-joule-energy-wh": m.actual.energyWh.toFixed(4),
      "x-joule-co2-g": m.actual.carbonG.toFixed(4),
      "x-joule-saved-usd": m.saved.costUsd.toFixed(6),
      "x-joule-saved-co2-g": m.saved.carbonG.toFixed(4)
    });
    res.json(completion);

    // 6) quality verification — AFTER the response, off the serving path
    verify.maybeVerify({ rec: m.rec, userText, answer: completion.choices?.[0]?.message?.content || "", body, completion });
  } catch (err) {
    // once an SSE stream has started, headers are already flushed — just end it
    if (res.headersSent) { try { res.end(); } catch { /* client gone */ } }
    else res.status(502).json({ error: { message: scrub("joule proxy error: " + err.message) } });
  }
});

// Combine per-view verification stats (from the filtered totals) with the global
// rolling-quality + safety-mode state. `score` is null until >=1 sample verified.
function qualityBlock(totals) {
  const q = verify.qualityStats();
  return {
    score: totals.qualityScore,                                                     // avg quality of verified records IN VIEW
    verified: totals.verified,
    verifiedPct: totals.requests ? Math.round((totals.verified / totals.requests) * 100) : 0,
    rollingScore: q.rollingScore,                                                   // global rolling (null until first sample)
    sampleCount: q.sampleCount, sampleRate: q.sampleRate, threshold: q.threshold,
    safetyMode: q.safetyMode, enabled: q.enabled, referenceModel: q.referenceModel, judgeModels: q.judgeModels,
    overhead: q.overhead,                                                           // verification token overhead
    net: totals.net,                                                                // savings minus verification overhead
    // calibrated + conformal verification (the guarantee — marginal, not per-query)
    mode: q.mode, guaranteeReady: q.guaranteeReady, lowAgreementCount: q.lowAgreementCount,
    calibration: q.calibration,                                                     // {n, ready, minN, ece}
    conformal: q.conformal,                                                         // {alpha, threshold, coverage, riskBound, n, ready}
    drift: q.drift                                                                  // {status, drift, ...}
  };
}

// Deployment / residency posture — we DESCRIBE it; we do not certify legal compliance.
function deploymentBlock() {
  const crossBorder = String(config.dataRegion).toUpperCase() !== String(config.providerRegion).toUpperCase();
  return {
    mode: config.deploymentMode,
    dataRegion: config.dataRegion,
    providerRegion: config.providerRegion,
    crossBorder,                              // prompts leave dataRegion to reach the provider
    promptTextRetained: config.logPrompts,     // false by default (metadata-only)
    piiRedaction: config.piiRedact
  };
}

// ---- dashboard data ----
app.get("/api/stats", async (_req, res) => {
  const grid = await getIntensity();
  const totals = store.aggregate();
  res.json({
    deployment: deploymentBlock(),
    config: {
      dryRun: config.dryRun,
      routingEnabled: config.routingEnabled,
      hasUpstreamKey: Boolean(config.upstreamApiKey),
      hasEmToken: Boolean(config.emToken),
      modelSmall: config.modelSmall, modelLarge: config.modelLarge,
      upstreamBaseUrl: config.upstreamBaseUrl
    },
    grid,
    totals,
    quality: qualityBlock(totals),
    recent: store.recent(25)
  });
});

// Validate the shared filter query used by /api/summary and /api/report.
function parseFilter(q) {
  return {
    range: ["1h", "24h", "7d", "all"].includes(q.range) ? q.range : "all",
    tier: ["small", "large"].includes(q.tier) ? q.tier : null,
    mode: ["live", "dry_run", "cache"].includes(q.mode) ? q.mode : null,
    q: typeof q.q === "string" ? q.q.slice(0, 64) : ""
  };
}

// Server-computed aggregates + time-series + per-model + sessions, all from the
// real log and filtered by range/tier/mode/model — the dashboard renders this so
// UI and server always agree. /v1/chat/completions behaviour is unchanged.
app.get("/api/summary", (req, res) => {
  const sum = store.summary(parseFilter(req.query));
  sum.quality = qualityBlock(sum.totals);
  res.json(sum);
});

// Truly clear the request log (in memory + on disk). Destructive by design.
app.post("/api/clear", (_req, res) => {
  const removed = store.clear();
  res.json({ cleared: true, removed });
});

// Cumulative ROI since day one — real logged data only; empty state when no history.
app.get("/api/roi", (_req, res) => {
  const rollups = store.dailyRollups();
  const subMonthly = config.subscriptionCostMonthly;
  if (!rollups.length) {
    return res.json({ empty: true, startDate: null, lifetime: null, series: [], net: null, subscriptionMonthly: subMonthly });
  }
  const totals = store.aggregate();
  const startDate = rollups[0].date, endDate = rollups[rollups.length - 1].date;
  const days = Math.max(1, Math.round((new Date(endDate + "T00:00:00Z") - new Date(startDate + "T00:00:00Z")) / 86400000) + 1);
  const months = days / 30.4375;
  let cCost = 0, cCarbon = 0, cVerify = 0;
  const series = rollups.map((r) => {
    cCost += r.cost.saved; cCarbon += r.carbonG.saved; cVerify += r.verifyCost.costUsd;
    return { date: r.date, savedCost: r.cost.saved, savedCarbonG: r.carbonG.saved, cumSavedCost: cCost, cumSavedCarbonG: cCarbon, cumVerifyCost: cVerify };
  });
  const grossSaved = totals.cost.saved, verifyCost = totals.verifyCost.costUsd;
  const subscriptionToDate = subMonthly * months;
  const monthlyNetBeforeSub = (grossSaved - verifyCost) / months;
  res.json({
    empty: false, startDate, endDate, days,
    lifetime: { requests: totals.requests, savedCost: grossSaved, savedCarbonG: totals.carbonG.saved, savedEnergyWh: totals.energyWh.saved, verifyCost, avgQuality: totals.qualityScore },
    series,
    net: {
      grossSaved, verifyCost, subscriptionMonthly: subMonthly, subscriptionToDate,
      netAfterFees: grossSaved - verifyCost - subscriptionToDate,
      avgMonthlySaving: grossSaved / months,
      paybackMonths: (subMonthly > 0 && monthlyNetBeforeSub > 0) ? subMonthly / monthlyNetBeforeSub : null
    }
  });
});

// ---- runtime configuration (masked; secret-free) ----------------------------
// A MASKED, secret-free view of the effective config plus per-field provenance.
// Secrets are reported only as booleans + last-4; the raw values never leave here.
function maskedConfig() {
  const key = config.upstreamApiKey;
  const fields = ["dryRun", "routingEnabled", "modelSmall", "modelLarge", "upstreamBaseUrl", "gridZone", "upstreamApiKey", "emToken"];
  const sources = {};
  for (const f of fields) sources[f] = config.sourceOf(f);
  return {
    dryRun: config.dryRun,
    routingEnabled: config.routingEnabled,
    modelSmall: config.modelSmall,
    modelLarge: config.modelLarge,
    upstreamBaseUrl: config.upstreamBaseUrl,
    gridZone: config.gridZone,
    hasUpstreamKey: Boolean(key),
    upstreamKeyLast4: key ? key.slice(-4) : null,
    hasEmToken: Boolean(config.emToken),
    sources
  };
}

// Per-field validators. Each returns the value to apply, or throws a safe message.
// Only these keys are accepted; anything else is rejected as an unknown field.
const strField = (v, name) => {
  if (typeof v !== "string" || !v.trim() || v.length > 120) throw name + " must be a non-empty string";
  return v.trim();
};
const boolField = (v, name) => {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "false") return v === "true";
  throw name + " must be a boolean";
};
const CONFIG_FIELDS = {
  upstreamApiKey: (v) => { if (typeof v !== "string") throw "upstreamApiKey must be a string"; return v.trim(); },
  emToken: (v) => { if (typeof v !== "string") throw "emToken must be a string"; return v.trim(); },
  upstreamBaseUrl: (v) => {
    if (typeof v !== "string") throw "upstreamBaseUrl must be a string";
    let u; try { u = new URL(v.trim()); } catch { throw "upstreamBaseUrl must be a valid URL"; }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw "upstreamBaseUrl must be http(s)";
    return v.trim();
  },
  modelSmall: (v) => strField(v, "modelSmall"),
  modelLarge: (v) => strField(v, "modelLarge"),
  gridZone: (v) => {
    if (typeof v !== "string" || !/^[A-Za-z0-9-]{1,20}$/.test(v)) throw "gridZone must be short alphanumeric/hyphen";
    return v;
  },
  routingEnabled: (v) => boolField(v, "routingEnabled"),
  dryRun: (v) => boolField(v, "dryRun")
};

app.get("/api/config", (_req, res) => res.json(maskedConfig()));

app.post("/api/config", (req, res) => {
  const body = req.body || {};
  const keys = Object.keys(body);
  const unknown = keys.filter((k) => !CONFIG_FIELDS[k]);
  if (unknown.length) return res.status(400).json({ error: { message: "unknown field(s): " + unknown.join(", ") } });

  const toApply = {};
  try {
    for (const k of keys) {
      const val = CONFIG_FIELDS[k](body[k]);
      // Blank secret means "leave as is" — don't wipe an env-provided secret.
      if ((k === "upstreamApiKey" || k === "emToken") && val === "") continue;
      toApply[k] = val;
    }
  } catch (msg) {
    return res.status(400).json({ error: { message: String(msg) } });
  }

  config.setOverrides(toApply);
  // A new region/token means the cached grid intensity is stale.
  if ("gridZone" in toApply || "emToken" in toApply) invalidateIntensity();
  res.json(maskedConfig());
});

// ---- audit-style report (JSON or CSV) — respects the active filters ----
app.get("/api/report", (req, res) => {
  const filter = parseFilter(req.query);
  const pred = store.predicateFor(filter);
  const rows = store.all().filter(pred);
  const totals = store.aggregate(pred);
  const period = {
    from: rows[0]?.ts || null,
    to: rows[rows.length - 1]?.ts || null,
    requests: rows.length,
    filter
  };
  if (req.query.format === "csv") {
    res.set("content-type", "text/csv");
    res.set("content-disposition", 'attachment; filename="joule-report.csv"');
    return res.send(store.toCsv(pred));
  }
  const q = verify.qualityStats();
  res.set("content-disposition", 'attachment; filename="joule-report.json"');
  res.json({
    report: "Joule — AI cost & emissions report",
    generatedAt: new Date().toISOString(),
    period,
    deployment: deploymentBlock(),  // mode, data/provider region, cross-border, retention, redaction
    methodology: {
      cost: "Exact: provider-returned token usage x configured per-model prices.",
      energy: "Estimated, DECODE-WEIGHTED: base[tier] + perKTokOut[tier] x (completion_tokens/1000) + perKTokIn[tier] x (prompt_tokens/1000), with perKTokIn an order of magnitude below perKTokOut. Measurement studies show inference energy is dominated by the decode phase — near-zero correlation with prompt length, scaling with tokens generated. Anchored to GPU characterisation (ML.ENERGY / Zeus / TokenPowerBench methodology) with IEA 'Energy & AI' for order-of-magnitude sanity. Configurable in src/config.js.",
      carbon: "energy(kWh) x grid carbon intensity (gCO2/kWh) from Electricity Maps, aligned to GHG Protocol Scope 2 (location-based).",
      verification: `Quality gating is CALIBRATED + CONFORMAL. A cheap per-request routing signal (router margin, no extra model call) is mapped to a probability of acceptability by isotonic regression (calibration set n=${q.calibration.n}, ECE=${q.calibration.ece == null ? "n/a" : q.calibration.ece.toFixed(3)}); a distribution-free conformal threshold bounds the probability of unacceptable degradation by alpha=${q.conformal.alpha}. The bound is MARGINAL (population-level), NOT a per-query guarantee, and distribution shift can violate it — always read n and alpha with any figure. Labels come from a SAMPLED (${Math.round(q.sampleRate * 100)}%) reference re-run + judge PANEL (${q.judgeModels.join(", ")}) with randomised answer order and agreement reporting; the judge is fallible and only LABELS calibration data, it does not gate live traffic. Below MIN_CALIBRATION_N=${q.calibration.minN} no guarantee is stated. Verification spends real tokens; net = routing savings − that overhead. References: ML.ENERGY/Zeus/TokenPowerBench (energy), FrugalGPT → Hybrid LLM (ICLR 2024) → conformal risk control (gating).`,
      standardsAlignment: ["GHG Protocol Scope 2 (location-based)", "SCI — Software Carbon Intensity (ISO/IEC 21031)"]
    },
    verification: {
      mode: q.mode,
      guaranteeReady: q.guaranteeReady,
      sampled: true,
      sampleRate: q.sampleRate,
      judgeModels: q.judgeModels,
      lowAgreementCount: q.lowAgreementCount,
      calibration: q.calibration,               // {n, ready, minN, ece}
      conformal: q.conformal,                   // {alpha, threshold, coverage, riskBound, n, ready}
      drift: q.drift,
      safetyMode: q.safetyMode,
      verified: totals.verified,
      qualityScore: totals.qualityScore,        // null until >=1 verified sample
      overhead: q.overhead,
      net: totals.net
    },
    totals
  });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, version: "0.1.0", dryRun: config.dryRun }));

// Only listen when run directly (`npm start`). When required as a module (tests),
// export the app so it can be mounted on an ephemeral port — behaviour is identical.
if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`\n  Joule proxy → http://localhost:${config.port}`);
    console.log(`  dashboard   → http://localhost:${config.port}/`);
    console.log(`  point clients at baseURL http://localhost:${config.port}/v1`);
    console.log(`  mode: ${config.dryRun ? "DRY_RUN (no external calls)" : "LIVE"} | routing: ${config.routingEnabled ? "on" : "off"} | grid zone: ${config.gridZone}\n`);
  });
}

module.exports = app;
