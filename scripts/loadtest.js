"use strict";
/**
 * Joule concurrency load-test harness (dependency-free, global fetch, Node >=18).
 *
 * Fires N concurrent clients at a running Joule server with a realistic MIX:
 * cache hits + misses, simple (small-routed) + complex (large-routed) prompts, some
 * agent sessions, and a slice against a tight per-session budget. Sustains until a
 * total request count is reached, then reports throughput + latency p50/p95/p99 and
 * checks CORRECTNESS under load: conservation, reconciliation, and budget integrity.
 *
 * Run against a DRY_RUN server so it's deterministic, offline and free — we're testing
 * OUR concurrency, not the provider:
 *   DRY_RUN=true node src/server.js            # terminal 1
 *   node scripts/loadtest.js                    # terminal 2
 * Config: argv[2]/LOAD_TARGET, LOAD_CONCURRENCY (100), LOAD_REQUESTS (3000),
 *         LOAD_BUDGET_K (25) — the exact number of budgeted-session calls allowed.
 */
const TARGET = (process.argv[2] || process.env.LOAD_TARGET || "http://localhost:3000").replace(/\/$/, "");
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY || 100);
const REQUESTS = Number(process.env.LOAD_REQUESTS || 3000);
const BUDGET_K = Number(process.env.LOAD_BUDGET_K || 25);
const BUDGET_SESSION = "loadtest-budget-" + Math.random().toString(36).slice(2, 10);

// deterministic-ish prompt mix (no wall-clock dependence in the content)
const SIMPLE = ["hi thanks", "summarise this briefly", "translate hello to french", "say hello", "one short greeting"];
const COMPLEX = ["Prove step by step and analyse why this algorithm has a race condition and refactor it",
  "Analyse the root cause and evaluate the mitigation trade-offs in depth, step by step"];
const REPEAT = ["a repeated cacheable prompt used many times"]; // drives exact-cache hits

const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const post = (body, headers = {}) => fetch(TARGET + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

// Build the plan up front so the mix (and the exact number of budgeted calls) is fixed.
function plan(n) {
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const r = i % 10;
    if (r < 3) jobs.push({ kind: "repeat", body: { model: "auto", messages: [{ role: "user", content: REPEAT[0] }] } });                 // 30% cache hits
    else if (r < 7) jobs.push({ kind: "simple", body: { model: "auto", messages: [{ role: "user", content: `${SIMPLE[i % SIMPLE.length]} #${i}` }] } }); // 40% small, distinct
    else if (r < 9) jobs.push({ kind: "complex", body: { model: "auto", messages: [{ role: "user", content: `${COMPLEX[i % COMPLEX.length]} #${i}` }] } }); // 20% large
    else jobs.push({ kind: "session", body: { model: "auto", messages: [{ role: "user", content: `agent step ${i}` }] }, headers: { "x-joule-session": `agent-${i % 100}` } }); // 10% sessions (few calls each, under any cap)
  }
  return jobs;
}

async function worker(queue, results) {
  let job;
  while ((job = queue.pop())) {
    const t0 = performance.now();
    try {
      const res = await post(job.body, job.headers);
      const dt = performance.now() - t0;
      results.latencies.push(dt);
      results.byStatus[res.status] = (results.byStatus[res.status] || 0) + 1;
      if (res.status === 429) results.budgetRejected++;      // enforcement working, not a fault
      else if (res.status !== 200) results.nonOk++;
      await res.text(); // drain
    } catch (err) {
      results.errors++;
      results.errList.push(String(err && err.message));
    }
  }
}

async function fireBudget(k) {
  // Fire (k*3) fully-concurrent requests on ONE budgeted session. Exactly k must get 200,
  // the rest 429 — never k+1 (that would be a reservation race). Concurrency is the point:
  // launch them all before any settles.
  const total = k * 3;
  const ps = [];
  for (let i = 0; i < total; i++) ps.push(post({ model: "auto", messages: [{ role: "user", content: `budgeted call ${i}` }] }, { "x-joule-session": BUDGET_SESSION }).then(async (r) => { await r.text(); return r.status; }).catch(() => 0));
  const statuses = await Promise.all(ps);
  return { ok200: statuses.filter((s) => s === 200).length, got429: statuses.filter((s) => s === 429).length, total };
}

