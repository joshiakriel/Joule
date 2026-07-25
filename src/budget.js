"use strict";
const config = require("./config");

/**
 * Budget enforcement — metering REPORTS, this PREVENTS.
 *
 * Before the model is called, a request's cost is estimated and RESERVED against
 * hierarchical budgets (global, per-day, per-session/agent-run). If a cap would be
 * exceeded AND enforcement is on, `reserve()` returns ok:false and the caller
 * rejects the request (HTTP 402) without calling the model. After the response,
 * `commit()` reconciles the reservation to the ACTUAL cost. With enforcement off
 * (default) nothing is blocked — breaches are counted (`wouldReject`) for reporting.
 */

const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
const opts = () => config.budget;

let committed, reserved, seq, rejected, wouldReject;
function reset() {
  committed = { global: 0, byDay: new Map(), bySession: new Map() };
  reserved = { global: 0, byDay: new Map(), bySession: new Map() };
  seq = 0; rejected = 0; wouldReject = 0;
}
reset();

const bump = (map, key, delta) => { if (key == null) return; map.set(key, (map.get(key) || 0) + delta); };

// Seed committed spend from existing store records (survives restarts via the log).
function init(records) {
  reset();
  for (const r of records || []) commitRaw(r.actual?.costUsd || 0, r.session, new Date(r.ts).getTime());
}

function commitRaw(cost, sessionId, ts) {
  const day = dayKey(ts || Date.now());
  committed.global += cost; bump(committed.byDay, day, cost); bump(committed.bySession, sessionId || null, cost);
}

const usedGlobal = () => committed.global + reserved.global;
const usedDay = (d) => (committed.byDay.get(d) || 0) + (reserved.byDay.get(d) || 0);
const usedSession = (s) => (committed.bySession.get(s) || 0) + (reserved.bySession.get(s) || 0);

// Reserve an estimated cost. Returns { ok, id?, message?, detail?, wouldReject }.
function reserve({ sessionId, estCostUsd, maxCostUsd, now = Date.now() }) {
  const o = opts();
  const day = dayKey(now);
  let breach = null;
  if (Number.isFinite(maxCostUsd) && estCostUsd > maxCostUsd) {
    breach = { scope: "request", limit: maxCostUsd, current: 0, wouldBe: estCostUsd };
  } else {
    const checks = [];
    if (o.globalUsd > 0) checks.push(["global", o.globalUsd, usedGlobal()]);
    if (o.dailyUsd > 0) checks.push(["day", o.dailyUsd, usedDay(day)]);
    if (o.sessionUsd > 0 && sessionId) checks.push(["session", o.sessionUsd, usedSession(sessionId)]);
    for (const [scope, limit, current] of checks) {
      if (current + estCostUsd > limit) { breach = { scope, limit, current, wouldBe: current + estCostUsd }; break; }
    }
  }
  if (breach && o.enforce) {
    rejected++;
    return { ok: false, message: `budget exceeded: ${breach.scope} cap $${breach.limit} would be exceeded (projected $${breach.wouldBe.toFixed(6)})`, detail: breach };
  }
  if (breach) wouldReject++;
  // apply the reservation (also in metering-only mode, so projections stay accurate)
  reserved.global += estCostUsd; bump(reserved.byDay, day, estCostUsd); bump(reserved.bySession, sessionId || null, estCostUsd);
  return { ok: true, id: "rv-" + (seq++), est: estCostUsd, day, sessionId: sessionId || null, wouldReject: Boolean(breach) };
}

function dropReservation(rv) {
  reserved.global -= rv.est; bump(reserved.byDay, rv.day, -rv.est); bump(reserved.bySession, rv.sessionId, -rv.est);
}
function commit(rv, actualCostUsd) {
  if (!rv || !rv.id) return;
  dropReservation(rv);
  commitRaw(actualCostUsd || 0, rv.sessionId, Date.parse(rv.day));
}
function release(rv) { if (rv && rv.id) dropReservation(rv); }

function stats(now = Date.now()) {
  const o = opts(); const day = dayKey(now);
  return {
    enforce: o.enforce,
    limits: { globalUsd: o.globalUsd, dailyUsd: o.dailyUsd, sessionUsd: o.sessionUsd },
    used: { global: committed.global, today: committed.byDay.get(day) || 0 },
    reserved: { global: reserved.global },
    remaining: {
      global: o.globalUsd > 0 ? Math.max(0, o.globalUsd - usedGlobal()) : null,
      today: o.dailyUsd > 0 ? Math.max(0, o.dailyUsd - usedDay(day)) : null
    },
    rejected, wouldReject
  };
}

// Session spend so far (committed + reserved) — for per-session headers/inspection.
const sessionSpend = (s) => usedSession(s);

module.exports = { init, reset, reserve, commit, release, stats, sessionSpend };
