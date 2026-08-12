"use strict";
// Phase 2.1 — the value surface. ROI headline, net-of-fees math, payback, lever
// breakdown, insufficient-data states, and the weekly digest. All tenant-scoped, DRY_RUN.
process.env.DRY_RUN = "true";
process.env.ROUTING_ENABLED = "true";
process.env.VERIFY_SAMPLE_RATE = "0";
delete process.env.UPSTREAM_API_KEY;

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("../src/store");
const verify = require("../src/verify");
const budget = require("../src/budget");
const config = require("../src/config");
const tenancy = require("../src/tenancy");
const digest = require("../src/digest");
const app = require("../src/server");

let server, base, tmpDir;
const post = (body, headers = {}) => fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const getJson = async (url) => (await (await fetch(base + url)).json());

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "joule-value-"));
  store.init(tmpDir); require("../src/calibrate").setDir(tmpDir);
  verify.reset(); budget.reset();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  config.subscriptionCostMonthly = 0; digest.setFetch(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
beforeEach(() => { store.clear(); budget.reset(); tenancy.reset(); config.auth.required = false; config.subscriptionCostMonthly = 0; digest.setFetch(null); });

const seed = async (n, content = "summarise this briefly") => {
  for (let i = 0; i < n; i++) await post({ model: "auto", messages: [{ role: "user", content: `${content} #${i}` }] });
};

test("ROI headline reconciles exactly with /api/report (same numbers, different view)", async () => {
  await seed(12);
  const roi = await getJson("/api/roi");
  const report = await getJson("/api/report?format=json");
  const stats = await getJson("/api/stats");

  assert.equal(roi.empty, false);
  // the value surface must not invent its own arithmetic — it reads the same totals
  assert.equal(roi.lifetime.requests, report.totals.requests, "requests match the audit report");
  assert.equal(roi.lifetime.savedCost, report.totals.cost.saved, "gross saved matches");
  assert.equal(roi.lifetime.savedCarbonG, report.totals.carbonG.saved, "carbon matches");
  assert.equal(roi.lifetime.savedEnergyWh, report.totals.energyWh.saved, "energy matches");
  assert.equal(roi.net.grossSaved, stats.totals.cost.saved, "and matches /api/stats");
  assert.equal(roi.lifetime.verifyCost, report.totals.verifyCost.costUsd, "verification overhead matches");

  // the cumulative series must land exactly on the lifetime figure (it compounds to the total)
  const last = roi.series[roi.series.length - 1];
  assert.ok(Math.abs(last.cumSavedCost - roi.lifetime.savedCost) < 1e-9, "cumulative series ends at lifetime saved");
  assert.ok(Math.abs(last.cumSavedCarbonG - roi.lifetime.savedCarbonG) < 1e-9, "cumulative carbon ends at lifetime");
});

test("net-of-fees math is correct and never presented as gross", async () => {
  await seed(10);
  config.subscriptionCostMonthly = 49;
  const roi = await getJson("/api/roi");
  const n = roi.net;

  const expectedSub = 49 * (roi.days / 30.4375);
  assert.ok(Math.abs(n.subscriptionToDate - expectedSub) < 1e-9, "subscription pro-rated by elapsed days");
  assert.ok(Math.abs(n.netAfterFees - (n.grossSaved - n.verifyCost - n.subscriptionToDate)) < 1e-9,
    "net = gross − verification − subscription");
  assert.notEqual(n.netAfterFees, n.grossSaved, "net is a DIFFERENT number from gross when fees exist");
  assert.ok(n.grossSaved >= 0 && n.verifyCost >= 0);
  // the daily net line accrues fees too — it can't just mirror the gross curve
  const last = roi.series[roi.series.length - 1];
  assert.ok(last.cumNet < last.cumSavedCost, "net line sits below the gross line once fees accrue");
});

test("payback is right for a configured plan price, and null when not on a paid plan", async () => {
  await seed(10);

  config.subscriptionCostMonthly = 0;
  const free = await getJson("/api/roi");
  assert.equal(free.net.paybackMonths, null, "no plan price => no fabricated payback");
  assert.equal(free.net.worthIt, null, "no verdict claimed without a price");

  config.subscriptionCostMonthly = 20;
  const paid = await getJson("/api/roi");
  const monthlyNetBeforeSub = (paid.net.grossSaved - paid.net.verifyCost) / (paid.days / 30.4375);
  if (monthlyNetBeforeSub > 0) {
    const expected = 20 / monthlyNetBeforeSub;
    assert.ok(Math.abs(paid.net.paybackMonths - expected) < 1e-6, "payback = price / monthly net before subscription");
  } else {
    assert.equal(paid.net.paybackMonths, null, "no payback claimed when savings don't cover it");
  }
});

test("lever breakdown shows WHERE savings came from, each labelled with its quality risk", async () => {
  await seed(6, "hello thanks");
  await post({ model: "auto", messages: [{ role: "user", content: "hello thanks #0" }] }); // exact-cache hit
  const roi = await getJson("/api/roi");

  assert.ok(Array.isArray(roi.levers) && roi.levers.length > 0, "levers are broken out");
  // NO DOUBLE-COUNTING: the baseline levers must reconcile EXACTLY to the headline gross
  // figure. Levers on a different basis (batch discount, estimates) are reported apart.
  assert.ok(Math.abs(roi.leverTotals.baselineSavedUsd - roi.net.grossSaved) < 1e-9,
    "baseline levers sum exactly to headline gross saved — no double-counting, nothing missing");
  for (const l of roi.levers) {
    assert.ok(["baseline", "additional"].includes(l.basis), `${l.id} declares its basis`);
    assert.ok(["none", "verified", "estimated", "quality-risk"].includes(l.risk), `${l.id} carries a risk label`);
    assert.ok(l.note && l.note.length > 10, `${l.id} explains itself`);
  }
  const cache = roi.levers.find((l) => l.id === "cache");
  if (cache) { assert.equal(cache.risk, "none", "cache is labelled zero quality risk"); assert.equal(cache.basis, "baseline"); }
  const batch = roi.levers.find((l) => l.id === "batch");
  if (batch) assert.equal(batch.basis, "additional", "batch discount is NOT folded into the headline");
});

test("savings are ALWAYS paired with quality, and quality obeys the insufficient-samples rule", async () => {
  await seed(5);
  const roi = await getJson("/api/roi");
  assert.ok(roi.quality, "quality travels with the ROI payload — savings are never shipped alone");
  assert.equal(roi.quality.score, null, "no verified samples => null, NEVER a fake 100%");
  assert.equal(roi.quality.sufficient, false, "insufficient data is stated plainly");
  assert.equal(roi.quality.guaranteeReady, false, "no guarantee claimed");
  assert.equal(roi.quality.minSamples, config.verify.minCalibrationN);
  assert.equal(roi.methodology.energy, "estimated", "energy labelled estimated, not measured");
  assert.equal(roi.methodology.cost, "measured", "cost is measured from real token usage");
});

test("empty state: no data => explicit empty, never fabricated numbers", async () => {
  const roi = await getJson("/api/roi");
  assert.equal(roi.empty, true);
  assert.equal(roi.lifetime, null, "no invented lifetime figures");
  assert.deepEqual(roi.series, [], "no invented chart points");
  assert.equal(roi.net, null, "no invented net");
});

test("ROI is tenant-scoped: one workspace's savings never appear in another's", async () => {
  config.auth.required = true; config.auth.jwtSecret = "v-secret";
  const crypto = require("node:crypto");
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwtFor = (tid) => { const h = b64({ alg: "HS256", typ: "JWT" }), p = b64({ sub: "u", app_metadata: { tenant_id: tid }, exp: Math.floor(Date.now() / 1000) + 3600 });
    return `${h}.${p}.${crypto.createHmac("sha256", config.auth.jwtSecret).update(h + "." + p).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`; };
  try {
    const A = tenancy.createTenant("A"), B = tenancy.createTenant("B");
    const keyA = tenancy.mintKey(A.id).key;
    for (let i = 0; i < 4; i++) await post({ model: "auto", messages: [{ role: "user", content: `A ${i}` }] }, { authorization: "Bearer " + keyA });

    const roiA = await (await fetch(base + "/api/roi", { headers: { authorization: "Bearer " + jwtFor(A.id) } })).json();
    const roiB = await (await fetch(base + "/api/roi", { headers: { authorization: "Bearer " + jwtFor(B.id) } })).json();
    assert.equal(roiA.lifetime.requests, 4, "A sees its own savings");
    assert.equal(roiB.empty, true, "B — who sent nothing — sees an empty state, not A's numbers");
  } finally { config.auth.required = false; config.auth.jwtSecret = ""; }
});

test("value surface UI: renders net + quality together, labels estimates, no chart library", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  assert.doesNotThrow(() => new Function(js), "dashboard JS still parses");

  // hand-rolled SVG only — no charting dependency may creep in
  assert.ok(!/chart\.js|d3|recharts|plotly|apexcharts/i.test(html), "no chart library");
  assert.ok(/<svg/.test(js) || js.includes("polyline"), "chart is hand-rolled SVG");

  // the headline must show NET and pair it with quality
  assert.ok(js.includes("netAfterFees"), "headline uses the NET figure");
  assert.ok(js.includes("net saved, after Joule\\'s own cost") || js.includes("net saved"), "net is labelled as net");
  assert.ok(js.includes("quality held") && js.includes("not yet verified"), "quality is paired, with an insufficient-data state");
  assert.ok(js.includes("cumNet"), "the net-of-fees line is actually plotted, not just returned");
  // estimated vs measured must be visible where energy/carbon are shown
  assert.match(js, /energy and carbon are estimated/i, "methodology labelled in the UI");
  // empty state instead of fabricated numbers (copy is owned by the Phase 2.0 IA work —
  // assert the INTENT: an explicit "nothing yet" state that promises no sample data)
  assert.match(js, /No savings to show yet/i, "explicit empty state rather than zeros");
  assert.match(js, /never show sample data/i, "and it promises not to fabricate data");
});

