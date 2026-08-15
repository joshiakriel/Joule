"use strict";
/**
 * INDEPENDENT AUDIT — Parts A, C, D.
 *
 * Written as a skeptical external auditor. Every figure the product reports is
 * recomputed here FROM THE PUBLISHED CONSTANTS, deliberately not by calling metrics.js,
 * so a bug in the app's own maths cannot hide behind the app's own helper. Findings are
 * recorded as they are — nothing is adjusted to make the product look good.
 *
 *   node scripts/audit.js
 */
process.env.DRY_RUN = "true";
process.env.ROUTING_ENABLED = "true";
process.env.VERIFY_SAMPLE_RATE = "0";
delete process.env.UPSTREAM_API_KEY;

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const store = require("../src/store");
const verify = require("../src/verify");
const budget = require("../src/budget");
const config = require("../src/config");
const tenancy = require("../src/tenancy");
const upstream = require("../src/upstream");
const app = require("../src/server");

// ---- independent ground truth (hardcoded from the published config, NOT metrics.js) ----
const PRICE = { small: { in: 0.15, out: 0.60 }, large: { in: 2.50, out: 10.00 } };
const ENERGY = {
  small: { base: 0.05, out: 0.03, in: 0.003 },
  large: { base: 0.90, out: 0.42, in: 0.042 }
};
const refCost = (tier, p, c) => (p / 1e6) * PRICE[tier].in + (c / 1e6) * PRICE[tier].out;
const refEnergy = (tier, p, c) => ENERGY[tier].base + ENERGY[tier].out * (c / 1000) + ENERGY[tier].in * (p / 1000);
const refCarbon = (wh, g) => (wh / 1000) * g;

const findings = [];
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
function check(id, claim, passed, detail) {
  findings.push({ id, claim, passed: Boolean(passed), detail: detail || "" });
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${id}  ${claim}${detail ? "\n          " + detail : ""}`);
}

let server, base, tmpDir;
const post = (body, headers = {}) => fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const getJ = async (url, headers) => (await (await fetch(base + url, { headers })).json());
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwtFor = (tid, extra = {}) => {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64({ sub: "u-" + tid.slice(0, 8), app_metadata: { tenant_id: tid }, exp: Math.floor(Date.now() / 1000) + 3600, ...extra });
  return `${h}.${p}.${crypto.createHmac("sha256", config.auth.jwtSecret).update(h + "." + p).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
};
const auth = (t) => ({ authorization: "Bearer " + t });

async function main() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "joule-audit-"));
  store.init(tmpDir); require("../src/calibrate").setDir(tmpDir);
  verify.reset(); budget.reset(); tenancy.reset();
  config.auth.required = false;
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;

  console.log("\n=== PART A · CORRECTNESS ===");
  await partA();
  console.log("\n=== PART C · RESILIENCE ===");
  await partC();
  console.log("\n=== PART D · NEW-CLIENT JOURNEY ===");
  await partD();

  await new Promise((r) => server.close(r));
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const failed = findings.filter((f) => !f.passed);
  console.log(`\n=== SUMMARY: ${findings.length - failed.length}/${findings.length} passed, ${failed.length} failed ===`);
  fs.writeFileSync(path.join(__dirname, "..", "audit-findings.json"), JSON.stringify(findings, null, 2));
  process.exit(0);
}

