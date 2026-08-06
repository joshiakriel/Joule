"use strict";
const config = require("./config");

/**
 * Budget enforcement — the economic firewall. Metering REPORTS; this PREVENTS.
 *
 * Before the model is called, a request's cost is estimated and RESERVED against
 * hierarchical budgets (global, per-day, per-session/agent-run, and optional named
 * budgets by scope/key). If a BLOCK budget would be exceeded and enforcement is on,
 * `reserve()` returns ok:false and the caller rejects with HTTP 429 + a machine-
 * readable body. A session that breaches a block cap (cost OR call count) is
 * TERMINATED — its later calls are rejected immediately while OTHER sessions are
 * unaffected (isolation). `commit()` reconciles to the actual cost afterwards.
 *
 * Actions: block (reject) | warn | throttle (both allow + record an event).
 * Fail mode: fail_open (default) allows traffic and logs loudly if the engine errors;
 * fail_closed rejects. All state is in-process (seeded from the log) — negligible latency.
 */

const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
const opts = () => config.budget;

let committed, reserved, sessionCalls, reservedCalls, terminated, events, seq, rejected, wouldReject;
function reset() {
  committed = { global: 0, byDay: new Map(), bySession: new Map(), byKey: new Map() };
  reserved = { global: 0, byDay: new Map(), bySession: new Map(), byKey: new Map() };
  sessionCalls = new Map();
  reservedCalls = new Map();  // IN-FLIGHT call count per session (reserved, not yet committed)
  terminated = new Map();   // sessionId -> { reason, at }
  events = [];              // audit trail: { ts, action, scope, key, limit, spent, sessionId }
  seq = 0; rejected = 0; wouldReject = 0;
}
reset();

const bump = (map, key, delta) => { if (key == null) return; map.set(key, (map.get(key) || 0) + delta); };
const record = (e) => { events.push({ ts: new Date().toISOString(), ...e }); if (events.length > 500) events.shift(); };

// Seed committed spend + call counts from existing store records.
function init(records) {
  reset();
  for (const r of records || []) commitRaw(r.actual?.costUsd || 0, r.session, new Date(r.ts).getTime(), true);
}
function commitRaw(cost, sessionId, ts, seeding) {
  const day = dayKey(ts || Date.now());
  committed.global += cost; bump(committed.byDay, day, cost); bump(committed.bySession, sessionId || null, cost);
  if (sessionId) sessionCalls.set(sessionId, (sessionCalls.get(sessionId) || 0) + 1);
}

const usedGlobal = () => committed.global + reserved.global;
const usedDay = (d) => (committed.byDay.get(d) || 0) + (reserved.byDay.get(d) || 0);
const usedSession = (s) => (committed.bySession.get(s) || 0) + (reserved.bySession.get(s) || 0);

// The concrete budgets that apply to this request (config-derived + named defs).
function applicable(ctx, day) {
  const o = opts(); const b = [];
  if (o.globalUsd > 0) b.push({ id: "global", scope: "global", limit: o.globalUsd, spent: usedGlobal(), action: "block", window: "lifetime" });
  if (o.dailyUsd > 0) b.push({ id: "daily", scope: "day", limit: o.dailyUsd, spent: usedDay(day), action: "block", window: "day", resetAt: day + "T24:00:00Z" });
  if (o.sessionUsd > 0 && ctx.sessionId) b.push({ id: "session", scope: "session", key: ctx.sessionId, limit: o.sessionUsd, spent: usedSession(ctx.sessionId), action: "block", window: "session" });
  for (const d of o.defs || []) {
    if (d.scope === "global") b.push({ ...d, spent: usedGlobal(), action: d.action || "block" });
    else if (d.scope === "session" && ctx.sessionId && (!d.key || d.key === ctx.sessionId)) b.push({ ...d, key: ctx.sessionId, spent: usedSession(ctx.sessionId), action: d.action || "block" });
  }
  return b;
}

function reject(detail) { rejected++; record({ action: "block", ...detail }); return { ok: false, status: 429, message: `budget exceeded: ${detail.scope} cap $${detail.limit} (spent $${detail.spent.toFixed(6)})`, detail }; }