// ---------------- weekly digest ----------------

test("digest builds correct per-tenant content from real records", async () => {
  await seed(8);
  const d = await getJson("/api/digest?days=7");
  const roi = await getJson("/api/roi");

  assert.equal(d.hasTraffic, true);
  assert.equal(d.requests, 8, "counts this tenant's week");
  assert.ok(Math.abs(d.saved.grossUsd - roi.net.grossSaved) < 1e-9, "digest gross matches the ROI view");
  assert.ok(Math.abs(d.saved.netUsd - (d.saved.grossUsd - d.saved.verifyCostUsd - d.saved.subscriptionUsd)) < 1e-9, "digest net math is correct");
  assert.equal(d.quality.score, null, "unverified => null, never a fake score");
  assert.ok(d.topModels.length > 0 && d.topModels[0].costUsd >= (d.topModels[1] ? d.topModels[1].costUsd : 0), "top cost drivers, sorted");
  assert.equal(d.methodology.energy, "estimated");

  // the text body states net explicitly and never claims a quality score it doesn't have
  assert.match(d.text, /NET SAVED/);
  assert.match(d.text, /not yet verified/);
});

test("digest is honest about a quiet week (no traffic) instead of emailing zeros", () => {
  const d = digest.build(tenancy.DEFAULT_TENANT_ID, { days: 7 });
  assert.equal(d.hasTraffic, false);
  assert.equal(d.requests, 0);
  const txt = digest.toText(d);
  assert.match(txt, /nothing to report/i, "says so plainly");
  assert.ok(!/\$0\.00 saved!/.test(txt), "does not dress zeros up as a result");
  assert.match(digest.toHtml(d), /nothing to report/i);
});

