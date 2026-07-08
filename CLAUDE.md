# CLAUDE.md — Joule MVP (project memory & handoff log)

> This file is auto-loaded by Claude Code every session. It is the handoff brief
> from the previous agent. Read `README.md` for user-facing run instructions;
> this file is the behavioral contract + current state. Keep it under ~200 lines.

## What this is
Joule is positioned as **the measurement & compliance control plane for sovereign AI**
(built for a Hub71+ AI accelerator application, Abu Dhabi). The product thesis:
*measure, optimize, and prove the cost and carbon of AI inference.* Routing to a
cheaper model is **one module, not the product** — the strategic wedge is
**measurement + audit-ready carbon/cost compliance** for Gulf government/regulated buyers.

This repo is the **working MVP**: a drop-in, OpenAI-compatible proxy that meters every
request (cost/energy/carbon), routes simple prompts to a smaller model, and exports an
audit-style report. Single founder (Joshia Kriel). Non-coding/business work happens
elsewhere — this repo is code only.

**Primary target: automated / agent workloads** (script-driven, unattended pipelines), not
human-typed prompts — that's where LLM cost and carbon run away. Joule meters on the API call,
so it captures any client identically; `examples/agent-workload.js` demonstrates this.

## Status — verified working (2026-07-03)
Built and smoke-tested end-to-end in `DRY_RUN` mode:
- 6 mixed prompts → **4 routed small / 2 large** (classifier correct), **1 cache hit**.
- Aggregated **~64% energy saved** vs. an always-large baseline; cost/CO₂ savings tracked.
- `GET /api/report` returns JSON + CSV with a methodology block (GHG Scope 2 + SCI).
- Grid intensity falls back to a labelled constant when `ELECTRICITYMAPS_TOKEN` is unset.

Not yet done: streaming, tests, real classifier, persistent DB, auth. See "Next steps".

## Run / test
```bash
npm install
cp .env.example .env      # DRY_RUN=true by default — full pipeline, no external calls, no cost
npm start                 # dashboard: http://localhost:3000 ; proxy: http://localhost:3000/v1
```
Go live: set `DRY_RUN=false`, add `UPSTREAM_API_KEY` (+ optional `ELECTRICITYMAPS_TOKEN`).
**Always use `DRY_RUN=true` for automated tests** — CI/sandboxes may have no provider or
Electricity Maps network access; `carbon.js` degrades gracefully. Start→test→teardown in a
single shell invocation to avoid orphaned background servers.

