"use strict";
/**
 * Agent / automated-workload example — proves Joule meters SCRIPTED LLM traffic,
 * not just prompts a human types into the dashboard.
 *
 *   node examples/agent-workload.js [baseUrl]
 *   DEMO_TARGET=https://joule-mvp.onrender.com node examples/agent-workload.js
 *
 * Simulates an unattended "support-ticket triage agent" with NO human in the loop.
 * For each ticket it makes several CHAINED LLM calls through Joule:
 *   1) classify priority   (short prompt  -> routes small)
 *   2) summarize the ticket (short prompt  -> routes small)
 *   3) if HIGH priority, a deeper root-cause analysis (complex -> routes large)
 *
 * Every call is a normal OpenAI /v1/chat/completions request — the ONLY thing the
 * agent changed is baseURL. That is the whole point: point an agent at Joule and
 * its entire autonomous workload is metered + routed automatically.
 *
 * Dependency-free: global fetch (Node >=18). Works against a DRY_RUN server (no key).
 */

const TARGET = (process.argv[2] || process.env.DEMO_TARGET || "http://localhost:3000").replace(/\/$/, "");
// Tag every call in this run with one session id so the whole agent run shows up
// as a single labelled session in the dashboard ("one agent run = N calls, X g CO2").
const SESSION = "triage-agent-" + new Date().toISOString().replace(/[:.]/g, "-");

// A queue of tickets an automated pipeline would pull from a helpdesk — no human
// is prompting the model; the script drives every call. `severity` is the known
// triage outcome used offline (in a live run, priority comes from the model's
// classify answer — see decidePriority()).
const TICKETS = [
  { id: "T-1042", subject: "Login page loads slowly for some users", severity: "normal" },
  { id: "T-1043", subject: "Password reset email never arrives", severity: "high" },
  { id: "T-1044", subject: "Checkout button unresponsive on mobile", severity: "high" },
  { id: "T-1045", subject: "Profile photo upload fails intermittently", severity: "normal" },
  { id: "T-1046", subject: "Billing invoice shows the wrong currency", severity: "high" },
  { id: "T-1047", subject: "Search results missing recent items", severity: "normal" },
  { id: "T-1048", subject: "Notification emails delayed by hours", severity: "normal" },
  { id: "T-1049", subject: "Account page shows a blank screen", severity: "high" }
];

// ---- one OpenAI-compatible call through Joule -------------------------------
async function callJoule(content) {
  const res = await fetch(TARGET + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-joule-session": SESSION },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content }] })
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`HTTP ${res.status}: ${body.error?.message || "request failed"}`);
  }
  const data = await res.json();
  return {
    tier: res.headers.get("x-joule-tier"),
    model: res.headers.get("x-joule-model"),
    answer: data.choices?.[0]?.message?.content || ""
  };
}

// Live: read priority from the model's classification. Offline (dry-run answers
// are placeholders): fall back to the ticket's known severity so the deep-analysis
// branch is deterministic.
function decidePriority(ticket, classifyAnswer) {
  if (/\bhigh\b/i.test(classifyAnswer || "")) return "high";
  return ticket.severity;
}

// ---- number formatting (screenshot-friendly) --------------------------------
const usd = (x) => "$" + (x >= 0.01 ? x.toFixed(4) : x.toFixed(6));
const wh = (x) => (x >= 1000 ? (x / 1000).toFixed(2) + " kWh" : x.toFixed(2) + " Wh");
const g = (x) => (x >= 1000 ? (x / 1000).toFixed(2) + " kg" : x.toFixed(2) + " g");
const pad = (s, n) => String(s).padEnd(n);

async function stats() {
  const r = await fetch(TARGET + "/api/stats");
  if (!r.ok) throw new Error(`/api/stats HTTP ${r.status}`);
  return (await r.json()).totals;
}

