// scripts/overlay-stress.mjs
// Standardized −X% QQQ shock payoffs for the convex candidates — sample-independent complement to
// the in-sample cushion (spec §5; def-Prophet D-DP13 terminal-intrinsic, no greeks).

// Terminal-intrinsic value of a long(Klong)/short(Kshort) put DEBIT spread at spot S (Klong>Kshort).
export function spreadIntrinsicPayoff(S, Klong, Kshort) {
  return Math.max(Klong - S, 0) - Math.max(Kshort - S, 0);
}

// Grid of intrinsic payoff at standardized shocks off S0, using OTM strikes (def-Prophet geometry
// long ~5% OTM / short ~15% OTM). Returns { '-0.10': payoff, ... } in price units.
export function spreadStressGrid(S0, { longPct = 0.95, shortPct = 0.85, shocks = [-0.10, -0.20, -0.30] } = {}) {
  const Klong = S0 * longPct, Kshort = S0 * shortPct;
  const out = {};
  for (const sh of shocks) {
    const key = sh < 0 ? `${sh.toFixed(2)}` : String(sh);
    out[key] = spreadIntrinsicPayoff(S0 * (1 + sh), Klong, Kshort);
  }
  return out;
}

// VIXM: linear shock-beta extrapolation from its observed crisis-week mean response (conservative,
// no convex amplification claimed). crisisMeanRet = VIXM weekly mean in crisis weeks; refShock the
// mean QQQ crisis-week move. Returns expected VIXM payoff fraction at each shock.
export function vixmStressGrid(crisisMeanRet, refShock, { shocks = [-0.10, -0.20, -0.30] } = {}) {
  const beta = refShock === 0 ? 0 : crisisMeanRet / refShock; // ret per unit QQQ move
  const out = {};
  for (const sh of shocks) out[String(sh)] = beta * sh;
  return out;
}
