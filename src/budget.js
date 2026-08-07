"use strict";
const config = require("./config");

/**
 * Budget enforcement — the economic firewall, now PER-TENANT (Phase 1.1).
 *
 * Every tenant gets its OWN budget state (committed/reserved spend, session call
 * counts, terminations, audit events). Reservations count IN-FLIGHT cost AND calls so
 * caps hold under concurrency. The configured caps (config.budget.*) apply to each
 * tenant independently — one tenant can never spend, see, or terminate another's budget.
 *
 * Before the model is called, a request's cost is estimated and RESERVED against that
 * tenant's hierarchical budgets (global, per-day, per-session). A block breach returns
 * ok:false and the caller rejects with 429. commit() reconciles to actual afterwards.
 * Fail mode: fail_open (default) allows + logs on engine error; fail_closed rejects.
 */

const DEFAULT_TENANT = config.auth.defaultTenantId;
const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
const opts = () => config.budget;

const states = new Map(); // tenantId -> state
let seq = 0;
function freshState() {
  return {
    committed: { global: 0, byDay: new Map(), bySession: new Map(), byKey: new Map() },
    reserved: { global: 0, byDay: new Map(), bySession: new Map(), byKey: new Map() },
    sessionCalls: new Map(),
    reservedCalls: new Map(),
    terminated: new Map(),
    events: [],
    rejected: 0, wouldReject: 0
  };
}
function stateFor(tenantId) {
  const id = tenantId || DEFAULT_TENANT;
  if (!states.has(id)) states.set(id, freshState());
  return states.get(id);
}
function reset() { states.clear(); seq = 0; }

const bump = (map, key, delta) => { if (key == null) return; map.set(key, (map.get(key) || 0) + delta); };
const record = (st, e) => { st.events.push({ ts: new Date().toISOString(), ...e }); if (st.events.length > 500) st.events.shift(); };

// Seed committed spend + call counts from existing store records, grouped by tenant.
function init(records) {
  reset();
  for (const r of records || []) commitRaw(stateFor(r.tenant), r.actual?.costUsd || 0, r.session, new Date(r.ts).getTime());
}
function commitRaw(st, cost, sessionId, ts) {
  const day = dayKey(ts || Date.now());
  st.committed.global += cost; bump(st.committed.byDay, day, cost); bump(st.committed.bySession, sessionId || null, cost);
  if (sessionId) st.sessionCalls.set(sessionId, (st.sessionCalls.get(sessionId) || 0) + 1);
}

const usedGlobal = (st) => st.committed.global + st.reserved.global;
const usedDay = (st, d) => (st.committed.byDay.get(d) || 0) + (st.reserved.byDay.get(d) || 0);
const usedSession = (st, s) => (st.committed.bySession.get(s) || 0) + (st.reserved.bySession.get(s) || 0);

function applicable(st, ctx, day) {
  const o = opts(); const b = [];
  if (o.globalUsd > 0) b.push({ id: "global", scope: "global", limit: o.globalUsd, spent: usedGlobal(st), action: "block", window: "lifetime" });
  if (o.dailyUsd > 0) b.push({ id: "daily", scope: "day", limit: o.dailyUsd, spent: usedDay(st, day), action: "block", window: "day", resetAt: day + "T24:00:00Z" });
  if (o.sessionUsd > 0 && ctx.sessionId) b.push({ id: "session", scope: "session", key: ctx.sessionId, limit: o.sessionUsd, spent: usedSession(st, ctx.sessionId), action: "block", window: "session" });
  for (const d of o.defs || []) {
    if (d.scope === "global") b.push({ ...d, spent: usedGlobal(st), action: d.action || "block" });
    else if (d.scope === "session" && ctx.sessionId && (!d.key || d.key === ctx.sessionId)) b.push({ ...d, key: ctx.sessionId, spent: usedSession(st, ctx.sessionId), action: d.action || "block" });
  }
  return b;
}

function reject(st, detail) { st.rejected++; record(st, { action: "block", ...detail }); return { ok: false, status: 429, message: `budget exceeded: ${detail.scope} cap $${detail.limit} (spent $${detail.spent.toFixed(6)})`, detail }; }

