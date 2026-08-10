"use strict";
// Phase 2.2 — the trust surface: audit-ready export, real reliability evidence, key
// rotation. Everything must be REAL and tenant-scoped; nothing fabricated.
process.env.DRY_RUN = "true";
process.env.ROUTING_ENABLED = "true";
process.env.VERIFY_SAMPLE_RATE = "0";
delete process.env.UPSTREAM_API_KEY;

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("../src/store");
const verify = require("../src/verify");
const budget = require("../src/budget");
const config = require("../src/config");
const tenancy = require("../src/tenancy");
const pdf = require("../src/pdf");
const app = require("../src/server");

let server, base, tmpDir;
const post = (body, headers = {}) => fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const bearer = (k) => ({ authorization: "Bearer " + k });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwtFor = (tid) => { const h = b64({ alg: "HS256", typ: "JWT" }), p = b64({ sub: "u", app_metadata: { tenant_id: tid }, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${h}.${p}.${crypto.createHmac("sha256", config.auth.jwtSecret).update(h + "." + p).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`; };

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "joule-trust-"));
  store.init(tmpDir); require("../src/calibrate").setDir(tmpDir);
  verify.reset(); budget.reset();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
});
after(async () => { await new Promise((r) => server.close(r)); config.auth.required = false; fs.rmSync(tmpDir, { recursive: true, force: true }); });
beforeEach(() => { store.clear(); budget.reset(); tenancy.reset(); config.auth.required = false; config.auth.jwtSecret = "trust-secret"; });

const seed = async (n) => { for (let i = 0; i < n; i++) await post({ model: "auto", messages: [{ role: "user", content: `report me #${i}` }] }); };

test("PDF export is a valid, branded, dated PDF and reconciles with /api/report", async () => {
  await seed(9);
  const res = await fetch(base + "/api/report?format=pdf");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.match(res.headers.get("content-disposition") || "", /\.pdf/);

  const buf = Buffer.from(await res.arrayBuffer());
  // structurally valid: header, xref, trailer, EOF — a broken xref makes it unopenable
  assert.equal(buf.slice(0, 8).toString("latin1"), "%PDF-1.4", "PDF header");
  const s = buf.toString("latin1");
  assert.ok(s.includes("xref") && s.includes("trailer") && s.trimEnd().endsWith("%%EOF"), "xref + trailer + EOF present");
  assert.match(s, /startxref\s+(\d+)/, "startxref offset written");
  const declared = Number(/startxref\s+(\d+)/.exec(s)[1]);
  assert.equal(s.slice(declared, declared + 4), "xref", "startxref points at the real xref table — byte offsets are correct");

  // content: branded, names the workspace, states the period and the honesty language
  assert.ok(s.includes("JOULE"), "branded");
  assert.ok(/Reporting period/.test(s), "period stated");
  assert.ok(/NET SAVING/.test(s), "net is the headline figure, distinguished from gross");
  assert.ok(/Cost - MEASURED\./.test(s) || /Cost - MEASURED/.test(s), "cost labelled measured");
  assert.ok(/Energy - ESTIMATED/.test(s), "energy labelled estimated");
  assert.ok(/Carbon - ESTIMATED/.test(s), "carbon labelled estimated");
  assert.ok(/Scope 2/.test(s) && /SCI/.test(s), "Scope 2 / SCI alignment stated");
  assert.ok(/MARGINAL/.test(s), "the marginal-not-per-query limit is stated");
  assert.ok(/no certification claims/i.test(s), "explicitly claims no certifications");

  // figures reconcile with the JSON report (same totals, three formats)
  const json = await (await fetch(base + "/api/report?format=json")).json();
  assert.ok(s.includes(String(json.totals.requests)), "request count matches the JSON report");
});

test("export is tenant-scoped: one workspace's PDF never contains another's figures", async () => {
  config.auth.required = true;
  const A = tenancy.createTenant("Acme Ltd"), B = tenancy.createTenant("Beta Inc");
  const keyA = tenancy.mintKey(A.id).key;
  for (let i = 0; i < 6; i++) await post({ model: "auto", messages: [{ role: "user", content: `A ${i}` }] }, bearer(keyA));

  const pdfB = Buffer.from(await (await fetch(base + "/api/report?format=pdf", { headers: bearer(jwtFor(B.id)) })).arrayBuffer()).toString("latin1");
  assert.ok(pdfB.includes("Beta Inc"), "B's report names B");
  assert.ok(!pdfB.includes("Acme"), "and never mentions A");
  assert.ok(/no data in range|Requests processed/.test(pdfB));

  const jsonB = await (await fetch(base + "/api/report?format=json", { headers: bearer(jwtFor(B.id)) })).json();
  assert.equal(jsonB.totals.requests, 0, "B, who sent nothing, reports zero — not A's six");

  const jsonA = await (await fetch(base + "/api/report?format=json", { headers: bearer(jwtFor(A.id)) })).json();
  assert.equal(jsonA.totals.requests, 6);
});

test("/api/status reports REAL component health, and shows degraded when a component is", async () => {
  const ok = await (await fetch(base + "/api/status")).json();
  assert.equal(ok.components.proxy.status, "ok");
  assert.ok(ok.components.proxy.uptimeSeconds >= 0, "real process uptime");
  assert.ok(["ok", "degraded"].includes(ok.components.database.status));
  assert.ok(["live", "fallback", "unknown"].includes(ok.components.grid.status));

  // NEVER fabricated: no uptime percentage is claimed, and the absence is stated
  assert.equal(ok.uptimeHistory.available, false);
  assert.match(ok.uptimeHistory.note, /not retained yet/i);
  assert.ok(!JSON.stringify(ok).includes("99.9"), "no invented availability figure");

  // simulate a degraded database -> status must reflect it, not stay green
  const realHealth = store.health;
  store.health = () => ({ backend: "postgres", status: "degraded", pendingWrites: 42 });
  try {
    const bad = await (await fetch(base + "/api/status")).json();
    assert.equal(bad.components.database.status, "degraded", "degraded component shows degraded");
    assert.equal(bad.components.database.pendingWrites, 42);
  } finally { store.health = realHealth; }
});

test("latency evidence is real, measured and tenant-scoped (never a fake zero)", async () => {
  const empty = await (await fetch(base + "/api/status")).json();
  assert.equal(empty.latency.all.n, 0);
  assert.equal(empty.latency.all.p50, null, "no data => null, not a flattering 0 ms");

  await seed(12);
  const s = await (await fetch(base + "/api/status")).json();
  assert.equal(s.latency.all.n, 12, "counts real measured requests");
  for (const k of ["p50", "p95", "p99"]) assert.ok(typeof s.latency.all[k] === "number", `${k} is a real number`);
  assert.ok(s.latency.all.p50 <= s.latency.all.p95 && s.latency.all.p95 <= s.latency.all.p99, "percentiles ordered");
  assert.ok(s.latency.all.min <= s.latency.all.p50 && s.latency.all.p99 <= s.latency.all.max, "bounded by observed min/max");

  // percentiles come from the same log as everything else
  const direct = store.latencyStats(store.predicateFor({ tenant: tenancy.DEFAULT_TENANT_ID }));
  assert.deepEqual(s.latency, direct, "status latency == store.latencyStats for the tenant");
});

test("key rotation issues a new key and the OLD one stops authenticating", async () => {
  config.auth.required = true;
  const T = tenancy.createTenant("rot");
  const jwt = jwtFor(T.id);
  const first = await (await fetch(base + "/api/keys", { method: "POST", headers: { "content-type": "application/json", ...bearer(jwt) }, body: JSON.stringify({ name: "prod" }) })).json();

  assert.equal((await post({ model: "auto", messages: [{ role: "user", content: "before" }] }, bearer(first.key))).status, 200, "old key works before rotation");

  const rot = await (await fetch(base + `/api/keys/${first.id}/rotate`, { method: "POST", headers: bearer(jwt) })).json();
  assert.equal(rot.ok, true);
  assert.ok(rot.key && rot.key !== first.key, "a NEW key is returned once");
  assert.equal(rot.name, "prod", "keeps its label");

  assert.equal((await post({ model: "auto", messages: [{ role: "user", content: "after" }] }, bearer(first.key))).status, 401, "the OLD key no longer authenticates");
  assert.equal((await post({ model: "auto", messages: [{ role: "user", content: "after" }] }, bearer(rot.key))).status, 200, "the new key works");
});

test("you cannot rotate another workspace's key", async () => {
  config.auth.required = true;
  const A = tenancy.createTenant("A"), B = tenancy.createTenant("B");
  const kA = tenancy.mintKey(A.id, "a-key");
  const attempt = await fetch(base + `/api/keys/${kA.id}/rotate`, { method: "POST", headers: bearer(jwtFor(B.id)) });
  assert.equal(attempt.status, 404, "B cannot rotate A's key");
  assert.equal(tenancy.resolveFromApiKey("Bearer " + kA.key).id, A.id, "A's key is untouched");
});

test("docs pages render the honesty content and claim NO certification we don't hold", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  assert.doesNotThrow(() => new Function(js), "dashboard JS parses");

  // a real Docs area exists and is reachable from nav
  assert.match(html, /data-nav="reports"/, "Docs nav link");
  assert.match(html, /data-view="reports"/, "Docs view");
  assert.match(js, /function paintDocs/, "docs renderer");

  // the three required pages
  assert.match(js, /Quickstart/i);
  assert.match(js, /How every number is calculated/i);
  assert.match(js, /Security &amp;|Security &/i);

  // stated limits — the trust asset
  assert.match(js, /Cost — measured/i, "cost labelled measured");
  assert.match(js, /Energy — estimated/i, "energy labelled estimated");
  assert.match(js, /Carbon — estimated/i, "carbon labelled estimated");
  assert.match(js, /marginal/i, "marginal-not-per-query limit stated");
  assert.match(js, /never per individual query/i);
  assert.match(js, /LOG_PROMPTS/, "retention posture stated");
  assert.match(js, /row-level security/i, "isolation stated");
  assert.match(js, /AES-256-GCM/, "key encryption stated");

  // NO fabricated compliance or uptime
  assert.match(js, /no<\/b> third-party security certification|no third-party security certification/i, "explicitly states we hold no certification");
  assert.match(js, /on the roadmap/i, "aspirational items labelled on roadmap");
  assert.ok(!/SOC ?2 (certified|compliant)/i.test(js), "never claims SOC 2 compliance");
  assert.ok(!/ISO ?27001 (certified|compliant)/i.test(js), "never claims ISO 27001");
  assert.ok(!/99\.9\s*%/.test(js), "no invented uptime percentage anywhere in the UI");
});

test("trust signals + account controls are present and honest", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  // reassurance placed where a nervous buyer looks (onboarding + settings)
  assert.match(html, /add no latency to what your users see/i, "off-path verification stated at the moment of first use");
  assert.match(js, /never sent to your browser/i, "key handling reassurance in the quickstart");
  // account basics
  assert.match(js, /function paintKeys/, "key management view");
  assert.match(js, /data-rotate/, "rotate control");
  assert.match(js, /function paintStatus/, "service status view");
  assert.match(js, /format=pdf[\s\S]{0,400}format=csv[\s\S]{0,400}format=json/, "all three export formats offered");
  assert.match(js, /measured, not estimated/i, "latency labelled as measured");
  // status view must surface the no-history caveat, not hide it
  assert.match(js, /uptimeHistory\.note/, "the 'no uptime history retained' note is rendered, not dropped");
});

test("pdf writer: wraps text and produces multi-page output without losing content", () => {
  const d = pdf.createDoc();
  for (let i = 0; i < 120; i++) d.text(`Line ${i} — ` + "lorem ipsum dolor sit amet ".repeat(4), { size: 10 });
  const buf = pdf.render(d);
  const s = buf.toString("latin1");
  assert.ok(/\/Type \/Pages \/Count ([2-9]|\d{2,})/.test(s), "overflowed onto multiple pages rather than off-page");
  assert.ok(s.includes("Line 0") && s.includes("Line 119"), "first and last content survive");
  assert.equal(s.slice(0, 8), "%PDF-1.4");
  // wrapping respects the measured width
  const lines = pdf._wrap("word ".repeat(200), 10, 300);
  assert.ok(lines.length > 1 && lines.every((l) => pdf._textWidth(l, 10) <= 300 + 30), "wrapped within width");
});
