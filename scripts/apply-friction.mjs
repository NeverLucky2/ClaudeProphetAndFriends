// Friction post-processor. Reads raw decisive_actions JSON, applies asset-class-specific
// friction estimates, writes parallel *.friction.json files. Spec:
// docs/superpowers/specs/2026-05-17-friction-and-walkforward-design.md

const OCC_SYMBOL = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;
const IC_MARKERS = ['iron condor', 'ic ', ' ic', '4-leg', '4 leg'];

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
