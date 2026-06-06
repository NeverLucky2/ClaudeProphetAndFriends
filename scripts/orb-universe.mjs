// scripts/orb-universe.mjs
// ORB study universes. The ETF cut is the SOLE gated/decision universe (no selection on the
// tested behavior). The large-cap cut is EXPLORATORY ONLY — those names are selected on the
// dependent variable (today's momentum names), so they flatter ORB and never gate the verdict.
export const ORB_ETF_UNIVERSE = ['SPY', 'QQQ', 'IWM', 'DIA'];
export const ORB_LARGECAP_EXPLORATORY = ['AAPL', 'NVDA', 'TSLA', 'AMD', 'META'];
export const BENCHMARK = 'SPY';
// gate_mktrel excludes SPY (SPY-hedged-against-SPY ≈ 0 by construction).
export function gatedMktrelTickers() { return ORB_ETF_UNIVERSE.filter(t => t !== BENCHMARK); }
export function allOrbTickers() {
  return [...new Set([...ORB_ETF_UNIVERSE, ...ORB_LARGECAP_EXPLORATORY, BENCHMARK])];
}