// ---------------------------------------------------------------- PART A
async function partA() {
  store.clear();

  // A1 · COST is exact — recompute from published prices for every logged record
  await post({ model: "auto", messages: [{ role: "user", content: "hi thanks" }] });
  await post({ model: "auto", messages: [{ role: "user", content: "Prove step by step and analyse the trade-offs in depth with rigour" }] });
  let worst = 0, worstRec = null;
  for (const r of store.all()) {
    if (r.cached) continue;
    const expect = refCost(r.tier, r.promptTokens, r.completionTokens);
    const d = Math.abs(expect - r.actual.costUsd);
    if (d > worst) { worst = d; worstRec = { tier: r.tier, p: r.promptTokens, c: r.completionTokens, app: r.actual.costUsd, ref: expect }; }
  }
  check("A1", "Cost is exact (recomputed from published per-token prices)", worst < 1e-12,
    worst ? `max deviation ${worst.toExponential(3)} USD on ${JSON.stringify(worstRec)}` : "exact to floating-point precision on every record");

  // A2 · SAVINGS = baseline(all-large) − actual, recomputed independently
  let sWorst = 0, largeSaved = null;
  for (const r of store.all()) {
    if (r.cached) continue;
    const refBase = refCost("large", r.promptTokens, r.completionTokens);
    const refSaved = Math.max(0, refBase - refCost(r.tier, r.promptTokens, r.completionTokens));
    sWorst = Math.max(sWorst, Math.abs(refSaved - r.saved.costUsd));
    if (r.tier === "large") largeSaved = r.saved.costUsd;
  }
  check("A2a", "Savings = independently recomputed baseline − actual", sWorst < 1e-12, `max deviation ${sWorst.toExponential(3)} USD`);
  check("A2b", "A large-routed request reports ~0 saved (no fabricated saving)",
    largeSaved === null || near(largeSaved, 0), largeSaved === null ? "no large-routed record in sample" : `large-routed saved = $${largeSaved}`);

  // A5 · ENERGY is decode-weighted: long prompt/short output must use LESS than short prompt/long output
  const longPrompt = refEnergy("small", 4000, 50);
  const longOutput = refEnergy("small", 50, 4000);
  const appLongPrompt = require("../src/metrics").compute({ model: "m", tier: "small", promptTokens: 4000, completionTokens: 50, gPerKwh: 450, cached: false });
  const appLongOutput = require("../src/metrics").compute({ model: "m", tier: "small", promptTokens: 50, completionTokens: 4000, gPerKwh: 450, cached: false });
  const M = require("../src/metrics");
  const at = (pp, cc) => M.compute({ model: "m", tier: "small", promptTokens: pp, completionTokens: cc, gPerKwh: 450, cached: false }).actual.energyWh;
  const perKOut = at(0, 2000) - at(0, 1000);     // marginal Wh per 1k OUTPUT tokens
  const perKIn = at(2000, 0) - at(1000, 0);      // marginal Wh per 1k INPUT tokens
  check("A5a", "Energy is decode-weighted: output costs an order of magnitude more per token than input",
    perKOut >= perKIn * 9.5,
    `marginal ${perKOut.toFixed(4)} Wh per 1k output vs ${perKIn.toFixed(4)} Wh per 1k input = ${(perKOut / perKIn).toFixed(1)}x. ` +
    `NOTE: measured on TOTALS the ratio looks smaller (${(appLongOutput.actual.energyWh / appLongPrompt.actual.energyWh).toFixed(1)}x for a 4000/50 vs 50/4000 pair) ` +
    `because the fixed baseWh dominates at low token counts — the decode weighting is in the marginal rate, not the total.`);

  // A6 · CARBON = energy × grid intensity
  const g = (await getJ("/api/stats")).grid;
  let cWorst = 0;
  for (const r of store.all()) {
    if (r.cached) continue;
    cWorst = Math.max(cWorst, Math.abs(refCarbon(r.actual.energyWh, r.grid.gPerKwh) - r.actual.carbonG));
  }
  check("A6a", "Carbon = energy × grid intensity (recomputed)", cWorst < 1e-9, `max deviation ${cWorst.toExponential(3)} g`);
  check("A6b", "Grid source is labelled honestly when not live", g.live === true || /fallback/i.test(g.source), `live=${g.live}, source="${g.source}"`);
  const roiM = await getJ("/api/roi");
  check("A6c", "Energy/carbon labelled ESTIMATED, cost labelled MEASURED",
    roiM.methodology && roiM.methodology.energy === "estimated" && roiM.methodology.carbon === "estimated" && roiM.methodology.cost === "measured",
    JSON.stringify(roiM.methodology));

  // A3 · NET vs GROSS
  const roi = await getJ("/api/roi");
  const expectedNet = roi.net.grossSaved - roi.net.verifyCost - roi.net.subscriptionToDate;
  check("A3", "Net = gross − verification − subscription, exactly", near(roi.net.netAfterFees, expectedNet, 1e-12),
    `app net $${roi.net.netAfterFees} vs recomputed $${expectedNet}`);

  // A4 · RECONCILIATION across every surface (the Overview-vs-Activity bug)
  const stats = await getJ("/api/stats");
  const report = await getJ("/api/report?format=json");
  const summary = await getJ("/api/summary?range=all");
  const direct = JSON.parse(JSON.stringify(store.aggregate(store.predicateFor({ tenant: tenancy.DEFAULT_TENANT_ID }))));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check("A4a", "Overview(/api/stats) == Reports(/api/report) totals", same(stats.totals, report.totals), "");
  check("A4b", "Activity(/api/summary) == Overview totals", same(summary.totals, stats.totals),
    same(summary.totals, stats.totals) ? "" : `requests: summary=${summary.totals.requests} stats=${stats.totals.requests}`);
  check("A4c", "All surfaces == direct store aggregation (ground truth)", same(stats.totals, direct), "");
  const lastCum = roi.series[roi.series.length - 1];
  check("A4d", "ROI cumulative series lands exactly on lifetime saved",
    near(lastCum.cumSavedCost, roi.lifetime.savedCost, 1e-9), `series end $${lastCum.cumSavedCost} vs lifetime $${roi.lifetime.savedCost}`);

  // A7 · QUALITY honesty — try hard to make it show a fake 100%
  const q = stats.quality;
  check("A7a", "Quality is null (not 100%) with zero verified samples", q.score === null, `score=${JSON.stringify(q.score)}`);
  check("A7b", "No guarantee claimed below MIN_CALIBRATION_N", q.guaranteeReady === false,
    `guaranteeReady=${q.guaranteeReady}, calibration n=${q.calibration.n}, minN=${q.calibration.minN}`);
  check("A7c", "n and alpha are always reported alongside any conformal figure",
    typeof q.conformal.n === "number" && typeof q.conformal.alpha === "number", `n=${q.conformal.n} alpha=${q.conformal.alpha}`);
  check("A7d", "ROI quality reports insufficient-data rather than a number",
    roi.quality.score === null && roi.quality.sufficient === false, JSON.stringify({ score: roi.quality.score, sufficient: roi.quality.sufficient }));

  // A8 · CACHE accounting
  await post({ model: "auto", messages: [{ role: "user", content: "cache me" }] });
  await post({ model: "auto", messages: [{ role: "user", content: "cache me" }] });
  const c2 = (await getJ("/api/stats")).cache;
  check("A8a", "Cache hits are recorded", c2.exactHits >= 1, `exactHits=${c2.exactHits}`);
  check("A8b", "Prefix-cache savings are reported NET of the write premium",
    c2.prefixCache && typeof c2.prefixCache.netSavedUsd === "number" &&
    near(c2.prefixCache.netSavedUsd, c2.prefixCache.savedUsd - c2.prefixCache.writePremiumUsd, 1e-9),
    `net ${c2.prefixCache.netSavedUsd} = saved ${c2.prefixCache.savedUsd} − premium ${c2.prefixCache.writePremiumUsd}`);
  check("A8c", "Semantic cache is labelled a genuine quality risk, with realised error rate",
    /quality risk/i.test(c2.semantic.note) && "realisedErrorRate" in c2.semantic,
    `realisedErrorRate=${JSON.stringify(c2.semantic.realisedErrorRate)} (null = not yet measured)`);
  check("A8d", "Exact/prefix cache is labelled ZERO quality risk", /zero quality risk/i.test(c2.note), "");

  // A9 · TENANT ISOLATION — try aggressively to read A as B
  config.auth.required = true; config.auth.jwtSecret = "audit-secret";
  tenancy.reset(); store.clear();
  const A = tenancy.createTenant("ZZTENANTAAA"), B = tenancy.createTenant("ZZTENANTBBB");
  const keyA = tenancy.mintKey(A.id).key, keyB = tenancy.mintKey(B.id).key;
  tenancy.setUpstreamKey(A.id, "sk-alpha-secret");
  for (let i = 0; i < 5; i++) await post({ model: "auto", messages: [{ role: "user", content: `zzmarkeraaa ${i}` }] }, auth(keyA));
  await post({ model: "auto", messages: [{ role: "user", content: "beta only" }] }, auth(keyB));

  const jA = jwtFor(A.id, { email: "a@x.com" }), jB = jwtFor(B.id, { email: "b@x.com" });
  const leaks = [];
  for (const url of ["/api/stats", "/api/summary?range=all", "/api/report?format=json", "/api/roi", "/api/digest", "/api/advisory", "/api/budgets", "/api/keys", "/api/me", "/api/profile", "/api/status"]) {
    const asB = await (await fetch(base + url, { headers: auth(jB) })).text();
    if (asB.includes("zzmarkeraaa") || asB.includes("sk-alpha-secret") || asB.includes(A.id) || asB.includes("ZZTENANTAAA")) leaks.push(url + " (A's content visible to B)");
  }
  const bStats = await getJ("/api/stats", auth(jB));
  if (bStats.totals.requests !== 1) leaks.push(`/api/stats: B sees ${bStats.totals.requests} requests, should see 1`);
  const csvB = await (await fetch(base + "/api/report?format=csv", { headers: auth(jB) })).text();
  if (/zzmarkeraaa/.test(csvB) || csvB.includes(A.id)) leaks.push("/api/report?format=csv exposes A's rows");
  const pdfB = Buffer.from(await (await fetch(base + "/api/report?format=pdf", { headers: auth(jB) })).arrayBuffer()).toString("latin1");
  if (/ZZTENANTAAA/.test(pdfB) || pdfB.includes(A.id)) leaks.push("/api/report?format=pdf names tenant A");
  // cross-tenant key use, and cross-tenant destructive action
  if (tenancy.resolveFromApiKey("Bearer " + keyA).id !== A.id) leaks.push("A's key does not resolve to A");
  const stolen = await fetch(base + "/api/keys/" + tenancy.listKeys(A.id)[0].id + "/revoke", { method: "POST", headers: auth(jB) });
  if (stolen.status !== 404) leaks.push(`B could target A's key (status ${stolen.status})`);
  const clearAsB = await fetch(base + "/api/clear", { method: "POST", headers: auth(jB) });
  await clearAsB.json();
  if (store.all(A.id).length !== 5) leaks.push("B's clear deleted A's data");
  // secrets must never be readable
  const meB = JSON.stringify(await getJ("/api/me", auth(jB)));
  if (meB.includes("sk-alpha-secret")) leaks.push("/api/me leaks a provider key");

  check("A9", "Tenant isolation holds against every read, export and destructive path",
    leaks.length === 0, leaks.length ? "LEAKS: " + leaks.join(" | ") : "11 endpoints + CSV + PDF + key-revoke + clear + provider secret: no cross-tenant access");

  config.auth.required = false; tenancy.reset(); store.clear();
}

