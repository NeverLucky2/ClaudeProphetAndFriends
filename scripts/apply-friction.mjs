// Friction post-processor. Reads raw decisive_actions JSON, applies asset-class-specific
// friction estimates, writes parallel *.friction.json files. Spec:
// docs/superpowers/specs/2026-05-17-friction-and-walkforward-design.md

const OCC_SYMBOL = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;
const IC_MARKERS = ['iron condor', 'ic ', ' ic', '4-leg', '4 leg'];
const STOP_OUT_SUBSTRINGS = [
  'stop hit',
  'stopped out',
  'stop triggered',
  'hit my stop',
  'hit stop',
  'stop loss fired',
  'sl hit',
  'stop loss triggered',
  'forced out',
];

export function detectAssetClass(action, agentId) {
  if (agentId === 'harvest') return 'iron_condor';
  const symbol = action?.symbol;
  if (typeof symbol !== 'string' || symbol.length === 0) return null;

  if (OCC_SYMBOL.test(symbol)) {
    const reasoning = (action.reasoning ?? '').toLowerCase();
    const hasMarker = IC_MARKERS.some(m => reasoning.includes(m));
    return hasMarker ? 'iron_condor' : 'single_leg_options';
  }

  // Plain ticker heuristic: 1-5 uppercase letters
  if (/^[A-Z]{1,5}$/.test(symbol)) {
    return agentId === 'penny-prophet' ? 'penny_stocks' : 'stocks';
  }

  return null;
}

export function isStopOut(action) {
  const unrealizedPct = action?.market_data?.unrealized_pct;
  if (typeof unrealizedPct !== 'number' || unrealizedPct >= 0) return false;
  const reasoning = (action?.reasoning ?? '').toLowerCase();
  return STOP_OUT_SUBSTRINGS.some(s => reasoning.includes(s));
}

export function computeStockFriction(action, profile, stopOut) {
  const md = action?.market_data ?? {};
  const { entry_price, size } = md;
  if (typeof size !== 'number') {
    throw new Error(`computeStockFriction: missing market_data.size on action ${action?.symbol}`);
  }

  const slippage = profile.per_share_slippage_usd * size * 2;
  const regulatory_fees = profile.regulatory_fee_per_share * size * 2;
  const commissions = (profile.commission_per_share ?? 0) * size * 2;
  const stop_gap_through = stopOut
    ? profile.stop_gap_through_pct * entry_price * size
    : 0;

  const haircut_total_usd = +(slippage + regulatory_fees + commissions + stop_gap_through).toFixed(4);
  return {
    haircut_total_usd,
    haircut_breakdown: { slippage, regulatory_fees, commissions, stop_gap_through },
  };
}
