"use strict";
const config = require("./config");
const store = require("./store");
const cacheadvice = require("./cacheadvice");

/**
 * Weekly value digest — keeps the savings visible when nobody is looking at the
 * dashboard (the retention lever). Per TENANT, built from that tenant's real records only.
 *
 * HONESTY RULES APPLY HERE TOO: no fabricated numbers, quality is null (not 100%) until
 * verified samples exist, savings are reported NET of verification + subscription, and
 * energy/carbon are labelled estimated. If a tenant sent no traffic we say so plainly
 * rather than emailing a wall of zeros dressed up as a result.
 *
 * Email is OPTIONAL and provider-agnostic (Resend / SES-compatible HTTP APIs) via config.
 * With nothing configured, send() NO-OPS cleanly and reports why — it never throws and
 * never blocks anything on the serving path.
 */

const WEEK_MS = 7 * 24 * 3600 * 1000;
const usd = (x) => (x >= 1 ? "$" + x.toFixed(2) : "$" + x.toFixed(4));

// Build the digest payload for one tenant over the trailing `days` window.
function build(tenantId, { now = Date.now(), days = 7 } = {}) {
  const cutoff = now - days * 24 * 3600 * 1000;
  const all = store.all(tenantId);
  const week = all.filter((r) => new Date(r.ts).getTime() >= cutoff);

  const weekTotals = store.aggregate((r) => new Date(r.ts).getTime() >= cutoff && r.tenant === tenantId);
  const lifeTotals = store.aggregate(store.predicateFor({ tenant: tenantId }));

  // fees for the window: verification overhead + the pro-rated subscription
  const subMonthly = config.subscriptionCostMonthly || 0;
  const subForWindow = subMonthly > 0 ? (subMonthly * 12 / 365.25) * days : 0;
  const grossSaved = weekTotals.cost.saved;
  const verifyCost = weekTotals.verifyCost.costUsd;

  // top cost-driving models (what to look at first)
  const byModel = new Map();
  for (const r of week) {
    const m = byModel.get(r.model) || { model: r.model, requests: 0, costUsd: 0 };
    m.requests++; m.costUsd += r.actual.costUsd; byModel.set(r.model, m);
  }
  const topModels = [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd).slice(0, 5);

  // top cost-driving sessions/agents
  const bySession = new Map();
  for (const r of week) {
    if (!r.session) continue;
    const s = bySession.get(r.session) || { session: r.session, requests: 0, costUsd: 0 };
    s.requests++; s.costUsd += r.actual.costUsd; bySession.set(r.session, s);
  }
  const topSessions = [...bySession.values()].sort((a, b) => b.costUsd - a.costUsd).slice(0, 5);

  // one actionable advisory finding, if the cache advisor has anything real to say
  let advisory = null;
  try {
    const a = cacheadvice.advisory(week);
    advisory = (a && a.findings && a.findings.length) ? a.findings[0] : null;
  } catch { advisory = null; }

  return {
    tenantId,
    window: { days, from: new Date(cutoff).toISOString(), to: new Date(now).toISOString() },
    // explicit "nothing happened" state — we never dress zeros up as a result
    hasTraffic: week.length > 0,
    requests: weekTotals.requests,
    saved: {
      grossUsd: grossSaved,
      verifyCostUsd: verifyCost,
      subscriptionUsd: subForWindow,
      netUsd: grossSaved - verifyCost - subForWindow,   // ALWAYS the net figure too
      carbonG: weekTotals.carbonG.saved,
      energyWh: weekTotals.energyWh.saved
    },
    spend: { costUsd: weekTotals.cost.actual },
    quality: {
      // null => not yet verified. NEVER 100% by default.
      score: weekTotals.qualityScore,
      verified: weekTotals.verified,
      minSamples: config.verify.minCalibrationN,
      sufficient: weekTotals.verified >= config.verify.minCalibrationN
    },
    lifetime: { requests: lifeTotals.requests, savedUsd: lifeTotals.cost.saved, savedCarbonG: lifeTotals.carbonG.saved },
    topModels, topSessions, advisory,
    methodology: { cost: "measured", energy: "estimated", carbon: "estimated" }
  };
}