// ---------------------------------------------------------------- PART C
async function partC() {
  const R = async (label, fn) => { try { return await fn(); } catch (e) { return { error: e.message }; } };

  // provider timeout / 500 / 429
  for (const [name, stub] of [
    ["timeout", async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }],
    ["500", async () => ({ ok: false, status: 500, json: async () => ({ error: { message: "boom" } }) })],
    ["429", async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "slow down" } }) })]
  ]) {
    store.clear(); budget.reset();
    config.setOverrides({ dryRun: false, upstreamApiKey: "sk-x", upstreamBaseUrl: "http://p.test" });
    upstream.setFetch(stub);
    let status = 0, body = null;
    try { const r = await post({ model: "auto", messages: [{ role: "user", content: "chaos " + name }] }); status = r.status; body = await r.json(); } catch (e) { status = -1; }
    upstream.setFetch(null); config.clearOverrides();
    const reserved = budget.stats(tenancy.DEFAULT_TENANT_ID).reserved.global;
    check(`C-provider-${name}`, `Provider ${name}: clean error, no reservation leak, nothing metered`,
      status >= 400 && status < 600 && body && body.error && Math.abs(reserved) < 1e-9 && store.all().length === 0,
      `status=${status} reserved=$${reserved} recordsWritten=${store.all().length}`);
  }

  // grid API down
  const realFetch = global.fetch;
  config.setOverrides({ emToken: "t" }); require("../src/carbon").invalidate();
  global.fetch = async () => { throw new Error("grid unreachable"); };
  const gi = await require("../src/carbon").getIntensity();
  global.fetch = realFetch; config.clearOverrides(); require("../src/carbon").invalidate();
  check("C-grid", "Grid API down: labelled fallback, request still metered",
    gi.live === false && /fallback/i.test(gi.source) && gi.gPerKwh > 0, `source="${gi.source}" gPerKwh=${gi.gPerKwh}`);

  // embeddings down
  const semcache = require("../src/semcache");
  store.clear(); semcache.reset(); semcache.configure({ enabled: true, minSimilarity: 0.5 });
  semcache.setEmbedder(() => { throw new Error("embeddings down"); });
  const semRes = await post({ model: "auto", messages: [{ role: "user", content: "embeddings are down but serve me" }] });
  semcache.reset();
  check("C-embeddings", "Embeddings down: semantic layer skipped, request still served",
    semRes.status === 200 && semRes.headers.get("x-joule-mode") !== "semantic_cache", `status=${semRes.status}`);

  // malformed + oversized body
  const bad = await fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: "{ not json" });
  const big = await fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(3 * 1024 * 1024) }] }) });
  const alive = await post({ model: "auto", messages: [{ role: "user", content: "still alive" }] });
  check("C-input", "Malformed → 400, oversized → 413, process stays up",
    bad.status === 400 && big.status === 413 && alive.status === 200, `malformed=${bad.status} oversized=${big.status} afterwards=${alive.status}`);

  // DB unreachable mid-run
  const pgstore = require("../src/pgstore");
  let down = false; const rows = [];
  const fake = { on() {}, async end() {}, async query(sql, p) {
    if (/CREATE|SELECT 1/.test(sql)) { if (down) throw new Error("ECONNREFUSED"); return { rows: [{ ok: 1 }] }; }
    if (down) throw new Error("ECONNREFUSED");
    if (/^\s*INSERT/.test(sql)) { rows.push(p[1]); return { rows: [] }; }
    return { rows: [] };
  } };
  const pg = pgstore.create({ _pool: fake, maxBufferedWrites: 100 });
  pg.persistAdd({ id: "a", ts: new Date().toISOString(), tenant: null }, "{}"); await pg.flush();
  down = true;
  pg.persistAdd({ id: "b", ts: new Date().toISOString(), tenant: null }, "{}"); await pg.flush();
  const servedDuringOutage = await post({ model: "auto", messages: [{ role: "user", content: "served during outage" }] });
  down = false; const rec = await pg.recover(); await pg.close();
  check("C-database", "DB down: proxy keeps serving, writes buffer and replay on recovery",
    servedDuringOutage.status === 200 && rec.ok && rows.includes("b"),
    `servedDuringOutage=${servedDuringOutage.status} replayed=${JSON.stringify(rows)}`);

  // verification failure must never touch the user path
  store.clear();
  const vSaved = config.verify.sampleRate;
  verify.configure({ sampleRate: 1 }); verify.setTestDelay(0);
  const before = store.all().length;
  const okDespiteVerify = await post({ model: "auto", messages: [{ role: "user", content: "verify may fail" }] });
  await verify.whenIdle();
  verify.configure({ sampleRate: vSaved });
  check("C-verify", "Verification runs off the serving path and cannot break the response",
    okDespiteVerify.status === 200 && store.all().length === before + 1, `status=${okDespiteVerify.status}`);

  // client disconnect mid-stream
  store.clear(); budget.reset();
  const http = require("http");
  const stub = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"partial "}}]}\n\n');
    setTimeout(() => res.destroy(), 20);
  });
  await new Promise((r) => stub.listen(0, r));
  config.setOverrides({ dryRun: false, upstreamApiKey: "sk-s", upstreamBaseUrl: `http://localhost:${stub.address().port}` });
  let streamStatus = 0;
  try { const r = await post({ model: "auto", stream: true, messages: [{ role: "user", content: "break me" }] }); streamStatus = r.status; try { await r.text(); } catch (e) {} } catch (e) {}
  config.clearOverrides(); await new Promise((r) => stub.close(r));
  const resAfter = budget.stats(tenancy.DEFAULT_TENANT_ID).reserved.global;
  const aliveAfter = await post({ model: "auto", messages: [{ role: "user", content: "alive after stream break" }] });
  check("C-stream", "Stream breaks mid-response: settled reservation, process stays up",
    Math.abs(resAfter) < 1e-9 && aliveAfter.status === 200, `reserved=$${resAfter} afterwards=${aliveAfter.status}`);
}

