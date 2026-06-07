// Single source of truth for the bond-carry study. Duration leg (IEF) + Turtle's rates cluster
// (the "different hat" comparator) + benchmarks + curve constants + windows.
import { join } from 'node:path';

export const DURATION_ETF = 'IEF';                  // 7–10y Treasury, the duration leg
export const RATES_CLUSTER = ['TLT', 'IEF', 'TIP']; // Turtle-v2 rates cluster (Gate 2.4 comparator)
export const BENCHMARKS = ['QQQ', 'SPY'];
export const CARRY_TICKERS = [...new Set([DURATION_ETF, ...RATES_CLUSTER, ...BENCHMARKS])];

// Curve points from FMP stable/treasury-rates, normalized keys (percent units; e.g. 4.25 = 4.25%).
export const CURVE_FIELDS = ['m3', 'y2', 'y5', 'y7', 'y10', 'y30'];
export const MOD_DUR = 7.5;     // representative IEF modified duration — fixed, documented, NOT fit
export const ROLL_FROM = 'y10'; // carry point (~IEF maturity)
export const ROLL_TO = 'y7';    // one roll-step down (10y slides toward 7y); interpolate if y7 absent
export const CASH_FIELD = 'm3'; // 3-month T-bill = cash opportunity cost + accrual rate

export const FETCH_FROM = '2002-07-01'; // IEF inception; Task-0 probe confirms true curve depth
export const TRAIN_END = '2014-12-31';  // train = diagnostic window only (primary rule is param-free)
export const HOLDOUT_START = '2015-01-01';
export const STUDY_END = '2026-06-06';

export const CARRY_CACHE_SUBDIR = join('data', 'lab', 'carry-cache');

export const EDGE_BLOCK_WEEKS = 26;        // ~6 months — captures curve-regime persistence
export const FRICTION_HALF_SPREAD_BPS = 1.5; // IEF ultra-liquid; round-trip ≈ 3bps
export const BUFFER_GRID_BPS = [25, 50];   // robustness variant only (percent: 0.25, 0.50)