// Plain-text body — deliberately readable, honest, and free of marketing rounding.
function toText(d) {
  const L = [];
  L.push(`Joule — your week (${d.window.days} days)`);
  L.push("");
  if (!d.hasTraffic) {
    L.push("No requests went through Joule this week, so there's nothing to report.");
    L.push("Savings resume as soon as your traffic does.");
    if (d.lifetime.requests) L.push(`Lifetime so far: ${usd(d.lifetime.savedUsd)} saved over ${d.lifetime.requests} requests.`);
    return L.join("\n");
  }
  L.push(`Requests optimised: ${d.requests}`);
  L.push(`Saved (gross):      ${usd(d.saved.grossUsd)}`);
  L.push(`  − verification:   ${usd(d.saved.verifyCostUsd)}`);
  if (d.saved.subscriptionUsd > 0) L.push(`  − subscription:   ${usd(d.saved.subscriptionUsd)}`);
  L.push(`= NET SAVED:        ${usd(d.saved.netUsd)}`);
  L.push(`CO2 avoided:        ${d.saved.carbonG.toFixed(1)} g (estimated)`);
  L.push("");
  L.push(d.quality.score == null
    ? `Quality: not yet verified — no samples judged yet.`
    : `Quality held: ${(d.quality.score * 100).toFixed(1)}% across ${d.quality.verified} verified sample(s)` +
      (d.quality.sufficient ? "" : ` (below ${d.quality.minSamples} samples — not yet a guarantee)`));
  L.push("");
  if (d.topModels.length) {
    L.push("Top cost drivers:");
    for (const m of d.topModels) L.push(`  ${m.model} — ${m.requests} req, ${usd(m.costUsd)}`);
  }
  if (d.topSessions.length) {
    L.push("Top agents/sessions:");
    for (const s of d.topSessions) L.push(`  ${s.session} — ${s.requests} req, ${usd(s.costUsd)}`);
  }
  if (d.advisory) { L.push(""); L.push(`Advisory: ${d.advisory.title || d.advisory.id}`); if (d.advisory.detail) L.push(`  ${d.advisory.detail}`); }
  L.push("");
  L.push(`Lifetime: ${usd(d.lifetime.savedUsd)} saved over ${d.lifetime.requests} requests.`);
  L.push("Cost is measured from token usage; energy and carbon are estimated (labelled).");
  return L.join("\n");
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function toHtml(d) {
  if (!d.hasTraffic) {
    return `<div style="font-family:system-ui,sans-serif;max-width:560px"><h2>Joule — your week</h2>
      <p>No requests went through Joule this week, so there's nothing to report. Savings resume as soon as your traffic does.</p></div>`;
  }
  const q = d.quality.score == null
    ? `<span style="color:#888">not yet verified</span>`
    : `${(d.quality.score * 100).toFixed(1)}%${d.quality.sufficient ? "" : ` <span style="color:#888">(below ${d.quality.minSamples} samples — not yet a guarantee)</span>`}`;
  return `<div style="font-family:system-ui,sans-serif;max-width:560px;color:#111">
    <h2 style="margin:0 0 4px">Joule — your week</h2>
    <p style="color:#666;margin:0 0 16px">${esc(d.window.days)} days · ${d.requests} requests optimised</p>
    <div style="background:#f6f8fa;border-radius:10px;padding:16px;margin-bottom:14px">
      <div style="font-size:26px;font-weight:700">${usd(d.saved.netUsd)} <span style="font-size:13px;font-weight:400;color:#666">net saved</span></div>
      <div style="color:#666;font-size:13px;margin-top:6px">
        gross ${usd(d.saved.grossUsd)} − verification ${usd(d.saved.verifyCostUsd)}${d.saved.subscriptionUsd > 0 ? ` − subscription ${usd(d.saved.subscriptionUsd)}` : ""}
      </div>
      <div style="margin-top:10px">Quality held: <b>${q}</b></div>
      <div style="color:#666;font-size:13px;margin-top:4px">${d.saved.carbonG.toFixed(1)} g CO₂ avoided (estimated)</div>
    </div>
    ${d.topModels.length ? `<h3 style="font-size:14px;margin:0 0 6px">Top cost drivers</h3><ul style="margin:0 0 14px;padding-left:18px;color:#333">${d.topModels.map((m) => `<li>${esc(m.model)} — ${m.requests} req, ${usd(m.costUsd)}</li>`).join("")}</ul>` : ""}
    ${d.advisory ? `<div style="border-left:3px solid #33E3C7;padding-left:10px;color:#333"><b>Advisory:</b> ${esc(d.advisory.title || d.advisory.id)}</div>` : ""}
    <p style="color:#888;font-size:12px;margin-top:16px">Cost is measured from token usage; energy and carbon are estimated.</p>
  </div>`;
}

/**
 * Send a digest. Provider-agnostic HTTP JSON (Resend by default; any compatible
 * endpoint via DIGEST_API_URL). Returns { sent, reason } and NEVER throws.
 */
let fetchImpl = (...a) => global.fetch(...a);
function setFetch(fn) { fetchImpl = fn || ((...a) => global.fetch(...a)); }

async function send(digestObj, to) {
  const c = config.digest;
  if (!c.enabled) return { sent: false, reason: "digest disabled (DIGEST_ENABLED=false)" };
  if (!c.apiKey) return { sent: false, reason: "no email provider configured (set DIGEST_API_KEY)" };
  if (!to) return { sent: false, reason: "no recipient address for this tenant" };
  try {
    const res = await fetchImpl(c.apiUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + c.apiKey },
      body: JSON.stringify({
        from: c.from, to: [to],
        subject: digestObj.hasTraffic
          ? `Joule: ${usd(digestObj.saved.netUsd)} saved this week`
          : "Joule: no traffic this week",
        text: toText(digestObj), html: toHtml(digestObj)
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return { sent: false, reason: `email provider returned ${res.status}` };
    return { sent: true, reason: "sent" };
  } catch (err) {
    // digests are secondary — a failure is logged and swallowed, never surfaced to a user
    return { sent: false, reason: "email provider unreachable: " + (err && err.message) };
  }
}

module.exports = { build, toText, toHtml, send, setFetch, WEEK_MS };