async function main() {
  console.log(`\nJoule load test → ${TARGET}`);
  console.log(`  concurrency=${CONCURRENCY}  requests=${REQUESTS}  (budget K = the server's MAX_CALLS_PER_SESSION)\n`);
  const health = await fetch(TARGET + "/api/health").then((r) => r.json()).catch(() => null);
  if (!health) { console.error(`no server at ${TARGET} — start one with: DRY_RUN=true node src/server.js`); process.exit(1); }

  // clear + snapshot baseline
  await fetch(TARGET + "/api/clear", { method: "POST" });

  // ---- main mixed load ----
  const jobs = plan(REQUESTS);
  const queue = jobs.slice();
  const results = { latencies: [], byStatus: {}, nonOk: 0, budgetRejected: 0, errors: 0, errList: [] };
  const rss0 = process.memoryUsage().rss;
  const start = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue, results)));
  const elapsed = (performance.now() - start) / 1000;
  const rss1 = process.memoryUsage().rss;

  // ---- budget-integrity burst (separate tight-budget session) ----
  // K is the server's actual per-session call cap (only meaningful with enforcement on).
  const preStats = await fetch(TARGET + "/api/stats").then((r) => r.json());
  const serverK = preStats.budget.enforce ? (preStats.budget.limits.maxCallsPerSession || 0) : 0;
  const budget = serverK > 0 ? await fireBudget(serverK) : null;

  // ---- pull server-side truth ----
  const stats = await fetch(TARGET + "/api/stats").then((r) => r.json());
  const report = await fetch(TARGET + "/api/report?format=json").then((r) => r.json());
  const t = stats.totals;

  // ---- throughput + latency ----
  const lat = results.latencies;
  console.log("── throughput & latency (Joule overhead, DRY_RUN) ──");
  console.log(`  completed:   ${lat.length} in ${elapsed.toFixed(2)}s  =>  ${(lat.length / elapsed).toFixed(0)} req/s`);
  console.log(`  latency ms:  p50=${pct(lat, 50).toFixed(1)}  p95=${pct(lat, 95).toFixed(1)}  p99=${pct(lat, 99).toFixed(1)}  max=${Math.max(...lat).toFixed(1)}`);
  console.log(`  statuses:    ${JSON.stringify(results.byStatus)}  unexpected=${results.nonOk}  budget-rejected=${results.budgetRejected}  errors=${results.errors}`);
  console.log(`  rss growth:  ${((rss1 - rss0) / 1e6).toFixed(1)} MB (client-side; the server's exact cache is bounded by CACHE_MAX_ENTRIES)`);

  // ---- correctness assertions ----
  const checks = [];
  const add = (name, pass, detail) => { checks.push({ name, pass, detail }); console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
  console.log("\n── correctness under load ──");

  const conserved = t.routedSmall + t.routedLarge; // cache hits are a subset of routed (they still pick a tier)
  add("conservation: small + large == requests", conserved === t.requests, `${t.routedSmall}+${t.routedLarge}=${conserved} vs ${t.requests}`);
  add("no lost/dropped requests", lat.length === REQUESTS && results.errors === 0, `completed ${lat.length}/${REQUESTS}, errors ${results.errors}`);
  add("no unexpected non-200s (429s from budget enforcement are correct, not faults)", results.nonOk === 0,
    `unexpected=${results.nonOk}, budget-rejected=${results.budgetRejected} (expected when BUDGET_ENFORCE is on)`);
  add("cache hits recorded (concurrent identical requests)", t.cacheHits > 0, `cacheHits=${t.cacheHits}`);

  // reconciliation: stats == report == store aggregate (byte-identical totals)
  const eq = JSON.stringify(t) === JSON.stringify(report.totals);
  add("reconciliation: /api/stats totals == /api/report totals", eq, eq ? "identical" : "MISMATCH");

  // budget integrity: exactly K succeed, rest 429, none extra
  if (budget) add(`budget integrity: exactly ${serverK} of ${budget.total} succeed`, budget.ok200 === serverK, `ok200=${budget.ok200}, 429=${budget.got429}`);
  else console.log(`  SKIP  budget integrity — start server with BUDGET_ENFORCE=true MAX_CALLS_PER_SESSION=N to check`);
  add("no leaked reservations after the run", Math.abs(stats.budget.reserved.global) < 1e-9 && (stats.budget.reserved.calls || 0) === 0, `reserved=$${stats.budget.reserved.global}, calls=${stats.budget.reserved.calls || 0}`);

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${failed.length ? "❌ " + failed.length + " CHECK(S) FAILED" : "✅ all correctness checks passed"}\n`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error("loadtest failed:", err.message); process.exit(1); });
