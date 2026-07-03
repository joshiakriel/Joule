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

// A spread across the router's signal families so routing looks realistic.
const TRIVIAL = [
  "hi there",
  "thanks so much!",
  "hello, how are you today",
  "what's the capital of France",
  "good morning"
];
const FORMAT = [
  "summarise this paragraph in one line",
  "translate 'good evening' into Spanish",
  "reformat these notes into bullet points",
  "shorten this sentence for me"
];
const REASON = [
  "prove step by step that the square root of 2 is irrational and analyse the argument",
  "design the architecture and evaluate the trade-offs of a multi-region database",
  "explain how a transformer attention head works and why it scales",
  "compare and evaluate two strategies for cutting inference cost"
];
const CODE = [
  "write a Python function with async code to debug a race condition",
  "give me a regex to validate an email and explain each part",
  "refactor this Node.js API handler and fix the SQL injection",
  "why does this TypeScript generic fail to compile"
];

// Two deliberate repeats to exercise the normalized-exact cache.
const REPEATS = ["hi there", "write a Python function with async code to debug a race condition"];

function buildPrompts(n) {
  const pools = [TRIVIAL, FORMAT, REASON, CODE];
  const out = [];
  let i = 0;
  while (out.length < n) {
    const pool = pools[i % pools.length];
    out.push(pool[Math.floor(i / pools.length) % pool.length]);
    i++;
  }
  // sprinkle the repeats in so cache hits show up
  for (const r of REPEATS) out.splice(Math.floor(out.length / 2), 0, r);
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