async function main() {
  console.log(`\nJoule · agent workload → ${TARGET}`);
  console.log("Simulating an unattended support-triage agent — no human in the loop.\n");

  const before = await stats(); // so the summary reflects THIS run, not prior data
  let errors = 0;
  const step = (label, r) => console.log(`    · ${pad(label, 21)}→ ${pad(r.tier, 5)} (${r.model})`);

  for (let i = 0; i < TICKETS.length; i++) {
    const t = TICKETS[i];
    console.log(`  Ticket ${i + 1}/${TICKETS.length}  ${t.id}  "${t.subject}"`);
    try {
      const c = await callJoule(`Classify the priority (low, medium, high) of this support ticket: "${t.subject}"`);
      step("classify priority", c);

      const s = await callJoule(`Summarize this support ticket in one short sentence: "${t.subject}"`);
      step("summarize", s);

      if (decidePriority(t, c.answer) === "high") {
        const a = await callJoule(
          `Analyse the likely root cause of this incident step by step and evaluate the trade-offs ` +
          `of each mitigation strategy, then recommend a remediation plan: "${t.subject}"`
        );
        step("deep analysis [HIGH]", a);
      }
    } catch (err) {
      errors++;
      console.error(`    ✗ ${err.message}`);
    }
  }

  const after = await stats();
  // Deltas attributable to THIS run — derived straight from /api/stats, so the
  // printed numbers match the server's totals by construction.
  const d = (path) => path(after) - path(before);
  const dCostActual = d((t) => t.cost.actual), dCostBase = d((t) => t.cost.baseline), dCostSaved = d((t) => t.cost.saved);
  const dEnActual = d((t) => t.energyWh.actual), dEnBase = d((t) => t.energyWh.baseline), dEnSaved = d((t) => t.energyWh.saved);
  const dCoActual = d((t) => t.carbonG.actual), dCoBase = d((t) => t.carbonG.baseline), dCoSaved = d((t) => t.carbonG.saved);
  const dTokens = d((t) => t.tokens);
  const dReq = d((t) => t.requests), dSmall = d((t) => t.routedSmall), dLarge = d((t) => t.routedLarge);
  const savedPct = dEnBase > 0 ? Math.round((1 - dEnActual / dEnBase) * 100) : 0;

  const bar = "  " + "─".repeat(58);
  console.log("\n" + bar);
  console.log("  AUTONOMOUS RUN SUMMARY   (script-generated · 0 human prompts)");
  console.log(bar);
  console.log(`  tickets processed      ${TICKETS.length}`);
  console.log(`  autonomous LLM calls   ${dReq}   (small ${dSmall} · large ${dLarge})`);
  console.log(`  tokens metered         ${dTokens}`);
  console.log(`  cost      this run     ${pad(usd(dCostActual), 12)} vs ${pad(usd(dCostBase), 12)} always-large  → saved ${usd(dCostSaved)}`);
  console.log(`  energy    this run     ${pad(wh(dEnActual), 12)} vs ${pad(wh(dEnBase), 12)} always-large  → saved ${wh(dEnSaved)}`);
  console.log(`  carbon    this run     ${pad(g(dCoActual), 12)} vs ${pad(g(dCoBase), 12)} always-large  → saved ${g(dCoSaved)}`);
  console.log(`  energy avoided         ${savedPct}%`);
  console.log(bar);

  // The whole run is one labelled session on the server — fetch it back to prove it.
  try {
    const sum = await (await fetch(TARGET + "/api/summary?range=1h")).json();
    const sess = (sum.sessions || []).find((s) => s.id === SESSION);
    if (sess) {
      const secs = (sess.durationMs / 1000).toFixed(1);
      console.log(`  SESSION  ${sess.id}`);
      console.log(`  one agent run = ${sess.calls} calls · ${g(sess.carbonG.actual)} CO₂ · saved ${g(sess.carbonG.saved)} · ${secs}s · ${sess.savedPct}% energy avoided`);
      console.log(bar);
    }
  } catch { /* summary is best-effort decoration */ }

  console.log("  Every call above was made by this script through Joule's /v1 endpoint —");
  console.log("  no human typed a prompt. Point any agent's OpenAI baseURL at Joule and its");
  console.log("  entire unattended workload is metered and routed automatically.\n");
  console.log(`  Verify → ${TARGET}/api/summary?range=1h   ·   ${TARGET}/api/report?format=csv\n`);

  if (errors) { console.error(`  completed with ${errors} error(s).`); process.exitCode = 1; }
}

main().catch((err) => {
  console.error(`\nagent-workload failed: ${err.message}`);
  console.error(`is a server running at ${TARGET}?  (npm start, or set DEMO_TARGET)\n`);
  process.exitCode = 1;
});
