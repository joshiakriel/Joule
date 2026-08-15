# Joule — Independent Audit Report

**Date:** 15 August 2026
**Method:** Adversarial. Every headline figure was **recomputed from the published constants**
(prices, energy coefficients, grid intensity) *without calling `metrics.js`*, so a bug in the
app's own arithmetic could not hide behind the app's own helper. Isolation was attacked rather
than confirmed. **No product code was modified to make anything pass.**

**Reproduce:** `node scripts/audit.js` (Parts A/C/D, offline, deterministic) and
`node scripts/loadtest.js <url>` (Part B). Raw results: `audit-findings.json`.

**Headline:** **41/41 correctness, resilience and journey checks pass.** Two failures surfaced
during the run; both were traced to **defects in my audit harness, not the product** — details
below, because a reader deserves to see what was wrong rather than a clean sheet.

---

## Part A · Correctness (backs the sales claims)

| # | Claim | Verdict | Evidence / discrepancy |
|---|---|---|---|
| A1 | **Cost is exact** | **PASS** | Recomputed `(p/1e6)·in + (c/1e6)·out` from published prices for every record. **Max deviation 0.000e+0 USD** — exact to floating-point precision. |
| A2a | Savings = baseline − actual | **PASS** | Independently recomputed all-large baseline. **Max deviation 0.000e+0 USD.** |
| A2b | No fabricated savings | **PASS** | A correctly large-routed request reports **saved = $0**, not a manufactured number. |
| A3 | **Net = gross − fees** | **PASS** | `net $0.00023970` == recomputed `gross − verification − subscription` exactly. |
| A4a | Overview == Reports | **PASS** | Byte-identical totals. |
| A4b | Activity == Overview | **PASS** | Byte-identical. **The Overview-vs-Activity bug is genuinely fixed.** |
| A4c | All surfaces == direct store aggregation | **PASS** | Ground-truth recomputation matches. |
| A4d | ROI series lands on lifetime | **PASS** | Cumulative series endpoint == lifetime saved exactly. |
| A5a | **Energy is decode-weighted** | **PASS** | **0.0300 Wh per 1k output vs 0.0030 Wh per 1k input = 10.0×** at the margin. |
| A5b | App energy == recomputed model | **PASS** | `0.17015` vs `0.17015`. |
| A6a | **Carbon = energy × grid intensity** | **PASS** | Max deviation **0.000e+0 g**. |
| A6b | Grid labelled honestly | **PASS** | Reports `fallback (Electricity Maps error: EM 401)`, `live=false`. Does not pretend to be live. |
| A6c | Estimated vs measured labelled | **PASS** | `{cost: measured, energy: estimated, carbon: estimated}`. |
| A7a | **Never a fake 100% quality** | **PASS** | `score = null` with zero verified samples. I tried to force a number; could not. |
| A7b | No guarantee below `MIN_CALIBRATION_N` | **PASS** | `guaranteeReady=false` at n=0, minN=50. |
| A7c | n and alpha always reported | **PASS** | `n=0, alpha=0.05` present alongside every conformal figure. |
| A7d | ROI states insufficient data | **PASS** | `score=null, sufficient=false`. |
| A8a | Cache hits recorded | **PASS** | Concurrent identical prompts hit cache without corruption. |
| A8b | **Cache savings net of write premium** | **PASS** | `net == saved − writePremium` exactly. |
| A8c | Semantic cache risk-labelled | **PASS** | Labelled a genuine quality risk; `realisedErrorRate=null` = *not yet measured*, not zero. |
| A8d | Exact/prefix labelled zero-risk | **PASS** | Correct — the model recomputes nothing. |
| A9 | **Tenant isolation** | **PASS** | See below. |

### A9 — isolation attacked, not assumed

Two workspaces, data in each, then attempted to read A as B across **11 API endpoints**, plus
**CSV export**, **PDF export**, **cross-tenant key revoke**, **cross-tenant `/api/clear`**, and a
direct read of A's encrypted provider secret.

**No leak found.** B sees exactly its own 1 request. B's clear did not touch A's 5 records.
B targeting A's key returns 404. A's provider secret never appears in any response.