// Reserve an estimated cost against a tenant's budgets. Returns { ok, id?, tenantId, ... }.
function reserve({ tenantId, sessionId, estCostUsd, maxCostUsd, now = Date.now() }) {
  const o = opts();
  const tid = tenantId || DEFAULT_TENANT;
  const st = stateFor(tid);
  try {
    const ctx = { sessionId: sessionId || null };
    const day = dayKey(now);
    let flagged = false;

    if (o.enforce && sessionId && st.terminated.has(sessionId)) {
      return reject(st, { scope: "session", key: sessionId, limit: o.sessionUsd, spent: usedSession(st, sessionId), reason: "session terminated", terminated: st.terminated.get(sessionId) });
    }
    if (Number.isFinite(maxCostUsd) && estCostUsd > maxCostUsd) {
      if (o.enforce) return reject(st, { scope: "request", limit: maxCostUsd, spent: 0, wouldBe: estCostUsd });
      flagged = true; st.wouldReject++;
    }
    // per-session call cap — count IN-FLIGHT reservations too (concurrency-safe)
    const callsInUse = (st.sessionCalls.get(sessionId) || 0) + (st.reservedCalls.get(sessionId) || 0);
    if (o.maxCallsPerSession > 0 && sessionId && callsInUse >= o.maxCallsPerSession) {
      if (o.enforce) { st.terminated.set(sessionId, { reason: "max calls per session", at: new Date().toISOString() }); return reject(st, { scope: "session-calls", key: sessionId, limit: o.maxCallsPerSession, spent: callsInUse, reason: "max calls per session" }); }
      flagged = true; st.wouldReject++;
    }
    for (const bud of applicable(st, ctx, day)) {
      if (bud.spent + estCostUsd > bud.limit) {
        if (bud.action === "block") {
          if (o.enforce) {
            if (bud.scope === "session" && sessionId) st.terminated.set(sessionId, { reason: `${bud.id} cost cap`, at: new Date().toISOString() });
            return reject(st, { scope: bud.scope, key: bud.key, limit: bud.limit, spent: bud.spent, wouldBe: bud.spent + estCostUsd, budgetId: bud.id, window: bud.window, resetAt: bud.resetAt || null });
          }
          flagged = true; st.wouldReject++;
        } else { record(st, { action: bud.action, scope: bud.scope, key: bud.key, limit: bud.limit, spent: bud.spent, budgetId: bud.id }); }
      }
    }
    // apply reservation (cost + in-flight call count) — atomic (synchronous)
    st.reserved.global += estCostUsd; bump(st.reserved.byDay, day, estCostUsd); bump(st.reserved.bySession, sessionId || null, estCostUsd);
    if (sessionId) bump(st.reservedCalls, sessionId, 1);
    return { ok: true, id: "rv-" + (seq++), tenantId: tid, est: estCostUsd, day, sessionId: sessionId || null, wouldReject: flagged };
  } catch (err) {
    if (o.failMode === "fail_closed") { st.rejected++; return { ok: false, status: 429, message: "budget engine error (fail-closed)", detail: { scope: "engine", error: String(err.message) } }; }
    console.error("[budget] engine error — FAILING OPEN (allowing traffic):", err.message);
    return { ok: true, id: "rv-open-" + (seq++), tenantId: tid, est: estCostUsd, day: dayKey(now), sessionId: sessionId || null, failedOpen: true };
  }
}

function dropReservation(st, rv) {
  st.reserved.global -= rv.est; bump(st.reserved.byDay, rv.day, -rv.est); bump(st.reserved.bySession, rv.sessionId, -rv.est);
  if (rv.sessionId) { bump(st.reservedCalls, rv.sessionId, -1); if ((st.reservedCalls.get(rv.sessionId) || 0) <= 0) st.reservedCalls.delete(rv.sessionId); }
}
function commit(rv, actualCostUsd) {
  if (!rv || !rv.id) return;
  const st = stateFor(rv.tenantId);
  if (!rv.failedOpen) dropReservation(st, rv);
  commitRaw(st, actualCostUsd || 0, rv.sessionId, Date.parse(rv.day));
}
function release(rv) { if (rv && rv.id && !rv.failedOpen) dropReservation(stateFor(rv.tenantId), rv); }

function stats(tenantId, now = Date.now()) {
  const o = opts(); const day = dayKey(now); const st = stateFor(tenantId);
  return {
    enforce: o.enforce, failMode: o.failMode,
    limits: { globalUsd: o.globalUsd, dailyUsd: o.dailyUsd, sessionUsd: o.sessionUsd, maxCallsPerSession: o.maxCallsPerSession },
    used: { global: st.committed.global, today: st.committed.byDay.get(day) || 0 },
    reserved: { global: st.reserved.global, calls: [...st.reservedCalls.values()].reduce((a, b) => a + b, 0) },
    remaining: {
      global: o.globalUsd > 0 ? Math.max(0, o.globalUsd - usedGlobal(st)) : null,
      today: o.dailyUsd > 0 ? Math.max(0, o.dailyUsd - usedDay(st, day)) : null
    },
    terminatedSessions: [...st.terminated.entries()].map(([id, v]) => ({ id, ...v })),
    rejected: st.rejected, wouldReject: st.wouldReject, events: st.events.slice(-25).reverse()
  };
}

function budgets(tenantId, now = Date.now()) {
  const day = dayKey(now); const st = stateFor(tenantId);
  return applicable(st, { sessionId: null }, day).concat(
    [...st.committed.bySession.keys()].filter(Boolean).slice(0, 50).map((s) => ({ id: "session:" + s, scope: "session", key: s, limit: opts().sessionUsd || null, spent: usedSession(st, s), calls: st.sessionCalls.get(s) || 0, terminated: st.terminated.has(s) }))
  );
}

const sessionSpend = (tenantId, s) => usedSession(stateFor(tenantId), s);

module.exports = { init, reset, reserve, commit, release, stats, budgets, sessionSpend };
