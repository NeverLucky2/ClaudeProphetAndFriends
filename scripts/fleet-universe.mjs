// scripts/fleet-universe.mjs
// Single source of truth for the fleet study's tickers. ETF basket + clusters mirror
// models/trend_universe.go; MEANREV_UNIVERSE reused from coil-eventstudy-build.mjs.
import { MEANREV_UNIVERSE } from './coil-eventstudy-build.mjs';

export { MEANREV_UNIVERSE };

export const TURTLE_ETFS = [
  { ticker: 'TLT', cluster: 'rates' }, { ticker: 'IEF', cluster: 'rates' }, { ticker: 'TIP', cluster: 'rates' },
  { ticker: 'GLD', cluster: 'metals' }, { ticker: 'SLV', cluster: 'metals' },
  { ticker: 'USO', cluster: 'energy' }, { ticker: 'UNG', cluster: 'energy' },
  { ticker: 'DBC', cluster: 'commodity' }, { ticker: 'DBA', cluster: 'commodity' }, { ticker: 'DBB', cluster: 'commodity' },
  { ticker: 'UUP', cluster: 'fx' }, { ticker: 'FXE', cluster: 'fx' }, { ticker: 'FXY', cluster: 'fx' },
  { ticker: 'EEM', cluster: 'intl_equity' }, { ticker: 'EFA', cluster: 'intl_equity' },
];

export const BENCHMARKS = ['QQQ', 'SPY'];

export function clusterOf(ticker) {
  const t = String(ticker).toUpperCase().trim();
  const hit = TURTLE_ETFS.find(e => e.ticker === t);
  return hit ? hit.cluster : '';
}

export const DRIFT_UNIVERSE = MEANREV_UNIVERSE; // services.DriftUniverse reuses MeanRevUniverse

export function allFleetTickers() {
  return [...new Set([...TURTLE_ETFS.map(e => e.ticker), ...MEANREV_UNIVERSE, ...BENCHMARKS])];
}