## Architecture (all under `src/`, CommonJS)
- `config.js`  — ALL tunables from env: models, pricing table, energy factors, grid zone, flags. `priceFor(model,tier)`. **Runtime-override layer:** overridable fields (models, keys, baseUrl, gridZone, routing, dryRun) are live getters resolving `override ?? env ?? default`, so all request handling reads the *current* value while env stays the fallback. `setOverrides()`/`clearOverrides()`/`sourceOf()`/`isSecret()` back `/api/config`; overrides are in-memory only. Secret getters are non-enumerable (can't leak via `JSON.stringify`).
- `router.js`  — `classify(text)` heuristic (regex signals + length) → `{tier, score, signals, confidence}`; `selectModel`, `tierForModel`.
- `carbon.js`  — `getIntensity()` → live Electricity Maps gCO₂/kWh with 10-min cache and labelled fallback.
- `metrics.js` — `compute({...})` → `{actual, baseline, saved, totalTokens}`. Cost exact; energy estimated; carbon = energy×intensity.
- `store.js`   — append-only JSONL log (`data/log.jsonl`) + in-memory mirror, and the ONE shared filter/aggregation implementation used by the server and tests. `predicateFor({range,tier,mode,q},now)` builds a record predicate; `aggregate(pred)`, `perModel(pred)`, `series(pred,{from,to,buckets})`, `sessions(pred)`, `toCsv(pred)` all take that predicate. `summary(filter,now)` bundles totals+series+perModel+sessions+recent. `clear()` truly empties (memory + disk). Sessions group by the record's `session` (from `X-Joule-Session`), else 15-min time-gap buckets.
- `server.js`  — Express: `POST /v1/chat/completions` (routes+meters+logs; reads optional `X-Joule-Session`; streams SSE when `stream:true` via `handleStreaming`), `GET /api/stats`, `GET /api/summary` (filtered aggregates+series+perModel+sessions), `GET /api/report` (honours filters), `POST /api/clear`, `GET`+`POST /api/config` (masked runtime config), `GET /api/health`, serves `public/`. `parseFilter()` validates the shared `range/tier/mode/q` query; `scrub()` strips secrets from error messages.
- `public/index.html` — live dashboard (vanilla JS): architecture strip + copy-ready `/v1` snippet, filter toolbar (range/tier/mode/model-search + clear-data), overview KPIs/meters, activity time-series chart, sessions table, per-model breakdown, filtered log with relative timestamps, "Configure your instance" panel. Renders `/api/summary` (filtered) + `/api/stats` (pills); exports carry the active filter.
- `test/` — `node:test` suite (`router`, `metrics`, `store`, `integration`, `config`). Runs offline in DRY_RUN via `npm test`. `store` tests cover the filter/aggregate/perModel/series/sessions/clear logic; `integration` covers `/api/summary`, session grouping, filtered export, and `/api/clear`. Integration mounts `app` on an ephemeral port and uses `store.init(tmpDir)`/`store.clear()` for isolation. Testability hooks: `server.js` exports `app` and only auto-listens when run directly; `store.init(dir)` accepts an optional data dir (default unchanged).
- `scripts/demo.js` — dependency-free seed script (`npm run demo`); fires ~30 varied prompts (trivial/format/reason/code + repeats for cache) at `argv[2]`/`DEMO_TARGET` (default localhost) via global `fetch`, prints a small/large/cached summary. Deploy tooling: `render.yaml` (Blueprint), `Dockerfile` + `.dockerignore`, `.node-version` (22).
- `examples/agent-workload.js` — dependency-free (`npm run example:agent`); simulates an unattended support-triage agent that makes ~20 autonomous chained calls (classify→small, summarize→small, high-priority deep analysis→large) through Joule's `/v1`, then prints a screenshot-ready cost/energy/carbon summary computed as before/after `/api/stats` deltas (so it matches the server). Tags every call with an `X-Joule-Session` header so the whole run shows up as one labelled session, and prints that session line back from `/api/summary`. Proves Joule meters scripted/agent traffic, not just the dashboard's test box.

## Data contracts (do not break silently)
- **Proxy request/response**: OpenAI Chat Completions shape. Clients set only `baseURL=…/v1`.
- **Metrics on response headers**: `x-joule-mode|tier|model|cost-usd|energy-wh|co2-g|saved-usd|saved-co2-g`.
- **Log record**: `{ts, mode('live'|'dry_run'|'cache'), cached, model, tier, signals, confidence,
  promptTokens, completionTokens, totalTokens, actual{costUsd,energyWh,carbonG}, baseline{…}, saved{…}, grid{gPerKwh,zone,source,live}, latencyMs, session(string|null)}`.
- **/api/stats**: `{config, grid, totals{requests,cacheHits,routedSmall,routedLarge,tokens,cost,energyWh,carbonG,savedPct}, recent[]}` (all-time; drives the pills).
- **GET /api/summary?range=&tier=&mode=&q=**: `{filter, window{from,to}, totals(same shape as stats.totals), series[{t,calls,energyActual,energyBaseline,carbonActual,costActual}], perModel[{model,tier,calls,tokens,cost,energyWh,carbonG,avgLatencyMs}], sessions[{id,label,tagged,from,to,durationMs,calls,small,large,cached,tokens,cost,energyWh,carbonG,savedPct}], recent[]}` — all filtered, all from the real log. Filters: `range∈{1h,24h,7d,all}`, `tier∈{small,large}`, `mode∈{live,dry_run,cache}`, `q`=model substring.
- **GET /api/report** accepts the same filters (JSON+CSV; CSV gains a trailing `session` column). **POST /api/clear** → `{cleared,removed}` (destructive).
- **GET /api/config** (masked, secret-free): `{dryRun, routingEnabled, modelSmall, modelLarge, upstreamBaseUrl, gridZone, hasUpstreamKey, upstreamKeyLast4, hasEmToken, sources{field→"env"|"runtime"|"default"}}`. Never returns raw secrets.
- **POST /api/config**: JSON partial, whitelist ONLY `{upstreamApiKey, upstreamBaseUrl, modelSmall, modelLarge, emToken, gridZone, routingEnabled, dryRun}`; unknown fields → 400; validates `gridZone` (short alnum/hyphen) + `upstreamBaseUrl` (http/https); applies in-memory overrides; invalidates carbon cache when `gridZone`/`emToken` change; returns the masked view.

## Immutable rules (these are load-bearing — don't regress them)
1. **Keep the OpenAI-compatible contract** on `/v1/chat/completions`. Drop-in is the whole point.
2. **Keep the numbers honest.** Cost is exact (token usage × configured price). Energy is an
   ESTIMATE (no provider exposes Wh) — always labelled as such. Carbon = energy × grid intensity.
   Never present estimates as measured. Keep the `methodology` block in `/api/report`.
3. **Config-driven, not hardcoded.** New knobs go in `config.js` + `.env.example`.
4. **Minimal deps.** CommonJS, Node ≥18 (global `fetch`). Only `express` + `dotenv`. 2-space indent.
   Don't add a framework/DB/build step without a clear reason.
5. **Never commit** `.env`, real keys, or `data/` (already in `.gitignore`).
6. **Routing is one module.** Don't let the router balloon into "the product" — measurement +
   compliance is the moat. Invest there.
7. **Never log or return raw secrets; mask everywhere.** API key / EM token live in memory only —
   never written to `data/` or any file, never logged, never in any endpoint response. Expose only
   booleans + last-4 (`/api/config`). `scrub()` in `server.js` strips secrets from error messages.
   Runtime config overrides (`config.setOverrides`) are in-memory only, never persisted.

## Known limitations / tech debt
- **Streaming metrics ride the store, not headers.** `stream:true` requests get a real SSE stream and are still routed/metered/logged (visible in `/api/stats` + `/api/report`), but the `x-joule-*` response headers are NOT set — headers flush before token usage is known. Non-streaming still returns headers.
- **Classifier is a heuristic** (regex + length). Fine for a demo; not robust. No eval set yet.
- **Cache is normalized-exact** (lowercased/trimmed string match), not semantic/embedding-based.
- **Store is single-node JSONL**; ephemeral on serverless. Interface is tiny — swap for Postgres.
- **Render free tier is ephemeral + sleeps.** The disk resets on every deploy/restart (`data/log.jsonl` is not durable — re-run `npm run demo` to repopulate), and the instance spins down after ~15 min idle (first request after cold-starts, ~30–60s). Fine for a demo URL; not for durable metrics.
- **No auth / multi-tenant**, no per-project separation.
- **Runtime key entry via `/api/config` is a SINGLE-TENANT demo convenience.** Overrides live in one shared in-memory bag with no auth — anyone who can reach the instance can set them. Multi-tenant production needs auth + encrypted per-user secret storage (not in-memory globals).
- **Energy factors are per-tier**, not per-model or measured.
- Only `/chat/completions` is proxied (no `/models`, `/embeddings`, etc.).
- **LLM-only scope.** Joule meters LLM / generative-AI inference calls (OpenAI-compatible `/chat/completions`). It does NOT capture non-LLM operational ML (forecasting/recommendation/optimization models that never hit an LLM API) — that boundary is the API call. Keep this accurate in positioning.

## Next steps (prioritized feature checklist)
- [x] **Streaming (SSE) passthrough** while still metering from `usage` (or estimating on stream end). Live mode adds `stream_options:{include_usage:true}` and pipes chunks unmodified; dry-run synthesizes an SSE stream. Metrics land in the store (not `x-joule-*` headers) — see Known limitations.
- [x] **Unit + integration tests** (router, metrics, store, proxy) — `node --test` in `test/`, all offline in DRY_RUN. Run with `npm test`.
- [x] **Deploy-prep** — `render.yaml` Blueprint (free tier, boots in DRY_RUN so the URL is instantly live), `Dockerfile` (`node:22-slim`) for other hosts, `.node-version` (22), and `scripts/demo.js` (`npm run demo`) to seed the dashboard for a screenshot. See README "Deploy to Render"; ephemeral-disk + spin-down caveats in Known limitations.
- [x] **UI polish + runtime config** — dashboard reads as an intermediary (architecture strip + copy-ready `/v1` snippet) and is configurable from the UI (keys/models/grid region via `GET`/`POST /api/config`, masked secrets, per-field source). In-memory override layer keeps env as the fallback. Single-tenant demo convenience (see Known limitations).
- [x] **Dashboard analytics on the real log** — `/api/summary` powers time-range + tier/mode/model filters, a bucketed activity chart, per-model/per-tier breakdown, and **sessions** (an `X-Joule-Session`-tagged agent run = one labelled session; else time-gap buckets). Filtered CSV/JSON export, relative timestamps, snippet copy, and a real "clear data" (`POST /api/clear`). All from real records; agent example sends the session header.
- [ ] **Real classifier** (small fine-tuned / embedding model) + a labelled eval set; keep the interface.
- [ ] **Semantic cache** (embeddings) replacing normalized-exact.
- [ ] **Persistent store** (Postgres) behind `store.js`; keep JSONL for local dev.
- [ ] **Per-model measured energy profiles**; move energy config from per-tier to per-model.
- [ ] **Auth + API keys + per-project dashboards**.
- [ ] **Scope 2/3 + SCI export templates** an auditor accepts out-of-the-box (the compliance wedge).
- [ ] **Quality guardrail**: verify the small-model answer clears a bar; escalate to large on low confidence.
- [ ] **Grid-aware scheduling** module: defer batch/deferrable jobs to low-intensity windows.

## Gotchas
- Cache populates for **all non-cache modes** (dry_run + live), not just live — see `server.js`.
- `carbon.js` caches intensity ~10 min and **always returns a value** (fallback labelled in `grid.source`).
- Savings = baseline (same tokens, always-large) − actual. A prompt correctly routed to `large` shows ~0 saved — that's expected, not a bug.
- Dashboard reads metrics off response **headers** (same-origin fetch), and aggregates via `/api/stats` polling.
