// scripts/overlay-frontier.mjs
// Frontier dominance + regime classification + the pre-registered decision rule (spec §7),
// including the convexity guard (4(a) cannot be won by a convex candidate on in-sample cushion alone).

// subsets: { rateShock:{lo}, growthScare:{lo} } — bootstrap CI lower bounds of the cushion.
export function regimeClass(subsets) {
  const rs = subsets.rateShock && subsets.rateShock.lo != null && subsets.rateShock.lo > 0;
  const gs = subsets.growthScare && subsets.growthScare.lo != null && subsets.growthScare.lo > 0;
  if (rs && gs) return 'robust';
  if (rs || gs) return 'fragile';
  return 'ineffective';
}

// Smallest size index whose marginal efficiency gain over the prior size < `flatTol`, else max-eff.
export function recommendedSize(rows, { flatTol = 0.05 } = {}) {
  if (!rows.length) return null;
  const eff = rows.map((r) => (r.efficiency && r.efficiency.value != null ? r.efficiency.value : -Infinity));
  for (let i = 1; i < eff.length; i += 1) {
    const gain = eff[i] - eff[i - 1];
    if (Number.isFinite(gain) && gain < flatTol) return rows[i - 1];
  }
  let best = 0; for (let i = 1; i < eff.length; i += 1) if (eff[i] > eff[best]) best = i;
  return rows[best];
}

// cands: [{ id, convex, class, lumpedLo, drag, cushion, stressOk }] at recommended size.
// budget: calm-drag reference (fraction/yr) for "cheap". Returns { branch:'a'|'b'|'c', pick }.
export function recommend(cands, { budget = 0.02 } = {}) {
  const robust = cands.filter((c) => c.class === 'robust' && c.lumpedLo != null && c.lumpedLo > 0);
  if (!robust.length) return { branch: 'c', pick: null };

  // Branch (a): a robust candidate that is cheap (drag<=budget) dominates. Convex candidates may
  // only win (a) if stress-corroborated; otherwise they are excluded from the (a) contest.
  const aEligible = robust.filter((c) => c.drag <= budget && (!c.convex || c.stressOk));
  if (aEligible.length) {
    // dominance = highest cushion per drag (free_ballast drag<=0 sorts first)
    aEligible.sort((x, y) => (y.cushion / Math.max(y.drag, 1e-9)) - (x.cushion / Math.max(x.drag, 1e-9)));
    const pick = aEligible[0];
    // If the winner is a static sleeve, it's a genuine 4(a). If only def-Prophet qualifies, that's 4(b).
    if (!pick.convex) return { branch: 'a', pick: pick.id };
  }

  // Branch (b): def-Prophet is robust (the expected base case).
  const dp = robust.find((c) => c.id === 'def_prophet');
  if (dp) return { branch: 'b', pick: 'def_prophet' };

  // A robust convex non-def-Prophet (VIXM) with stress support but only it robust → treat as (b)-like
  // primary on that candidate; otherwise (a) for a static, else null.
  const staticRobust = robust.find((c) => !c.convex);
  if (staticRobust) return { branch: 'a', pick: staticRobust.id };
  return { branch: 'b', pick: robust[0].id };
}
