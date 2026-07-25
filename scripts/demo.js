"use strict";
/**
 * Demo seed script — fires a batch of varied prompts at a running Joule proxy so
 * the dashboard shows real accumulated savings (nice for a screenshot).
 *
 *   node scripts/demo.js [baseUrl] [count]
 *   DEMO_TARGET=https://joule-mvp.onrender.com node scripts/demo.js
 *
 * Dependency-free: uses global fetch (Node >=18). Works against a DRY_RUN server
 * with no API key. Target resolves from argv[2] or DEMO_TARGET, default localhost.
 */

const TARGET = (process.argv[2] || process.env.DEMO_TARGET || "http://localhost:3000").replace(/\/$/, "");
const COUNT = Number(process.argv[3] || process.env.DEMO_COUNT || 30);

// Templates × topics => MOSTLY DISTINCT prompts, so the mix reflects real traffic
// (routing + verification), not a cache that swallows everything. A minority repeat
// to still demonstrate the cache lever. Randomised per run to limit cross-run cache.
const TOPICS = [
  "the onboarding flow", "the billing webhook", "invoice exports", "the search index",
  "mobile checkout", "the auth service", "report generation", "the notification queue",
  "user preferences", "the payment retry logic", "session handling", "the CSV importer",
  "rate limiting", "the caching layer", "webhook retries", "the audit log",
  "profile photos", "the recommendation feed", "email delivery", "the settings page",
  "password resets", "the dashboard charts", "API pagination", "the upload pipeline",
  "feature flags", "the pricing table", "timezone handling", "the export scheduler",
  "currency formatting", "the search filters"
];
const TEMPLATES = [
  // small-tier (trivial/format)
  (x) => `summarise ${x} in one short line`,
  (x) => `reformat the notes about ${x} into bullet points`,
  (x) => `shorten the description of ${x} for me`,
  (x) => `what does ${x} do, briefly?`,
  // large-tier (reason/code)
  (x) => `analyse and evaluate the trade-offs of ${x} step by step`,
  (x) => `design ${x} and derive its failure modes in depth`,
  (x) => `debug the async race condition in ${x} in Node.js`,
  (x) => `write a regex and SQL to validate ${x}`
];

function buildPrompts(n) {
  const combos = [];
  for (const t of TOPICS) for (const tpl of TEMPLATES) combos.push(tpl(t));
  // shuffle (Fisher–Yates) so each run uses a different subset -> fewer cross-run cache hits
  for (let i = combos.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [combos[i], combos[j]] = [combos[j], combos[i]]; }
  const distinctCount = Math.max(1, Math.ceil(n * 0.85));
  const out = combos.slice(0, distinctCount);
  // ~15% deliberate repeats to exercise the normalized-exact cache
  const repeats = n - out.length;
  for (let k = 0; k < repeats; k++) out.splice(Math.floor(Math.random() * out.length), 0, out[k % out.length]);
  return out.slice(0, n);
}

async function sendOne(content) {
  const res = await fetch(TARGET + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content }] })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await res.json();
  return { tier: res.headers.get("x-joule-tier"), mode: res.headers.get("x-joule-mode") };
}

async function main() {
  const prompts = buildPrompts(COUNT);
  console.log(`Joule demo → ${TARGET}  (${prompts.length} prompts)`);

  let small = 0, large = 0, cache = 0, errors = 0;
  for (const p of prompts) {
    try {
      const r = await sendOne(p);
      if (r.tier === "small") small++; else if (r.tier === "large") large++;
      if (r.mode === "cache") cache++;
    } catch (err) {
      errors++;
      console.error(`  ✗ ${err.message}: "${p.slice(0, 40)}"`);
    }
  }

  console.log("\nDone.");
  console.log(`  sent:   ${prompts.length}`);
  console.log(`  small:  ${small}`);
  console.log(`  large:  ${large}`);
  console.log(`  cached: ${cache}`);
  console.log(`  errors: ${errors}`);
  console.log(`\nOpen ${TARGET}/ for the dashboard, or ${TARGET}/api/report for the report.`);
  if (errors) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`demo failed: ${err.message}`);
  console.error(`is a server running at ${TARGET}?  (npm start, or set DEMO_TARGET)`);
  process.exitCode = 1;
});