test("digest send() no-ops cleanly when email is not configured, and never throws", async () => {
  const saved = { ...config.digest };
  try {
    config.digest.apiKey = "";                       // provider not configured
    const d = digest.build(tenancy.DEFAULT_TENANT_ID, {});
    const r = await digest.send(d, "user@example.com");
    assert.equal(r.sent, false);
    assert.match(r.reason, /no email provider configured/i, "explains why, rather than failing silently");

    config.digest.enabled = false;
    assert.match((await digest.send(d, "u@e.com")).reason, /disabled/i);

    // configured but the provider is down -> still no throw, still reports why
    config.digest.enabled = true; config.digest.apiKey = "re_test";
    digest.setFetch(async () => { throw new Error("ECONNREFUSED"); });
    const down = await digest.send(d, "u@e.com");
    assert.equal(down.sent, false);
    assert.match(down.reason, /unreachable/i);

    // happy path
    let payload = null;
    digest.setFetch(async (_u, opts) => { payload = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ id: "e1" }) }; });
    const ok = await digest.send(d, "user@example.com");
    assert.equal(ok.sent, true);
    assert.deepEqual(payload.to, ["user@example.com"]);
    assert.ok(payload.subject.includes("Joule"), "subject is present");
    assert.ok(payload.text && payload.html, "both text and html bodies sent");
  } finally { Object.assign(config.digest, saved); digest.setFetch(null); }
});

test("digest requires a recipient and stays tenant-scoped", async () => {
  const saved = { ...config.digest };
  try {
    config.digest.apiKey = "re_test";
    const d = digest.build(tenancy.DEFAULT_TENANT_ID, {});
    assert.match((await digest.send(d, null)).reason, /no recipient/i, "won't send into the void");
  } finally { Object.assign(config.digest, saved); }
});

// ---- Overview vs Activity consistency ----
// Overview reads /api/roi, Activity reads /api/summary + /api/stats. They must never
// disagree for the same workspace and range, or the product contradicts itself.
test("Overview (/api/roi) and Activity (/api/summary, /api/stats) agree for the same workspace", async () => {
  await seed(14);
  const roi = await getJson("/api/roi");
  const summary = await getJson("/api/summary");
  const stats = await getJson("/api/stats");

  assert.equal(roi.empty, false, "Overview must NOT report empty when requests exist");
  assert.equal(roi.lifetime.requests, summary.totals.requests, "same request count as Activity");
  assert.equal(roi.lifetime.requests, stats.totals.requests, "and as /api/stats");
  assert.equal(roi.net.grossSaved, summary.totals.cost.saved, "same gross saving");
  assert.equal(roi.lifetime.savedCarbonG, summary.totals.carbonG.saved, "same carbon saved");
  // the cumulative series must land on the same lifetime figure the other pages show
  const last = roi.series[roi.series.length - 1];
  assert.ok(Math.abs(last.cumSavedCost - summary.totals.cost.saved) < 1e-9, "series ends at Activity's total");
});

test("a failed /api/roi is NOT rendered as an empty workspace", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  assert.match(js, /genuinelyEmpty = r && r\.empty === true/, "only the server's explicit empty:true means 'no data'");
  assert.match(js, /Couldn\\?'t load your savings/, "a load failure gets its own honest state");
  assert.match(js, /No savings to show yet/, "the genuine empty state still exists");
});