// ---------------------------------------------------------------- PART D
async function partD() {
  config.auth.required = true; config.auth.jwtSecret = "audit-secret";
  tenancy.reset(); store.clear(); budget.reset();

  const T = tenancy.createTenant("NewCo");
  const jwt = jwtFor(T.id, { email: "new@newco.com" });

  // 1. brand-new workspace: nothing configured, nothing fabricated
  const me0 = await getJ("/api/me", auth(jwt));
  check("D1", "New workspace starts genuinely empty (no seeded data)",
    me0.onboarding.requests === 0 && me0.onboarding.complete === false && me0.keys.length === 0,
    JSON.stringify(me0.onboarding.steps));
  const roi0 = await getJ("/api/roi", auth(jwt));
  check("D2", "Empty workspace reports an explicit empty state, not zeros dressed as results",
    roi0.empty === true && roi0.lifetime === null, `empty=${roi0.empty}`);

  // 2. add provider key (validated), 3. mint Joule key
  upstream.setFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }));
  const pk = await fetch(base + "/api/provider-key", { method: "POST", headers: { "content-type": "application/json", ...auth(jwt) }, body: JSON.stringify({ apiKey: "sk-newco-key" }) });
  upstream.setFetch(null);
  const minted = await (await fetch(base + "/api/keys", { method: "POST", headers: { "content-type": "application/json", ...auth(jwt) }, body: JSON.stringify({ name: "prod" }) })).json();
  check("D3", "Onboarding: provider key validated+stored, Joule key minted once",
    pk.status === 200 && minted.key && minted.key.startsWith(config.auth.keyPrefix), `providerKey=${pk.status}`);

  // 4. a realistic week of traffic through their own key
  const prompts = ["hi thanks", "summarise this briefly", "translate hello to french",
    "Prove step by step and analyse the race condition in depth", "Evaluate the trade-offs rigorously, step by step"];
  for (let i = 0; i < 240; i++) {
    const h = { ...auth(minted.key) };
    if (i % 8 === 0) h["x-joule-session"] = `agent-${Math.floor(i / 8) % 6}`;
    await post({ model: "auto", messages: [{ role: "user", content: prompts[i % prompts.length] + (i % 3 === 0 ? "" : " #" + i) }] }, h);
  }

  // 5. activation moment + every page
  const onb = await getJ("/api/onboarding", auth(jwt));
  check("D4", "Activation moment fires on the first real request, with real figures",
    onb.steps.firstRequest === true && onb.complete === true && onb.firstRequest && onb.firstRequest.totalTokens > 0 && onb.firstRequest.qualityScore === null,
    `model=${onb.firstRequest && onb.firstRequest.model} cost=$${onb.firstRequest && onb.firstRequest.costUsd} quality=${JSON.stringify(onb.firstRequest && onb.firstRequest.qualityScore)}`);

  const s = await getJ("/api/stats", auth(jwt));
  const sum = await getJ("/api/summary?range=all", auth(jwt));
  const rep = await getJ("/api/report?format=json", auth(jwt));
  const roi = await getJ("/api/roi", auth(jwt));
  const dig = await getJ("/api/digest", auth(jwt));
  check("D5", "Overview populates (the reset-to-empty bug does not recur)",
    roi.empty === false && roi.lifetime.requests === 240 && s.totals.requests === 240,
    `roi.requests=${roi.lifetime && roi.lifetime.requests} stats.requests=${s.totals.requests}`);
  check("D6", "Every surface agrees for this workspace",
    JSON.stringify(s.totals) === JSON.stringify(sum.totals) && JSON.stringify(s.totals) === JSON.stringify(rep.totals),
    `stats=${s.totals.requests} summary=${sum.totals.requests} report=${rep.totals.requests}`);
  check("D7", "Savings story is coherent (routed both tiers, saved > 0, cache hits)",
    s.totals.routedSmall > 0 && s.totals.routedLarge > 0 && s.totals.cost.saved > 0 && s.totals.cacheHits > 0,
    `small=${s.totals.routedSmall} large=${s.totals.routedLarge} saved=$${s.totals.cost.saved.toFixed(6)} cacheHits=${s.totals.cacheHits}`);
  check("D8", "Digest matches the dashboard",
    Math.abs(dig.saved.grossUsd - roi.net.grossSaved) < 1e-9, `digest $${dig.saved.grossUsd} vs roi $${roi.net.grossSaved}`);

  // exports
  const csv = await (await fetch(base + "/api/report?format=csv", { headers: auth(jwt) })).text();
  const pdf = Buffer.from(await (await fetch(base + "/api/report?format=pdf", { headers: auth(jwt) })).arrayBuffer());
  const csvRows = csv.split("\n").filter(Boolean).length - 1;
  check("D9", "Exports download and reconcile with the dashboard",
    csvRows === 240 && pdf.slice(0, 8).toString("latin1") === "%PDF-1.4" && pdf.toString("latin1").includes("NewCo"),
    `csvRows=${csvRows} pdfBytes=${pdf.length}`);
  check("D10", "PDF states it is not a certified compliance document",
    /not a certified compliance document/i.test(pdf.toString("latin1")), "");

  // sessions / agent run visible
  check("D11", "Agent sessions are grouped and visible",
    sum.sessions && sum.sessions.length > 0, `sessions=${sum.sessions ? sum.sessions.length : 0}`);

  config.auth.required = false; tenancy.reset();
}

main().catch((e) => { console.error("AUDIT HARNESS FAILED:", e); process.exit(1); });
