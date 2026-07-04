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

## Endpoints

| Route | Purpose |
|---|---|
| `POST /v1/chat/completions` | OpenAI-compatible proxy (routes + meters) |
| `GET /api/stats` | Live totals + recent log (the dashboard uses this) |
| `GET /api/report?format=json\|csv` | Downloadable audit-style cost & emissions report |
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