// Reserve an estimated cost. ctx: { sessionId, project?, key? }. Returns { ok, id?, ... }.
function reserve({ sessionId, estCostUsd, maxCostUsd, now = Date.now() }) {
  const o = opts();
  try {
    const ctx = { sessionId: sessionId || null };
    const day = dayKey(now);
    let flagged = false;

    // already-terminated session -> reject immediately (isolation: only this session)
    if (o.enforce && sessionId && terminated.has(sessionId)) {
      return reject({ scope: "session", key: sessionId, limit: o.sessionUsd, spent: usedSession(sessionId), reason: "session terminated", terminated: terminated.get(sessionId) });
    }
    // per-request hard cap
    if (Number.isFinite(maxCostUsd) && estCostUsd > maxCostUsd) {
      if (o.enforce) return reject({ scope: "request", limit: maxCostUsd, spent: 0, wouldBe: estCostUsd });
      flagged = true; wouldReject++;
    }
    // per-session call cap (block) -> terminate on breach. COUNT IN-FLIGHT RESERVATIONS,
    // not just committed calls: under concurrency many requests reserve before any commits,
    // so counting committed-only would admit K+N. reservedCalls is bumped atomically below.
    const callsInUse = (sessionCalls.get(sessionId) || 0) + (reservedCalls.get(sessionId) || 0);
    if (o.maxCallsPerSession > 0 && sessionId && callsInUse >= o.maxCallsPerSession) {
      if (o.enforce) { terminated.set(sessionId, { reason: "max calls per session", at: new Date().toISOString() }); return reject({ scope: "session-calls", key: sessionId, limit: o.maxCallsPerSession, spent: callsInUse, reason: "max calls per session" }); }
      flagged = true; wouldReject++;
    }
    // cost budgets
    for (const bud of applicable(ctx, day)) {
      if (bud.spent + estCostUsd > bud.limit) {
        if (bud.action === "block") {
          if (o.enforce) {
            if (bud.scope === "session" && sessionId) terminated.set(sessionId, { reason: `${bud.id} cost cap`, at: new Date().toISOString() });
            return reject({ scope: bud.scope, key: bud.key, limit: bud.limit, spent: bud.spent, wouldBe: bud.spent + estCostUsd, budgetId: bud.id, window: bud.window, resetAt: bud.resetAt || null });
          }
          flagged = true; wouldReject++;
        } else { record({ action: bud.action, scope: bud.scope, key: bud.key, limit: bud.limit, spent: bud.spent, budgetId: bud.id }); } // warn/throttle: allow
      }
    }
    // apply reservation (cost + in-flight call count) — atomic (synchronous)
    reserved.global += estCostUsd; bump(reserved.byDay, day, estCostUsd); bump(reserved.bySession, sessionId || null, estCostUsd);
    if (sessionId) bump(reservedCalls, sessionId, 1);
    return { ok: true, id: "rv-" + (seq++), est: estCostUsd, day, sessionId: sessionId || null, wouldReject: flagged };
  } catch (err) {
    // engine error: fail_open allows (log loudly), fail_closed rejects
    if (o.failMode === "fail_closed") { rejected++; return { ok: false, status: 429, message: "budget engine error (fail-closed)", detail: { scope: "engine", error: String(err.message) } }; }
    console.error("[budget] engine error — FAILING OPEN (allowing traffic):", err.message);
    return { ok: true, id: "rv-open-" + (seq++), est: estCostUsd, day: dayKey(now), sessionId: sessionId || null, failedOpen: true };
  }
}

function dropReservation(rv) {
  reserved.global -= rv.est; bump(reserved.byDay, rv.day, -rv.est); bump(reserved.bySession, rv.sessionId, -rv.est);
  if (rv.sessionId) { bump(reservedCalls, rv.sessionId, -1); if ((reservedCalls.get(rv.sessionId) || 0) <= 0) reservedCalls.delete(rv.sessionId); }
}
function commit(rv, actualCostUsd) {
  if (!rv || !rv.id) return;
  if (!rv.failedOpen) dropReservation(rv);   // frees the in-flight cost + call slot...
  commitRaw(actualCostUsd || 0, rv.sessionId, Date.parse(rv.day)); // ...then records it as committed
}
function release(rv) { if (rv && rv.id && !rv.failedOpen) dropReservation(rv); }

function stats(now = Date.now()) {
  const o = opts(); const day = dayKey(now);
  return {
    enforce: o.enforce, failMode: o.failMode,
    limits: { globalUsd: o.globalUsd, dailyUsd: o.dailyUsd, sessionUsd: o.sessionUsd, maxCallsPerSession: o.maxCallsPerSession },
    used: { global: committed.global, today: committed.byDay.get(day) || 0 },
    reserved: { global: reserved.global, calls: [...reservedCalls.values()].reduce((a, b) => a + b, 0) },
    remaining: {
      global: o.globalUsd > 0 ? Math.max(0, o.globalUsd - usedGlobal()) : null,
      today: o.dailyUsd > 0 ? Math.max(0, o.dailyUsd - usedDay(day)) : null
    },
    terminatedSessions: [...terminated.entries()].map(([id, v]) => ({ id, ...v })),
    rejected, wouldReject, events: events.slice(-25).reverse()
  };
}

// Named-budget definitions + live spend (for /api/budgets).
function budgets(now = Date.now()) {
  const day = dayKey(now);
  return applicable({ sessionId: null }, day).concat(
    // include a representative per-session view for any active sessions
    [...committed.bySession.keys()].filter(Boolean).slice(0, 50).map((s) => ({ id: "session:" + s, scope: "session", key: s, limit: opts().sessionUsd || null, spent: usedSession(s), calls: sessionCalls.get(s) || 0, terminated: terminated.has(s) }))
  );
}

const sessionSpend = (s) => usedSession(s);

module.exports = { init, reset, reserve, commit, release, stats, budgets, sessionSpend };
