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
  distribution shift can violate it — every claim reports **n and α**.
- **Never a fake number.** Below `MIN_CALIBRATION_N` (default `50`) the UI/API show *"insufficient
  data for a guarantee"* and fall back; with zero samples, *"not yet verified"*.
- Verification is **sampled, not exhaustive**, and the **judge is a fallible model** (even in a panel).
- Verification **costs real tokens** — reported **net savings = routing savings − verification
  overhead** is the headline (positive at the 10% default; honestly negative at 100%).

**Config (env):** `VERIFICATION_MODE` (`conformal`|`judge`, default conformal), `VERIFY_SAMPLE_RATE`
(0.1), `TARGET_RISK_ALPHA` (0.05), `MIN_CALIBRATION_N` (50), `CALIBRATION_REFIT_EVERY` (200),
`JUDGE_MODELS` (csv, default = large model), `JUDGE_ACCEPT_THRESHOLD` (0.6),
`JUDGE_AGREEMENT_THRESHOLD` (0.67), `DRIFT_K` (3), `DRIFT_MIN_N` (30); plus the v1 fallback knobs
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

Uses Node's built-in test runner (`node:test`) — no extra dependencies. Coverage: the
router (classification/tiering), metrics (exact cost, estimated energy, carbon, savings),
the store (aggregation + CSV), and an in-process integration pass over the proxy
(non-streaming headers + JSON, streaming SSE, `/api/stats` + `/api/report`, caching,
routing). Tests run in `DRY_RUN` against an isolated temp data dir, so they never touch
`data/log.jsonl`.

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
> after) and the disk is **ephemeral** — `data/log.jsonl` resets on every deploy/restart, so
> accumulated totals are not durable. Fine for a demo; for production point `src/store.js` at
> Postgres/ClickHouse (the interface is tiny and documented in the file) and re-run the demo.

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
