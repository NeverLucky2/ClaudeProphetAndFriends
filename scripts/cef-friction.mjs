// scripts/cef-friction.mjs
const HALF_SPREAD = { liquid: 0.0025, mid: 0.0050, thin: 0.0100 };
export function halfSpreadOf(tier) { return HALF_SPREAD[tier] ?? HALF_SPREAD.thin; }
export function roundTripCost(tier, stressMult = 1) { return 2 * halfSpreadOf(tier) * stressMult; }
