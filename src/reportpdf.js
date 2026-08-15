"use strict";
const pdf = require("./pdf");
const config = require("./config");

/**
 * The audit / finance artefact: a branded, dated, tenant-named PDF a CFO or auditor can
 * file. Built from the SAME totals as /api/report, so the PDF, the JSON and the CSV can
 * never disagree.
 *
 * HONESTY IS THE POINT of this document: cost is stated as measured, energy and carbon as
 * ESTIMATED with the model spelled out, quality as SAMPLED with its limits, and net is
 * always distinguished from gross. It states no certification we do not hold.
 */

const usd = (x) => (x == null ? "n/a" : (x >= 1 ? "$" + x.toFixed(2) : "$" + x.toFixed(4)));
const num = (x, d = 0) => (x == null ? "n/a" : Number(x).toFixed(d));

function build({ tenantName, tenantId, period, totals, quality, net, latency, generatedAt }) {
  const d = pdf.createDoc();
  const BRAND = "#0E7C6B", INK = "#111111", MUTE = "#666666";

  // ---- header ----
  d.text("JOULE", { size: 20, font: pdf.FONTS.bold, color: BRAND, gap: 2 });
  d.text("Cost & emissions summary", { size: 11, color: MUTE, gap: 2 });
  // Honest header note — states what this document is and, explicitly, what it is not.
  d.text("Methodology is stated in full below. This is not a certified compliance document.", { size: 8.5, color: MUTE, gap: 2 });
  d.space(6).rule({ color: BRAND });

  d.row("Workspace", tenantName || tenantId || "—", { bold: true });
  d.row("Workspace ID", String(tenantId || "—"), { size: 9, color: MUTE });
  d.row("Reporting period", period.label, { bold: true });
  d.row("Generated", new Date(generatedAt).toISOString().replace("T", " ").slice(0, 19) + " UTC", { size: 9, color: MUTE });
  d.rule();

  // ---- the figures ----
  d.space(4).text("Summary", { size: 13, font: pdf.FONTS.bold });
  d.space(2);
  d.row("Requests processed", String(totals.requests));
  d.row("Spend (measured)", usd(totals.cost.actual), { bold: true });
  d.row("Baseline had every request used the large model", usd(totals.cost.baseline));
  d.row("Gross saving", usd(totals.cost.saved));
  d.row("Less: quality-verification overhead", "-" + usd(totals.verifyCost.costUsd));
  if (net && net.subscriptionToDate > 0) d.row("Less: Joule subscription for the period", "-" + usd(net.subscriptionToDate));
  d.row("NET SAVING", usd(net ? net.netAfterFees : totals.cost.saved - totals.verifyCost.costUsd), { bold: true, valueColor: BRAND });
  d.rule();

  d.text("Energy & carbon (estimated)", { size: 13, font: pdf.FONTS.bold });
  d.space(2);
  d.row("Energy consumed", num(totals.energyWh.actual, 2) + " Wh");
  d.row("Energy avoided vs. baseline", num(totals.energyWh.saved, 2) + " Wh");
  d.row("Carbon emitted (Scope 2, market/location basis)", num(totals.carbonG.actual, 2) + " gCO2e");
  d.row("Carbon avoided vs. baseline", num(totals.carbonG.saved, 2) + " gCO2e");
  d.rule();

  d.text("Quality assurance", { size: 13, font: pdf.FONTS.bold });
  d.space(2);
  d.row("Requests verified (sampled)", String(quality.verified));
  d.row("Average quality score of verified sample",
    quality.score == null ? "not yet verified" : (quality.score * 100).toFixed(1) + "%",
    { bold: quality.score != null });
  if (quality.score != null && !quality.sufficient) {
    d.text(`Note: fewer than ${quality.minSamples} verified samples. This figure is reported as an observation, NOT as a statistical guarantee.`, { size: 8.5, color: MUTE });
  }
  if (quality.score == null) {
    d.text("No answers have been verified in this period, so no quality figure is claimed.", { size: 8.5, color: MUTE });
  }
  d.rule();

  if (latency && latency.all && latency.all.n) {
    d.text("Service latency (measured)", { size: 13, font: pdf.FONTS.bold });
    d.space(2);
    d.row("Requests measured", String(latency.all.n));
    d.row("Median (p50)", num(latency.all.p50) + " ms");
    d.row("95th percentile (p95)", num(latency.all.p95) + " ms");
    d.row("99th percentile (p99)", num(latency.all.p99) + " ms");
    d.rule();
  }

  // ---- methodology: the trust asset, stated in full ----
  d.space(2).text("Methodology & limitations", { size: 13, font: pdf.FONTS.bold });
  d.space(2);
  const M = [
    ["Cost — MEASURED.", "Computed from the token counts returned by the model provider multiplied by that provider's published per-token prices. This is an exact arithmetic figure, not a projection."],
    ["Energy — ESTIMATED.", "Modelled per request as a decode-weighted function of tokens: a fixed base per tier, plus a per-1k-output-token term, plus a much smaller per-1k-input-token term. Inference energy is dominated by the decode phase: an output token is modelled at roughly TEN TIMES the energy of an input token. Note this is a PER-TOKEN rate — the ratio between two whole requests is smaller, because the fixed per-tier base term dominates at low token counts. Anchored to published GPU characterisation methodology and sanity-checked against IEA figures. It is NOT measured from hardware power draw."],
    ["Carbon — ESTIMATED.", "Energy multiplied by grid carbon intensity for the configured region (live from Electricity Maps where a token is configured, otherwise a clearly-labelled fallback constant). Aligned to GHG Protocol Scope 2 and the Software Carbon Intensity (SCI / ISO-IEC 21031) approach. Accuracy is bounded by the energy estimate above."],
    ["Savings baseline — COUNTERFACTUAL.", "'Saved' compares actual spend against the cost had every request been served by the configured large model. It is a modelled counterfactual, not an observed alternative run."],
    ["Quality — SAMPLED.", "A fraction of small-model answers are verified off the serving path against a large-model reference, scored by a judge panel. Any coverage guarantee derived from this is MARGINAL (population-level across the sample), never a per-query guarantee, and can be violated by distribution shift."],
    ["Net vs. gross.", "Net saving subtracts verification overhead and, where configured, the Joule subscription. Gross figures are shown separately and are never presented as net."]
  ];
  for (const [h, body] of M) {
    d.text(h, { size: 9.5, font: pdf.FONTS.bold, gap: 1 });
    d.text(body, { size: 9, color: "#333333" });
    d.space(3);
  }

  d.rule();
  d.text("This report is generated from this workspace's own request log. Figures cover only the workspace and period named above. Joule makes no certification claims in this document.", { size: 8, color: MUTE });
  d.text(`Grid region: ${config.gridZone}. Generated by Joule.`, { size: 8, color: MUTE });

  return pdf.render(d);
}

module.exports = { build };
