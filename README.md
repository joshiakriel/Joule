# Joule — carbon & cost meter for AI inference

A drop-in, **OpenAI-compatible proxy** that sits in front of your model calls and, for every request:

1. **Meters** it — real token usage → cost (USD), energy (Wh), carbon (gCO₂)
2. **Routes** it — sends simple prompts to a smaller, cheaper, lower-carbon model
3. **Records** it — an auditable log you can export as a cost & emissions report

It's the working core of the Joule concept: *measure, optimize, and prove the cost and carbon of AI.*

> **Honesty about the numbers.** Token counts and **cost are exact** (from the provider's returned usage × your configured prices). **Energy per inference is an estimate** — no provider exposes measured watt-hours — using a transparent, configurable model anchored to public research (IEA *Energy & AI* 2025; Epoch AI). **Carbon is energy × live grid intensity** from [Electricity Maps](https://www.electricitymaps.com/), aligned to GHG Protocol Scope 2 (location-based) and the SCI standard (ISO/IEC 21031). This mixed measured/estimated approach is exactly how real carbon-accounting tools work — and it's all in `src/config.js` for you to refine.

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
| `POST /v1/chat/completions` | OpenAI-compatible proxy (routes + meters). Optional `X-Joule-Session` header groups a run. |
| `GET /api/stats` | Instance config, grid + all-time totals (dashboard pills) |
| `GET /api/summary?range=&tier=&mode=&q=` | Filtered aggregates + time-series + per-model + sessions, all from the real log |
| `GET /api/report?format=json\|csv&range=&tier=&mode=&q=` | Downloadable audit-style report — honours the same filters |
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
