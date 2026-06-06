// scripts/ema-universe.mjs
// Study universes for the EMA-pullback backtest. The ETF cut combines the Turtle
// multi-asset macro basket (mostly NON-equity → equity-beta ≈ 0, so raw ≈ alpha there)
// with the three liquid equity index ETFs (where beta-adjustment does the real work).
import { MEANREV_UNIVERSE } from './coil-eventstudy-build.mjs';

const TURTLE_MACRO = [
  'TLT', 'IEF', 'TIP', 'GLD', 'SLV', 'USO', 'UNG',
  'DBC', 'DBA', 'DBB', 'UUP', 'FXE', 'FXY', 'EEM', 'EFA',
];
const EQUITY_INDEX = ['SPY', 'QQQ', 'IWM']; // DIA omitted: near-redundant with SPY

export const EMA_ETF_UNIVERSE = [...new Set([...TURTLE_MACRO, ...EQUITY_INDEX])];
export const EMA_LARGECAP_UNIVERSE = [...MEANREV_UNIVERSE];
export const BENCHMARKS = ['SPY', 'QQQ'];

export function allStudyTickers() {
  return [...new Set([...EMA_ETF_UNIVERSE, ...EMA_LARGECAP_UNIVERSE, ...BENCHMARKS])];
}