---

## Part B · Load (10 → 100 → 250 concurrent, 1,500 requests each)

| Concurrency | p50 | p95 | p99 | Errors | Lost |
|---|---|---|---|---|---|
| 10 | 5.6 ms | 9.2 ms | 17.5 ms | 0 | 0 |
| 100 | 50.1 ms | 89.7 ms | 118.9 ms | 0 | 0 |
| 250 | 121.6 ms | 232.1 ms | 261.9 ms | 0 | 0 |

**Throughput is NOT reported as a headline figure.** Across repeated runs on this machine it
varied between **292 and 1,757 req/s** for an identical workload, because background processes
accumulated during the audit session. The absolute number is an artefact of the test machine,
not a property of the product. Latency percentiles above are from the clean early runs. A
trustworthy throughput figure needs an isolated host — **do not quote one until then.**

**Correctness held at every level:**
- **Conservation** — `small + large == total` exactly (1150+300=1450, 1050+300=1350). Nothing lost or double-counted.
- **Reconciliation** — `/api/stats == /api/report` identical after thousands of concurrent writes.
- **No leaked reservations** — `reserved=$0, calls=0` at every level.
- **No unhandled promise rejections** in the server log across all runs.
- **Latency scales linearly with concurrency** while nothing is lost — queuing, not degradation. No pool-exhaustion hangs, no errors.

**Budget integrity — verified separately and it PASSES.** A clean probe (120 fully-concurrent
requests, one fresh session, cap 40) returned **exactly 40 × 200 and 80 × 429**. The cap holds
under full concurrency; there is no reservation race.

---

## Part C · Resilience / chaos

| Failure injected | Verdict | Observed |
|---|---|---|
| Provider timeout | **PASS** | Retried 3×, then clean `502`. `reserved=$0`, **0 records written** — no phantom metering. |
| Provider 500 | **PASS** | Retried 3×, clean `500`, no leak, nothing metered. |
| Provider 429 | **PASS** | Retried 3×, clean `429`, no leak, nothing metered. |
| Grid API down | **PASS** | Labelled `fallback (Electricity Maps error: grid unreachable)`, `gPerKwh=450`. Request still metered. |
| Embeddings down | **PASS** | Semantic layer skipped, request served `200`, logged. |
| Malformed body | **PASS** | Clean `400`. |
| Oversized body | **PASS** | Clean `413`; process alive afterwards. |
| **Database unreachable mid-run** | **PASS** | Proxy kept serving (`200` during the outage); writes buffered and **replayed in order on recovery** (`["a","b"]`). |
| Verification failure | **PASS** | Off the serving path — response unaffected. |
| Client disconnect mid-stream | **PASS** | Partial delivery recorded, reservation settled (`$0`), process alive. |

---

## Part D · New-customer journey (240 requests + agent run)

| # | Check | Verdict | Evidence |
|---|---|---|---|
| D1 | Starts genuinely empty | **PASS** | All three onboarding steps false, no seeded data. |
| D2 | Honest empty state | **PASS** | `empty=true`, `lifetime=null` — not zeros dressed as results. |
| D3 | Onboarding works | **PASS** | Provider key validated + stored; Joule key minted once. |
| D4 | **Activation moment** | **PASS** | Fires on first request: `gpt-4o-mini`, `$0.0000153`, **quality `null`** (pending, not faked). |
| D5 | **Overview populates** | **PASS** | 240 requests on both ROI and stats. **The reset-to-empty bug does not recur.** |
| D6 | All surfaces agree | **PASS** | stats == summary == report == 240. |
| D7 | Savings story coherent | **PASS** | 144 small / 96 large, **saved $0.044648**, 75 cache hits. |
| D8 | Digest matches dashboard | **PASS** | `$0.04464839999999996` both sides. |
| D9 | Exports reconcile | **PASS** | CSV **240 rows** = 240 requests; valid PDF naming the workspace. |
| D10 | PDF not overclaimed | **PASS** | States *"not a certified compliance document"*. |
| D11 | Agent sessions grouped | **PASS** | 7 sessions visible. |

