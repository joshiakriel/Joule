# Joule — carbon & cost meter for AI inference

A drop-in, **OpenAI-compatible proxy** that sits in front of your model calls and, for every request:

1. **Meters** it — real token usage → cost (USD), energy (Wh), carbon (gCO₂)
2. **Routes** it — sends simple prompts to a smaller, cheaper, lower-carbon model
3. **Records** it — an auditable log you can export as a cost & emissions report

It's the working core of the Joule concept: *measure, optimize, and prove the cost and carbon of AI.*

> **Honesty about the numbers.** Token counts and **cost are exact** (from the provider's returned usage × your configured prices). **Energy per inference is an estimate** — no provider exposes measured watt-hours — using a transparent, configurable, **decode-weighted** model (energy scales with tokens *generated*, only weakly with prompt length) anchored to GPU-measurement research (ML.ENERGY / Zeus / TokenPowerBench; IEA *Energy & AI* for order-of-magnitude sanity). **Carbon is energy × live grid intensity** from [Electricity Maps](https://www.electricitymaps.com/), aligned to GHG Protocol Scope 2 (location-based) and the SCI standard (ISO/IEC 21031). This mixed measured/estimated approach is exactly how real carbon-accounting tools work — and it's all in `src/config.js` for you to refine.

## Quick start (2 minutes, no API key, no cost)

```bash
npm install
cp .env.example .env      # DRY_RUN=true by default
npm start
```

Open **http://localhost:3000** and click a sample prompt. You'll see it routed and metered end-to-end with synthesized answers (clearly badged `dry_run`) — the full pipeline, zero spend.

## Go live (real model calls)

Edit `.env`:

```bash
DRY_RUN=false
UPSTREAM_API_KEY=sk-...            # your OpenAI / OpenRouter / Together / Groq key
MODEL_SMALL=gpt-4o-mini
MODEL_LARGE=gpt-4o
ELECTRICITYMAPS_TOKEN=...          # free tier → live grid carbon
GRID_ZONE=AE                       # AE = UAE, ZA = South Africa, DE, US-CAL-CISO, ...
```

Restart. Now every call is real, tokens are real, and carbon uses live grid data.

## Use it from your app (drop-in)

Change only the base URL — no other code changes:

```js
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://localhost:3000/v1", apiKey: "unused" });
const r = await client.chat.completions.create({
  model: "auto",                    // Joule picks the tier
  messages: [{ role: "user", content: "summarise this in one line: ..." }]
});
// metrics come back on the response headers: x-joule-cost-usd, x-joule-energy-wh,
// x-joule-co2-g, x-joule-saved-usd, x-joule-saved-co2-g
```

```bash
# or with curl
curl http://localhost:3000/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi, thanks!"}]}' -i
```

**Streaming** works too — set `"stream": true` for an OpenAI-style SSE stream (`client.chat.completions.create({..., stream:true})`, or `curl -N ... -d '{"model":"auto","stream":true,"messages":[...]}'`). Streamed requests are still routed, metered, and logged (they show up in `/api/stats` and `/api/report`), but the `x-joule-*` metrics headers aren't set — headers flush before token usage is known.

## Quality verification (the differentiator)

Routing to a cheaper model risks a **silent quality regression** — the bill drops, quality
quietly drops, and you find out days later from support tickets. Joule doesn't just route
cheaper; it **verifies the cheap answer held quality**, so the savings are defensible.

A bare **LLM-as-judge is scientifically fragile** — documented position/verbosity/
self-preference bias, and here the *large* model would be judging the *small* model's answer
(the exact self-preference case), systematically under-rating the cheap answer and
understating our own savings. So Joule uses a **calibrated + conformal** design and demotes
the judge to a *labeller*:

1. **Signal** (`src/signals.js`) — a cheap per-request routing signal (the router's own margin;
   **no extra model call**), computed before generation. Plus post-generation deterministic
   checks (non-empty, valid JSON when requested, tool-call when tools provided, not truncated).
2. **Calibration** (`src/calibrate.js`) — **isotonic regression** (Pool-Adjacent-Violators, ~40
   lines of plain JS, *no ML dependency*) maps the raw signal → calibrated probability the small
   answer is acceptable. Persisted; refit periodically; **ECE** reported.
3. **Conformal risk control** (`src/conformal.js`) — a distribution-free threshold (CRC bound,
   Angelopoulos et al.) such that the probability of unacceptable degradation is bounded by
   `TARGET_RISK_ALPHA` (default `0.05`). **Route small only when the calibrated score clears it.**
   Two threshold modes (`CONFORMAL_MODE`):
   - **`adaptive` (default)** — *Adaptive Conformal Inference* (Gibbs & Candès 2021). Instead of a
     static threshold refit periodically, a working level `alpha_t` self-corrects **online** after
     each verified outcome: `alpha_t += gamma*(alpha - err_t)` (a miss tightens, a clean hit relaxes),
     and the threshold is the CRC quantile over the **recent window** (`ACI_WINDOW`, 500) at `alpha_t`.
     It **re-converges through distribution shift** rather than going stale. A **rolling realised
     coverage** tracker exposes achieved-vs-target coverage over the window. When drift fires, the
     learning rate is boosted (`ACI_GAMMA_DRIFT`, 0.05 vs base `ACI_GAMMA`, 0.01) for faster
     re-convergence and the readout is flagged *drift-boosted*. `alpha_t` is floored at the
     finite-sample limit `1/(n+1)` so it never demands tighter coverage than the window can certify.
   - **`static`** — the frozen full-set CRC solve (the prior behaviour, exactly reproducible for A/B).
4. **Judge → labeller only** (`src/verify.js`) — for a sampled fraction (`VERIFY_SAMPLE_RATE`,
   default `0.1`) of small answers, *off the serving path*, Joule gets a reference (large-model)
   answer and a **judge panel** label (`JUDGE_MODELS`), with **randomised answer order**, a
   reference answer in the prompt, and **agreement reporting** (low-agreement samples are treated
   as low-confidence and excluded). The label feeds calibration; the judge **never gates live
   traffic**.
5. **Drift detection** — tracks the routing-signal distribution of live traffic vs. the
   calibration set; on material drift it warns *"recalibration needed"* and biases to large.

`X-Joule-Quality-Floor` lets a caller demand a stricter per-request bar. The dashboard headline
reads *"saved X% · quality held at Y% (95% confidence, conformal α=0.05, n=Z)"*, with a quality
column in the activity log and a quality line per session.

**Honesty rules (non-negotiable — these are the product):**
- **Never a per-query guarantee.** The conformal bound is **marginal** (population-level) and
  distribution shift can violate it — every claim reports **n, α, and the rolling realised coverage**
  (adaptive mode additionally reports the working `α_t` and whether adaptation is drift-boosted).
- **Never a fake number.** Below `MIN_CALIBRATION_N` (default `50`) the UI/API show *"insufficient
  data for a guarantee"* and fall back; with zero samples, *"not yet verified"*.
- Verification is **sampled, not exhaustive**, and the **judge is a fallible model** (even in a panel).
- Verification **costs real tokens** — reported **net savings = routing savings − verification
  overhead** is the headline (positive at the 10% default; honestly negative at 100%).

**Config (env):** `VERIFICATION_MODE` (`conformal`|`judge`, default conformal), `VERIFY_SAMPLE_RATE`
(0.1), `TARGET_RISK_ALPHA` (0.05), `MIN_CALIBRATION_N` (50), `CALIBRATION_REFIT_EVERY` (200),
`JUDGE_MODELS` (csv, default = large model), `JUDGE_ACCEPT_THRESHOLD` (0.6),
`JUDGE_AGREEMENT_THRESHOLD` (0.67), `DRIFT_K` (3), `DRIFT_MIN_N` (30), `CONFORMAL_MODE`
(`adaptive`|`static`, default adaptive), `ACI_GAMMA` (0.01), `ACI_GAMMA_DRIFT` (0.05),
`ACI_WINDOW` (500); plus the v1 fallback knobs
`QUALITY_THRESHOLD`/`VERIFY_ROLLING_WINDOW`/`VERIFY_MIN_SAMPLES`/`VERIFY_PROBE_RATE`. In `DRY_RUN`
the reference + judge are synthesized, so the whole pipeline runs fully offline.

Lineage: FrugalGPT → Hybrid LLM (ICLR 2024) → conformal risk control.

## Metering agents & automated workloads

Joule sits **on the API call**, so it meters *any* LLM request identically — whether a human
typed it or a script/agent generated it. **Automated pipelines and agents are the highest-value
case**: unattended, they fire many chained calls per task and the spend (and carbon) balloons
where nobody is watching. Point the agent's OpenAI `baseURL` at Joule and its entire autonomous
workload is metered and routed — no per-call instrumentation:

```js
import OpenAI from "openai";
// one-line swap — the agent's own code is unchanged
const client = new OpenAI({ baseURL: "http://localhost:3000/v1", apiKey: process.env.KEY });

for (const ticket of ticketQueue) {                 // no human in the loop
  const priority = await client.chat.completions.create({ model: "auto",
    messages: [{ role: "user", content: `Classify priority: ${ticket.subject}` }] });   // → small
  const summary  = await client.chat.completions.create({ model: "auto",
    messages: [{ role: "user", content: `Summarize: ${ticket.subject}` }] });            // → small
  if (isHigh(priority)) await client.chat.completions.create({ model: "auto",
    messages: [{ role: "user", content: `Root-cause analysis: ${ticket.body}` }] });     // → large
}
// every call above is routed, metered, and logged — visible in /api/stats and /api/report
```

Run the included example against a local (DRY_RUN) server — a support-triage agent that makes
~20 autonomous, chained calls with mixed routing, then prints a cost/energy/carbon summary:

```bash
npm start                 # in one terminal
npm run example:agent     # in another (or: node examples/agent-workload.js <baseUrl>)
```

> **Scope (be precise).** Joule meters **LLM / generative-AI inference calls** — anything that
> hits an OpenAI-compatible `/chat/completions` endpoint. It does **not** capture non-LLM
> operational ML (e.g. forecasting/recommendation/optimization models that never call an LLM
> API). Those need separate instrumentation; Joule's boundary is the LLM API call.

## Configure in the UI

The dashboard's **"Configure your instance"** panel lets you set the provider API key,
base URL, small/large models, Electricity Maps token and grid region at runtime — no
redeploy. Each field shows its source (*from environment* vs *set here*), and settings you
enter override the env defaults while env stays the fallback (so Render-provided secrets
keep working). `POST /api/config` accepts the same fields programmatically.

> **Security.** Secrets (API key, EM token) are held **in memory only** — never written to
> disk, never logged, and never returned by any endpoint; `GET /api/config` exposes only
> booleans + the last 4 characters. Runtime key entry is a **single-tenant demo
> convenience**: the overrides are one shared in-memory bag with no auth. Multi-tenant
> production needs authentication and encrypted per-user secret storage.

## Dashboard: filter, sessions & breakdowns

The live console works entirely off the **real request log** — nothing is mocked:

- **Time-range + filters** — scope everything (KPIs, chart, tables, log) to `Last hour / 24h / 7d / All`, by tier (small/large), mode (live/dry_run/cache), and a model search. The dashboard renders `GET /api/summary`, so the UI and server always agree.
- **Activity chart** — bucketed energy metered vs. the always-large baseline over the selected window.
- **Sessions / runs** — requests group into runs. A client can tag a run with an `X-Joule-Session` header (an agent run then shows as **one labelled session**: "N calls, X g CO₂, Y% avoided"); untagged calls bucket by time gap.
- **Per-model / per-tier breakdown** — calls, tokens, cost, energy, carbon, avg latency for every model actually used.
- **Filtered export** — `GET /api/report` accepts the same `range/tier/mode/q` params, so you export exactly what you're viewing (methodology block preserved).
- **Clear session data** — `POST /api/clear` truly empties the store (the dashboard button confirms first).

Tag an agent run from your client:

```js
await client.chat.completions.create(
  { model: "auto", messages },
  { headers: { "X-Joule-Session": "nightly-etl-2026-07-08" } }
);
```

## Endpoints

| Route | Purpose |
|---|---|
| `POST /v1/chat/completions` | OpenAI-compatible proxy (routes + meters). Optional `X-Joule-Session` header groups a run; `X-Joule-Quality-Floor` demands a stricter quality bar for that request. |
| `GET /api/stats` | Instance config, grid, all-time totals + `quality` block (rolling score, verified %, safety mode, verification overhead, net savings) |
| `GET /api/summary?range=&tier=&mode=&q=` | Filtered aggregates + time-series + per-model + sessions + `quality`, all from the real log |
| `GET /api/report?format=json\|csv&range=&tier=&mode=&q=` | Downloadable audit-style report — honours the same filters; includes `verification` stats + methodology |
| `POST /api/clear` | Truly clears the request log (in memory + on disk) |
| `GET · POST /api/config` | Masked runtime config — read effective settings / apply overrides (secret-free) |
| `GET /api/health` | Health check |
| `GET /` | Live console (dashboard) |

## Testing

```bash
npm test        # node --test — runs the whole suite offline, no API key, no network
```

Uses Node's built-in test runner (`node:test`) — no extra dependencies — and runs the whole
suite start→finish in one command. Tests run in `DRY_RUN` against an isolated temp data dir on
the memory backend, so they never touch `data/log.jsonl`, a database, or the network. Every
test asserts the **correct value**, not just "no error".

Layout (by module + an end-to-end group):

| Area | File | Asserts |
|---|---|---|
| Routing | `router.test.js`, `reasoning.test.js` | simple→small / complex→large; reasoning effort cap; explicit override wins |
| Caching | `cache.test.js`, `semcache.test.js` | exact-hit savings **net of write premium**; below-breakeven warning; semantic OFF by default; cross-tenant isolation |
| Verification | `verify.test.js`, `calibrate.test.js`, `conformal.test.js` | below `MIN_CALIBRATION_N` → "insufficient data"; never a figure with 0 samples; net-of-verification; held-out coverage ≈ (1−α); adaptive re-converges after a shift, static does not |
| Budgets | `budget.test.js` | over-cap block + session isolation; reservation settle/release; 429 body |
| Metering | `metrics.test.js`, `store.test.js` | exact cost; **decode-weighted** energy inequality; persistence + reconciliation |
| Persistence | `pgstore.test.js` | postgres survives a restart; reconciles with the durable rows (live-DB test opt-in) |
| **End-to-end** | `integration.test.js`, `e2e.test.js` | full proxy pass; reasoning override header; **three-way reconciliation**; reservation no-leak on success/stream/abort/error; provider-error resilience; the shipped `demo.js` + `agent-workload.js` run against a live DRY_RUN server |

The honesty invariants are protected by tests that genuinely fail if broken: the three-way
**reconciliation** (`/api/stats` == `/api/report` == store, field-by-field), verification running
**off the serving path** (the response returns before verification completes), and the
**insufficient-data** refusal below `MIN_CALIBRATION_N`.

To also run the live-Postgres persistence + reconciliation test, point it at a **throwaway**
database (it truncates `records`) and opt in explicitly:

```bash
STORE_PG_TEST=1 DATABASE_URL=postgresql://…  npm test
```

## Dashboard structure

A real app shell — persistent left sidebar, top bar, and a centred ~1100px content column —
not one flat scroll.

| Area | What's there | Why |
|---|---|---|
| **Overview** (default) | ONE hero band: the large **net $ saved** number with **quality held** beside it and *"since &lt;date&gt;"* under it. Then the savings-over-time chart. Then four KPI cards — spend, requests, CO₂ avoided, cache hit-rate. Nothing else. | The only question that matters on open. Nothing competes with the hero |
| **Activity** | Request log, per-model & per-tier breakdown, sessions, cache advisory, budget — plus the **"Try it"** prompt console as a small utility | Detail, one click away |
| **Reports** | Export (PDF / CSV / JSON) and the full methodology | The artefact you hand to finance |
| **Settings** | Provider key, models, grid region, dry-run, Joule API keys, service status, workspace configuration, and the danger zone | **Every** operator control lives here and nowhere else |

Navigation is hash-routed (`#overview` / `#activity` / `#reports` / `#settings`) so browser
back/forward work, the active item is announced via `aria-current`, and the sidebar collapses
to a top bar below 900px.

**Design system:** near-black warm base (`#0B1412`) with raised panels (`#12211E`) and hairline
borders. Cyan (`#33E3C7`) is reserved for the hero number, active nav and primary buttons only;
blue (`#2D87AE`) for links; amber (`#FFB233`) only for warnings. Generous padding (24–32px) and
vertical rhythm, 16px radii, soft shadows, a single faint cyan glow behind the hero, 150ms
transitions, and a count-up on the hero number when data loads.

**Progressive disclosure:** with no data, Overview collapses to **one** centred empty state
("Send your first request to see your savings") and every other module is hidden entirely —
never a wall of zero-boxes, never fabricated numbers. Onboarding hands off into Overview.

**Customer views use outcome language only** — no "demo", "dry-run", "README", "baseURL" or
proxy jargon anywhere a paying customer looks.

## The trust surface — evidence for finance, security and your own sanity

Routing production traffic through a proxy is a trust decision. These are the artefacts and
the evidence that make it defensible — all real, all tenant-scoped, nothing fabricated.

### Audit-ready export

```bash
GET /api/report?format=pdf     # branded, dated, workspace-named — the artefact you file
GET /api/report?format=csv     # row-level detail
GET /api/report?format=json    # machine-readable, full methodology block
```

All three are built from the **same totals**, so they can never disagree. The PDF is generated
by a **hand-rolled writer** (`src/pdf.js`) — zero new dependencies — and states, in full:
spend (measured), gross → **net** saving, energy and carbon (**estimated**, with the model
spelled out, GHG Scope 2 / SCI-aligned), quality (**sampled**, with the marginal-not-per-query
limit), and measured p50/p95/p99 latency. It explicitly notes that Joule makes **no
certification claims**.

### Reliability evidence — `GET /api/status`

Live component health (proxy, database, provider reachability, grid feed live-vs-fallback),
real process uptime, and **measured** p50/p95/p99 of Joule's own latency from your request log
— the data that answers "how much does the proxy add?".

**We publish no availability percentage.** Uptime history isn't retained yet, so claiming
"99.9%" would be fabricated. The status page says so and marks it *on roadmap*.

### Docs (in-app, `#docs`)

- **Quickstart** — the two-line integration, prefilled with your endpoint.
- **How every number is calculated** — cost/energy/carbon/savings/quality, each with its
  method *and its limits*. The honesty is the point, not the fine print.
- **Security & data handling** — what's stored, what isn't (`LOG_PROMPTS` off by default),
  tenant isolation + RLS, AES-256-GCM key encryption. It states plainly that we hold **no**
  third-party certification and will not imply one until we do.

### Account controls

Under **Settings**: view and **rotate** API keys (rotation issues a new key and stops the old
one immediately), see plan and usage, and export all your data in any of the three formats —
the portability half of the residency story.

## The value surface — what you've saved, stated plainly

The top of the dashboard answers "is this worth it?" without any mental math. Everything is
real, tenant-scoped, and reconciles with `/api/report`.

**The headline** — *"Since 3 Feb 2026 · 41 days · 8,214 requests optimised"*
- **Net saved** (the big number) — **after** Joule's own cost. Gross is shown beside it, never
  in its place.
- **Quality held**, immediately next to it. Savings are never displayed without the quality
  that was held while making them; with too few verified samples it says
  *"below N — not yet a guarantee"*, and with none it says *"not yet verified"*.
- CO₂ avoided and energy saved, both labelled **est**.

**The chart** (hand-rolled SVG, no chart library): cumulative **gross** savings compounding
since day one, plus a dashed **net-of-fees** line so the honest picture is always on screen.

**Where it came from** — a per-lever breakdown, each tagged with its quality risk
(`none` / `verified` / `estimated` / `quality-risk`):
- **Baseline levers** (exact cache, routing, semantic cache) sum **exactly** to the headline
  gross figure — a test enforces this, so the breakdown can't drift or double-count.
- **Separate lines** (provider prefix cache, batch discount, reasoning control) are on a
  *different basis* — a discount on actual spend, or an estimate — so they're reported apart
  and never folded into the headline.

**Payback** — with `SUBSCRIPTION_COST_MONTHLY` set: *"Joule costs $49/mo · saving you $310/mo ·
net +$261/mo · pays for itself in 0.2 months."* Without a plan price we show nothing rather
than invent a payback.

### Weekly digest

A per-tenant weekly summary — net saved, quality held, top cost-driving models and agents, and
one advisory finding — so the value stays visible between logins.

```bash
GET /api/digest            # in-app summary (JSON + ready-to-send text), tenant-scoped
GET /api/digest?days=30    # any window
GET /api/digest?send=1     # also deliver by email
```

Email is optional and provider-agnostic (`DIGEST_API_KEY`, `DIGEST_API_URL` — Resend by
default, any compatible JSON endpoint works). **With nothing configured, sending no-ops
cleanly and reports why** — it never throws and nothing on the serving path depends on it. A
quiet week says *"no requests went through Joule this week, so there's nothing to report"*
rather than emailing zeros dressed up as a result.

## Self-serve onboarding — signup to first metered request

A new user activates without talking to us. The dashboard walks them through three steps and
detects their first request automatically.

1. **Sign up / sign in** (Supabase Auth, email + password). They land in their own empty
   workspace with a **"Get started — N steps left"** panel, not a wall of zeros.
2. **Step 1 — Add your provider key.** Paste an OpenAI/Anthropic/Groq key. Joule validates it
   with a **real but free** `GET /models` call, so a typo fails here instead of in production,
   then stores it **AES-256-GCM encrypted per tenant**. It is never logged and never returned
   to the browser — `POST /api/provider-key`.
3. **Step 2 — Get your Joule key + endpoint.** `POST /api/keys` mints `jk_live_…`, shown
   **once** (stored only as a sha-256 hash) with a copy button, alongside the exact one-line
   change prefilled with their real endpoint and key, in **Node/TS, Python and curl**.
4. **Step 3 — Send your first request.** Either run the snippet in their own app or hit
   **"Send a test request for me"**. A live *"waiting for your first request…"* state polls
   `GET /api/onboarding` and **advances the moment a request arrives** — whichever way it came.
5. **Activation moment.** The wizard shows their **real** first call: *"Routed to `<model>`
   (`<tier>` tier) · cost $X · saved $Y"* plus energy, CO₂ and quality. **Nothing is seeded** —
   if quality hasn't been verified yet it says *"pending verification"*, never a fake score.

**UI honesty:** every panel has a real empty state ("No requests yet", "not yet verified",
ROI `empty: true`). The dashboard never renders a fabricated 0%, a fake 100% quality, or a
chart built from invented data.

**Setup for the operator:** `SUPABASE_URL` + `SUPABASE_ANON_KEY` (served to the browser by the
public `GET /api/auth-config` — the anon key is public by design; the **service-role key must
never** be set here), `SUPABASE_JWT_SECRET`, `JOULE_ENC_KEY`. With `AUTH_REQUIRED=false`
(DRY_RUN/dev) the login screen is skipped and everything runs in the default tenant.

**Security note:** the session token is held **in memory only** — never `localStorage`,
`sessionStorage` or cookies — so it can't be read by injected script or outlive the tab. The
trade-off is deliberate: a page refresh means signing in again. Enforced by a test.

## Settings: your connection vs. the deployment

Two genuinely different things, so they're two separate surfaces. Nothing in the UI ever
offers a save that can't succeed.

| | **Provider connection** (per workspace) | **Instance settings** (deployment-wide) |
|---|---|---|
| What | Your provider API key + base URL | Models, grid region, routing, dry-run |
| Who | **Every tenant** manages their own | **Operators only** — tenants see it read-only |
| API | `POST /api/provider-key` | `POST /api/config` |
| Storage | AES-256-GCM encrypted per tenant, **write-only** — no endpoint ever returns it | Process config from env |

**Provider connection** has quick-picks for OpenAI / Anthropic / **Groq** (`https://api.groq.com/openai/v1`)
that prefill the base URL, validates your key against the provider before saving (so a typo
fails here, not in production), and then shows *"✓ Connected to Groq · key ending ••••1234"*.
It uses the **same** validate-then-save flow as onboarding step 1 — one implementation.

**Operators** are set with `OPERATOR_EMAILS` (comma-separated allowlist) or a `role: "operator"`
claim on the JWT. With `AUTH_REQUIRED=false` (dev/DRY_RUN) the local user is the operator, so
the single-tenant workflow is unchanged.

### Sign-in requirements (read this if the dashboard won't load)

`SUPABASE_JWT_SECRET` **must be set on the server and must match your Supabase project.** If it's
missing or wrong, every `/api/*` call returns `401 authentication required` — you'll be able to
sign in (that's Supabase's own endpoint) but nothing in the dashboard will load. The UI now says
so explicitly instead of showing a blank panel.

⚠️ **HS256 only.** Joule verifies tokens with the shared JWT secret (HMAC-SHA256). Newer Supabase
projects issue **asymmetric** (ES256/RS256) tokens signed by rotating JWKS keys — those will be
rejected by this verifier and need a JWKS-based verifier instead. Check **Project Settings → API →
JWT Keys**: if you see a legacy shared "JWT Secret" in use you're fine; if the project is on
asymmetric signing keys, HS256 verification won't work.

## Multi-tenancy, auth & data isolation

Joule is multi-tenant: **every stored row, cache key, budget, calibration set and metric query
is scoped to a tenant — there are no global reads.** Isolation is enforced at two layers.
Each tenant's live model calls use **their own** encrypted provider key (never a shared one).

**How a customer's app authenticates (the `/v1` proxy).** A tenant mints a **Joule API key**
(`jk_live_…`) and puts it in the OpenAI client exactly where the model key used to go:

```python
from openai import OpenAI
client = OpenAI(base_url="https://your-joule-host/v1", api_key="jk_live_…")  # the tenant's Joule key
```

The key is shown **once** and stored only as a sha-256 hash (revocable). Joule resolves it to the
tenant (cached in memory — no per-request DB hit), then uses **that tenant's own upstream provider
key** (AES-256-GCM encrypted at rest, never logged) for the real call. A missing/invalid key → `401`.

**How the dashboard authenticates (`/api/*`).** A **Supabase Auth** JWT (email/password to start,
SSO/OIDC later). Joule verifies it locally (HS256 against `SUPABASE_JWT_SECRET` — password/session
logic stays fully managed by Supabase) and resolves the user → tenant. `/api/health` stays open.

**Two-layer isolation (defence in depth):**
1. **App layer** — every store/cache/budget/metric read takes the authenticated `tenant_id` and
   filters by it; the exact + semantic caches are namespaced by tenant (a tenant can never receive
   another's cached response); budgets and calibration are per-tenant.
2. **Database layer** — Postgres **Row-Level Security** (`ENABLE` + `FORCE`) on every tenant table
   (`records`, `users`, `api_keys`, `tenant_secrets`), policy `tenant_id = current_setting('app.current_tenant')`.
   Writes set that GUC per request; the DB itself refuses a cross-tenant read even if app code has a
   bug. Pre-auth key lookup + the mirror boot-load use `SECURITY DEFINER` functions.

**Config:** `AUTH_REQUIRED` (default ON in prod, OFF in DRY_RUN so offline tests run in the default
tenant), `SUPABASE_JWT_SECRET`, `JOULE_ENC_KEY`, `JOULE_KEY_PREFIX`, `DEFAULT_TENANT_ID`. Isolation
is protected by `test/tenancy.test.js` (incl. deliberate cross-tenant break attempts + per-tenant
reconciliation) and `test/rls.test.js` (live-DB RLS, opt-in).

## Persistence — Postgres with a memory fallback

The request log (and the async verification results attached to it) is persisted so the
dashboard and reports **survive a restart**. Two backends, one identical `store.js`
interface — chosen by `STORE_BACKEND`:

| Backend | What it does | When |
|---|---|---|
| `memory` | append-only JSONL on local disk (`data/log.jsonl`) | offline/DRY_RUN, tests, single ephemeral node |
| `postgres` | durable Postgres (Supabase, RDS, local) via `DATABASE_URL` | production; data survives restarts/redeploys |

**Default:** `postgres` when `DATABASE_URL` is set, else `memory` — so offline development and
the test suite need no database. Either way the store keeps an **in-memory mirror** and runs
the *same* JS aggregation, so `/api/stats`, `/api/report` and a direct table read reconcile
exactly. Reads never touch the database on the serving path (zero added latency); durable
writes are serialized and run off-path — a DB outage logs and drops the metering write but
**never breaks the user's response**.

```bash
# Supabase (SSL required — configured automatically):
export DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/postgres"
export STORE_BACKEND=postgres         # optional; auto-selected when DATABASE_URL is set
npm start
```

**Migrations** live in [`migrations/`](migrations/) as idempotent `CREATE TABLE IF NOT EXISTS`
SQL and run **automatically on boot** (in filename order) — no separate migrate step, no ORM.
The schema is a single `records` table: typed columns for the fields we filter on
(`id, ts, tier, mode, model, session, cached`) plus the full record as `JSONB` and the
async `verification` as `JSONB`, ordered by a `BIGSERIAL` for append-order parity with JSONL.
Config: `DATABASE_URL`, `STORE_BACKEND`, `DATABASE_SSL` (default `true`), `DATABASE_POOL_MAX`
(default `5`).

## Resilience — the user's request path is sacred

Joule degrades gracefully: metering, verification, carbon lookups, embeddings and logging are all
**secondary** — if any of them fails, the user still gets their model response (or a clean,
OpenAI-shaped error). Nothing secondary can take down the primary path.

| Failure | What Joule does |
|---|---|
| **Provider timeout / 5xx / 429 / network** | Per-attempt timeout, then exponential-backoff retry (transient only — never other 4xx); optional `FALLBACK_MODEL`; else a clean OpenAI-shaped error. Reservation released, nothing metered. |
| **Provider stream breaks mid-response** | Records what was actually delivered, settles the reservation exactly once, ends the response cleanly. |
| **Database unreachable** | Proxy keeps serving from the in-memory mirror; failed metering writes **buffer and replay when the DB recovers**. Dashboard reads never hit the DB. Pool acquire + statement timeouts mean no hangs. |
| **Grid/carbon API down** | Labelled fallback intensity (marked estimated); request completes. |
| **Embeddings endpoint down** | Semantic layer skipped; falls back to exact/prefix cache or a normal call. |
| **Verification/judge call fails** | Logged, sample skipped; never touches the user response. |
| **Malformed / oversized body** | Clean `400` / `413`, never a crash. |

Every degraded path logs a structured warning. **`GET /api/health`** returns component status:

```jsonc
{ "ok": true, "components": {
    "db":       { "backend": "postgres", "status": "ok|degraded", "pendingWrites": 0 },
    "provider": { "status": "ok|degraded|dry_run", "consecutiveFailures": 0 },
    "grid":     { "status": "live|fallback", "source": "..." } } }
```

**Config:** `UPSTREAM_TIMEOUT_MS` (120000), `UPSTREAM_MAX_RETRIES` (2), `UPSTREAM_RETRY_BASE_MS`
(250), `UPSTREAM_RETRY_JITTER` (true), `FALLBACK_MODEL` (none); `DATABASE_CONNECT_TIMEOUT_MS`
(5000), `DATABASE_STATEMENT_TIMEOUT_MS` (8000), `DATABASE_MAX_BUFFERED_WRITES` (10000). Failures
are exercised by `test/upstream.test.js` + `test/resilience.test.js` with injected fakes (offline).

## Concurrency & load

Joule is proven correct under sustained parallel traffic — not just fast. A dependency-free
harness fires N concurrent clients (a mix of cache hits/misses, small- and large-routed prompts,
agent sessions, and a tight-budget burst) and then checks that the numbers still reconcile:

```bash
# terminal 1 — a DRY_RUN server (offline, deterministic, free)
BUDGET_ENFORCE=true MAX_CALLS_PER_SESSION=50 DRY_RUN=true node src/server.js
# terminal 2 — 100 concurrent clients, 3000 requests
LOAD_CONCURRENCY=100 LOAD_REQUESTS=3000 node scripts/loadtest.js http://localhost:3000
```

**Results (100 concurrent clients, 3000 requests, DRY_RUN — Joule's own overhead):**

| Throughput | p50 | p95 | p99 | errors | non-200 |
|---|---|---|---|---|---|
| **~1,780 req/s** | 50 ms | 74 ms | 119 ms | 0 | 0 |

Correctness under load (all pass): **conservation** (`routed_small + routed_large == total`, nothing
lost or double-counted), **reconciliation** (`/api/stats` == `/api/report` == store, byte-identical
after thousands of concurrent writes), **cache integrity** (concurrent identical requests hit the
cache without corruption), **budget integrity** (with a cap of K, exactly K succeed and the rest get
429 — never K+1), and **no leaked reservations**. These invariants are also protected in the suite by
`test/loadtest.test.js`. Config: `CACHE_MAX_ENTRIES` bounds the exact-cache so memory can't grow
unbounded.

## Caching — the risk-free savings lever (Layer 1)

Before routing (which carries quality risk), the cheapest savings come from **caching**, which
carries **zero quality risk** — the model recomputes nothing, so the output is byte-identical.
Joule surfaces this as a **separate savings line** from routing:

- **Exact-response cache** — identical normalized prompts return the stored completion (free).
- **Provider prefix caching passthrough** — `cache_control` / prompt-cache hints are forwarded
  to the upstream unmodified; Joule reads the provider's **real returned usage** (cached vs
  cache-creation input tokens, OpenAI *and* Anthropic shapes) and computes prefix-cache savings
  **net of the cache-write premium** (`CACHE_READ_MULTIPLIER` / `CACHE_WRITE_MULTIPLIER`).
- **Advisory** (`GET /api/advisory` + dashboard panel) — because Joule sees every request, it
  produces **quantified findings**: cache-hostile prompt structure (IDs/timestamps/UUIDs at the
  *front* bust the prefix) with an estimated **before→after hit rate and $ impact**, prompts below
  the provider's minimum cacheable length, and a **below-breakeven** warning (write premium > read
  savings). Estimates are labelled as estimates. `X-Joule-Latency-Tolerant: true` marks a sync
  request batch-eligible and credits the batch savings line.

Cache savings are kept on their own line in `/api/stats`, `/api/summary`, `/api/report` and the
dashboard, distinct from routing savings, so each lever is independently attributable.

### Batch processing (savings-hierarchy #2, zero quality risk)

For **latency-tolerant** work, `POST /v1/batch` processes many requests asynchronously at the
provider's **batch discount** (OpenAI/Anthropic ~50% off). Same model, same output — just async —
so it carries **zero quality risk**, and the discount is reported on its own line.

```bash
# submit a batch (returns a job id, 202)
curl http://localhost:3000/v1/batch -H "content-type: application/json" \
  -d '{"requests":[{"custom_id":"a","messages":[{"role":"user","content":"summarise …"}]}]}'
# poll for results
curl http://localhost:3000/v1/batch/<id>
```

Each item is still routed (small/large) and metered; batch savings appear separately in
`/api/stats`, `/api/report`, `/api/summary` and the dashboard. (The discount reflects provider
batch-API pricing — run against a batch-capable provider for it to be real; the DRY_RUN demo is
illustrative like all DRY_RUN numbers.)

### Layer 2 — semantic cache (opt-in, `SEMANTIC_CACHE_ENABLED=true`)

Semantic caching returns a *semantically similar* (not identical) prompt's answer. Unlike
prefix/exact caching it **can return a different question's answer — a genuine quality risk, not
risk-free** — and it fails **silently** (a wrong hit is a confident `200 OK`). So it is **off by
default** and heavily guarded; it's reported on its **own** line, always **beside its realised
error rate**.

- Runs **only on a Layer-1 miss** (hits never embed); embeddings are cached (no re-embed of identical prompts).
- **Per-entry learned thresholds** (vCache-style) + a hard `SEMANTIC_CACHE_MIN_SIMILARITY` floor
  below which it *never* serves, whatever the target rate.
- **Net of embedding spend**, on its own line, always shown **with the realised error rate**.

**Safety guardrails (the failure modes it's built to prevent):**
- **Tenant/scope isolation** — every entry is namespaced by **tenant + project + user tier + model +
  system-prompt hash + version** (`X-Joule-Tenant` / `X-Joule-Project` / `X-Joule-User-Tier`
  headers). A lookup can *only* match inside the same namespace — **tenant A can never receive
  tenant B's answer** (a data-breach-class event this prevents).
- **Sensitive-query bypass** — prompts matching `SEMANTIC_CACHE_BYPASS_PATTERNS` (financial /
  medical / legal / secret defaults) or carrying `X-Joule-Cache-Bypass: true` **skip the semantic
  layer entirely** and hit the model (prefix cache may still apply). Bypasses are counted.
- **Staleness** — per-entry TTL (`SEMANTIC_CACHE_TTL`, ~24h; never served past it) + **version-tagged
  keys** (`SOURCE_VERSION` bump invalidates everything). Hits expose their `as_of`.
- **PII** — responses/prompts carrying personal data are **never cached** (the same redaction signal).
- **Adversarial hardening** — inputs are sanitised (control chars stripped, oversized rejected) before embedding.
- **Measured, not assumed** — a sample of hits is verified; if the realised error rate exceeds
  `SEMANTIC_CACHE_TARGET_ERROR` it **auto-tightens**, and if it stays above
  `SEMANTIC_CACHE_DISABLE_ERROR_RATE` it **auto-DISABLES the layer and alerts**, falling back to
  exact/prefix. `realisedErrorRate: null` means *not yet measured on this traffic* — no safe claim is made.

**Honesty:** cache savings are never shown without the incorrect-hit rate beside them; and the
default posture is **exact/prefix ON, semantic OFF** until it's explicitly enabled *and* a realised
error rate has been measured on the tenant's own traffic. Prefix/exact caching is unaffected — it
recomputes freshly and is safe.

## OpenTelemetry / Prometheus interop

Joule plugs into existing observability stacks without pulling in the OpenTelemetry SDK
(minimal-deps rule):

- **`GET /metrics`** — always on, dependency-free **Prometheus** exposition derived from the real
  log: `joule_requests_total{model,tier}`, `joule_tokens_total`, `joule_cost_usd_total`,
  `joule_energy_wh_total`, `joule_co2_grams_total`, `joule_cost_saved_usd_total`,
  `joule_cache_saved_usd_total`, `joule_quality_score`, `joule_budget_rejected_total`.
- **OTLP span export** (opt-in: `OTEL_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT`) — each request
  emits an OTLP/HTTP JSON span following the **GenAI semantic conventions**
  (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens/output_tokens`, …) plus our
  differentiating `joule.*` attributes (tier, cost, energy, carbon, quality score, conformal alpha,
  cache hit, reasoning tokens). **Agent sessions** (`X-Joule-Session`) share a trace id and nest
  under a per-session **parent span** (agent run → child call spans). POSTed to your collector off
  the serving path; no endpoint → no-op. Point it at **Datadog / Grafana Tempo / Honeycomb / any
  OTLP `/v1/traces` backend** — it's standard OTLP JSON, so **no OpenTelemetry SDK dependency** is
  required. (The `gen_ai.*` standard covers tokens/cost/latency but not quality — that evaluation
  layer stays ours, under `joule.*`.)

## Brand

The dashboard uses the Joule identity on the existing dark petrol theme. Drop these files in
`public/` to activate the logo (the header falls back gracefully to `logo-mark.png` then the inline
SVG bolt if they're absent): `logo.png` (full lockup), `logo-mark.png` (bolt mark / apple-touch),
`favicon.png` (32×32). Brand tokens (in `public/index.html`): primary accent **cyan `#33E3C7`**;
secondary accent **brand blue `--brand-blue #2D87AE`**, used sparingly (secondary/report buttons,
link hovers, footer) — the UI is not repainted blue. Page title: *Joule — AI cost & carbon control plane*.

## Reasoning-budget control (2026's biggest routing-tier lever)

Reasoning models (o-series, DeepSeek-R1, extended-thinking Claude, Gemini thinking) emit **5–50×
more tokens** per query, and accuracy plateaus past a certain depth — so **capping the thinking
budget** usually preserves quality while cutting cost sharply.

- **Detection + capped budget** — a config-driven table maps model-name patterns to their
  thinking-budget param (OpenAI `reasoning_effort`, Anthropic `budget_tokens`, Gemini
  `thinking_budget`, open models `max_thinking_tokens`). Joule picks a **complexity-aware** effort
  (simple prompts think less), bounded by `REASONING_MAX_THINKING_TOKENS`, and injects it upstream.
  Per-request override: `X-Joule-Reasoning-Effort: low|medium|high`.
- **Reasoning → standard downgrade** (opt-in, `REASONING_DOWNGRADE_ENABLED`) — for prompts the
  classifier deems simple, route off the reasoning model entirely. This is a **quality-risk**
  decision, so it rides the **same conformal verification path** as tier routing.
- **Separate metering** — thinking tokens are counted on their own line (they bill as output and
  **count toward the decode-weighted energy model** — never treated as free). Savings from capping
  and downgrades are labelled **estimates** (we don't run the uncapped variant). Surfaced in
  `/api/stats`, `/api/report`, `/api/summary` and the dashboard.

## Budget enforcement (metering reports; enforcement prevents)

Dashboards tell you what you *already* spent. For unattended agents that's too late — a runaway
loop can burn the month's budget before anyone looks. Joule can **prevent** overspend: before any
model call, a request's cost is estimated and **reserved** against hierarchical budgets, then
reconciled to the actual cost afterwards.

- **Hierarchical caps** — `BUDGET_GLOBAL_USD`, `BUDGET_DAILY_USD`, `BUDGET_SESSION_USD`
  (per-`X-Joule-Session` **agent-run cap**), `MAX_CALLS_PER_SESSION`, plus optional named budgets
  (`BUDGET_DEFS`, scope/limit/`action: warn|throttle|block`). A per-request hard cap: `X-Joule-Max-Cost`.
- **Reservation before the call** — if a *block* cap would be exceeded, the request is **rejected
  with HTTP 429** and a machine-readable body (`{scope, limit, spent, wouldBe, resetAt}`) — **no
  model is called**. A session that breaches a block cap (cost or call count) is **terminated** —
  its later calls are rejected immediately, while **other sessions continue unaffected** (isolation).
- **Safe default: metering-only** — `BUDGET_ENFORCE=false` (default) blocks nothing; would-be
  breaches are counted (`wouldReject`). Committed spend is seeded from the log (survives restarts).
- **Fail-open by default** — `BUDGET_FAIL_MODE=fail_open`: if the budget engine errors it allows
  traffic and logs loudly, so a store hiccup never takes down production; `fail_closed` rejects.

Surfaced in `/api/stats`, **`GET /api/budgets`** (definitions, spend, remaining, terminated sessions,
event audit trail), `/api/report`, and a dashboard **Budget** panel (caps, used/remaining,
blocked counts, terminated sessions).

## ROI since day one

`GET /api/roi` and the dashboard's **ROI** card show savings as a compounding investment, not a
monthly cost: a cumulative savings-over-time chart (hand-rolled SVG, no chart library), a lifetime
headline (*"you've saved $X and Y kg CO₂ since <date>"*), and an honest **net-of-fees** line —
gross savings − verification overhead − subscription (`SUBSCRIPTION_COST_MONTHLY`), with average
monthly saving and payback. All figures come from real logged daily rollups that reconcile exactly
with `/api/summary`; with no history it shows an empty state, never a projection dressed as fact.

## Deployment modes & data residency

Every major AI gateway is foreign-hosted. Under UAE PDPL, regulated data generally cannot be
processed abroad without a lawful basis — so **self-hosting Joule in-country is a structural
advantage**. Joule makes the data-handling posture explicit rather than hiding it.

- **Deployment mode** — `DEPLOYMENT_MODE=cloud|self_hosted`, `DATA_REGION` (where Joule runs),
  `PROVIDER_REGION` (where the upstream model lives). `/api/stats` and the dashboard show a
  banner; when the regions differ it **warns plainly**: *"prompts leave `<DATA_REGION>` to reach
  the model provider"* — the exact fact a compliance officer needs.
- **Retention off by default** — `LOG_PROMPTS=false` (default) persists **only metadata** (tokens,
  model, tier, cost, energy, carbon, scores) — never prompt or response text. `PII_REDACT=true`
  additionally strips emails / phone numbers / long digit runs before anything is logged.
- **Self-host / air-gapped** — `docker compose up --build` runs Joule entirely on your
  infrastructure; the **only** outbound call is to the model provider you configure. Point
  `UPSTREAM_BASE_URL` at an in-region or on-prem model server (e.g. vLLM/Ollama) for a fully
  in-country or air-gapped deployment.
- **Compliance summary in the report** — `/api/report` includes a `deployment` block (mode, data
  region, provider region, whether prompt text was retained, redaction on/off) so the export is
  something a risk officer can file.

```bash
docker compose up --build        # → http://localhost:3000 (DRY_RUN, self_hosted, metadata-only)
```

> **We describe residency; we do not certify legal compliance.** Whether a given configuration
> satisfies PDPL (or any regime) is a determination for your counsel — Joule gives you the
> controls and the paper trail, not a legal guarantee.

## Deploy to Render (free tier, live URL)

The repo ships a [`render.yaml`](render.yaml) Blueprint — one free web service that
boots in `DRY_RUN`, so the URL is **live and demoable the moment it deploys**, no keys.

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, connect the repo. It reads `render.yaml` and creates
   the `joule-mvp` service (`npm install` → `npm start`, health check `/api/health`).
3. Deploy. Open the service URL — the dashboard is live in `DRY_RUN`.
4. **Seed a demo:** `DEMO_TARGET=https://<your-service>.onrender.com npm run demo`
   fires ~30 varied prompts so the dashboard shows accumulated savings — screenshot it
   **while warm** (free instances spin down when idle; the first request after wakes it,
   ~30–60s cold start).
5. **Go live (real calls):** in the Render dashboard set `UPSTREAM_API_KEY` (and optionally
   `ELECTRICITYMAPS_TOKEN` for live grid carbon), flip `DRY_RUN=false`, redeploy.

Secrets are declared `sync: false` in the Blueprint — you set them in the dashboard, never
in the repo. `.env` is git-ignored.

> **Free-tier caveats.** The instance **spins down after ~15 min idle** (slow first request
> after) and the local disk is **ephemeral** — on the `memory` backend `data/log.jsonl` resets
> on every deploy/restart. For durable totals set `DATABASE_URL` (Supabase/RDS/local Postgres):
> the store switches to the `postgres` backend automatically and data survives restarts. See
> [Persistence — Postgres with a memory fallback](#persistence--postgres-with-a-memory-fallback).

### Other hosts / Docker

A [`Dockerfile`](Dockerfile) (`node:22-slim`) is included for Fly.io / a VM / any OCI host:
`docker build -t joule . && docker run -p 3000:3000 -e DRY_RUN=true joule`. The server binds
`process.env.PORT` (default 3000) on all interfaces — nothing is hardcoded.

## How routing works

`src/router.js` scores each prompt (greeting/lookup vs. reasoning/code/length) and picks **small** or **large**. Transparent and cheap by design; swap in a fine-tuned classifier later without touching the rest.

## Roadmap (beyond this MVP)

- Semantic (embedding) cache instead of normalized-exact
- Per-model **measured** energy profiles to replace estimates
- Scope 2/3 + SCI export templates auditors accept out of the box
- Multi-tenant keys, dashboards per project, and grid-aware scheduling

## Project layout

```
src/
  server.js    proxy + API + static
  router.js    complexity classifier + tier selection
  metrics.js   cost / energy / carbon + baseline savings
  carbon.js    Electricity Maps client + fallback
  config.js    ALL tunables (pricing, energy factors, models, zone)
  store.js     append-only request log + aggregation + CSV
public/
  index.html   live console
```

MIT licensed. Built as the MVP for a Hub71+ AI application.
