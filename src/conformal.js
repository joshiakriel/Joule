"use strict";
const config = require("./config");

/**
 * Conformal Risk Control (CRC) — distribution-free selective risk control.
 *
 * Loss for a calibration point at threshold tau: 1 if we WOULD route it small
 * (calibrated p >= tau) AND it was NOT acceptable, else 0. We pick the LOWEST tau
 * (most small-routing) whose finite-sample risk bound stays <= alpha:
 *
 *     (n * Rhat(tau) + 1) / (n + 1)  <=  alpha           [Angelopoulos et al. 2022]
 *
 * with Rhat(tau) the empirical mean loss over the calibration set (loss bounded in
 * [0,1], so B=1). Route small only when the calibrated score clears tau.
 *
 * The guarantee is MARGINAL (population-level), NOT per-query, and distribution
 * shift can violate it. Callers must report n and alpha with any claim.
 */

// points: [{ p, label(0|1) }]. Returns the chosen threshold + empirical coverage.
function compute(points, alpha = config.verify.targetRiskAlpha) {
  const pts = points.filter((x) => Number.isFinite(x.p));
  const n = pts.length;
  if (!n) return { threshold: 1.01, coverage: null, riskBound: null, n: 0, alpha, ready: false };
  const cand = [...new Set(pts.map((x) => x.p))].sort((a, b) => a - b); // low -> high
  for (const tau of cand) {
    const routedSmall = pts.filter((x) => x.p >= tau);
    const wrong = routedSmall.reduce((s, x) => s + (x.label ? 0 : 1), 0);   // routed small & unacceptable
    const rHat = wrong / n;
    const bound = (n * rHat + 1) / (n + 1);
    if (bound <= alpha) {
      // ascending tau => first satisfier is the lowest (routes the most small) safely
      return { threshold: tau, coverage: routedSmall.length ? 1 - wrong / routedSmall.length : null, riskBound: bound, n, alpha, ready: true };
    }
  }
  return { threshold: 1.01, coverage: null, riskBound: null, n, alpha, ready: false }; // nothing safe to route small yet
}

// Empirical acceptance rate (coverage) among routed-small points at tau — for held-out validation.
function coverageAt(points, tau) {
  const S = points.filter((x) => Number.isFinite(x.p) && x.p >= tau);
  if (!S.length) return null;
  return S.reduce((s, x) => s + (x.label ? 1 : 0), 0) / S.length;
}

module.exports = { compute, coverageAt };