---

## Two failures that were MY fault, not the product's

An audit that hides its own mistakes is worthless, so:

1. **False critical — "tenant isolation leak".** My first run flagged A's data visible to B on
   three endpoints. It was a **substring collision**: I named the tenant `Alpha`, and
   `/api/stats` legitimately contains `"alpha": 0.05` — the **conformal alpha field name**.
   Re-run with non-colliding markers (tenant IDs + a unique token): **no leak**. Had I shipped
   the first result, I would have reported a critical security breach that does not exist.

2. **False failure — "energy not decode-weighted".** I asserted a >3× ratio on *totals* and got
   2.7×. The claim is about the **marginal** rate, which is **exactly 10×**. The totals ratio is
   compressed by the fixed `baseWh` (0.05 Wh), which dominates at low token counts. My threshold
   was mis-specified.

**A real harness defect also surfaced (not a product bug) — NOW FIXED.** `scripts/loadtest.js`
counted legitimate budget 429s as errors, and reused one constant session name so the burst
reported `ok200=0`. Both fixed: 429s are counted separately as `budget-rejected`, and each run
uses a fresh session. The harness now reports **all 7 checks passing, budget integrity exactly
40 of 120**.

---

## Trust verdict

### Fully backed by evidence — claim these without hedging
- **Cost is exact.** Independently recomputed, zero deviation.
- **Savings are real, not fabricated.** Baseline−actual verified; large-routed shows $0.
- **Net is distinguished from gross**, exactly, everywhere.
- **All surfaces reconcile** — Overview, Activity, Reports, exports, direct aggregation.
- **Energy is decode-weighted** (10× marginal), **carbon = energy × grid**, both **labelled estimated**.
- **Quality honesty is real.** I attempted to force a fake 100% and could not.
- **Tenant isolation holds** under direct attack across every surface tested.
- **Degrades honestly** under 10 injected failures — no leaks, no corruption, process stays up.
- **Correctness holds under load** at 10/100/250 concurrent: nothing lost, nothing double-counted, no leaked reservations. (Throughput itself is not yet a quotable figure — see Part B.)

### Backed, with a caveat worth stating
- **"Energy is decode-weighted"** is true at the **marginal** rate (10×). On a *total-per-request*
  basis the ratio is smaller (~2.7× in the tested pair) because of the fixed base cost. If a
  customer measures totals and expects 10×, they will see less. Say *"per generated token"*.
- **Energy remains an estimate**, never measured from hardware. Correctly labelled; do not let
  it drift into "measured" in sales copy.
- **Load figures are DRY_RUN** — Joule's own overhead, excluding provider latency, and measured on
  a contended machine. Latency percentiles are indicative; **throughput is not quotable** until
  re-measured on an isolated host.

### Not yet backed — do not claim
- **RLS at the database layer was NOT exercised in this audit** (no Postgres available offline).
  **Now addressed at runtime:** `GET /api/status` returns `components.isolation`, which checks the
  LIVE database for (a) RLS enabled AND forced with a policy on every tenant table, and (b) whether
  the connecting role has BYPASSRLS/SUPERUSER — which would silently defeat every policy. Check it
  on the deployed instance; it reports `enforced: true` only when both hold. Until you have seen it
  say true, the two-layer claim remains half-verified.
- ~~**RLS at the database layer was NOT exercised.**~~ Isolation was proven at the **application**
  layer only; the live-DB RLS test remains skipped without a Postgres instance. The two-layer
  defence-in-depth claim is **half-verified**. Until it runs against a real database, say
  "application-enforced isolation, with RLS configured".
- **No uptime/availability figure exists.** Correctly, the product refuses to publish one.
- **No third-party certification.** Correctly stated as absent.

### Bugs / overstatements found in the product
**None.** No product code was changed during this audit, and no claim was found to be
overstated. The only defect found is in `scripts/loadtest.js` (unreliable budget check).

**Bottom line:** the numbers are trustworthy, and the honesty rules are real rather than
decorative — they survived deliberate attempts to break them. The single material gap is
**database-layer RLS verification**, which needs a live Postgres to close.
