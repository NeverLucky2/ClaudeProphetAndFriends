// scripts/coil-nearmiss-enum.mjs
// Near-miss EPISODE enumeration for the Coil front-run study.
//
// A "near-miss" is a bar where Coil's non-RSI gates hold (close > SMA200, close < SMA5)
// and RSI(2) sits in [5, 15) — oversold, but not oversold enough to fire.
//
// RSI(2) is heavily autocorrelated: one dip yields several consecutive in-band bars.
// Counting BARS would measure episode length, not episode count. So we enumerate
// fresh-signal EPISODES (mirroring coil-threshold-build's one-open-trade-per-ticker rule)
// and follow each forward to a resolution.
//
// Resolution precedence within a bar (first match wins):
//   1. FIRE        — rsi2 < 5 with the gates still holding (it converted)
//   2. BOUNCE      — close > SMA5: the pullback condition broke ("it jumped")
//   3. REGIME_EXIT — close < SMA200: left the tradeable regime
// Nothing by `cap` bars -> UNRESOLVED (reported, excluded from the conversion rate).
//
// No lookahead: the check at d+k reads only facts[0..d+k].
import { wilderRSI, sma } from './coil-meanrev-signal.mjs';

const RSI_PERIOD = 2, SMA_LONG = 200, SMA_SHORT = 5;

export const MIN_BARS = 210;        // matches entryFiresAt's warmup guard
export const FIRE_MAX = 5;          // Coil's entry trigger
export const NEAR_MISS_HI = 15;     // the WATCH band's upper edge
export const RESOLUTION_CAP = 10;   // bars to follow an episode before giving up

// barFacts: everything a resolution decision needs, or null before warmup.
export function barFacts(closes, idx) {
  if (idx + 1 < MIN_BARS) return null;
  const s200 = sma(closes, idx, SMA_LONG);
  const s5 = sma(closes, idx, SMA_SHORT);
  if (s200 === null || s5 === null) return null;
  return { close: closes[idx], rsi2: wilderRSI(closes.slice(0, idx + 1), RSI_PERIOD), s5, s200 };
}

// factsSeries: one barFacts per bar. Computed once so wilderRSI runs once per bar.
export function factsSeries(closes) {
  return closes.map((_, i) => barFacts(closes, i));
}

export function stateOf(f) {
  if (!f) return 'OUT';
  if (!(f.close > f.s200 && f.close < f.s5)) return 'OUT';  // gates
  if (f.rsi2 < FIRE_MAX) return 'FIRE';
  if (f.rsi2 < NEAR_MISS_HI) return 'NEAR_MISS';
  return 'OUT';
}

export function resolveEpisode(facts, startIdx, { cap = RESOLUTION_CAP } = {}) {
  for (let k = 1; k <= cap; k += 1) {
    const j = startIdx + k;
    if (j >= facts.length) return { outcome: 'UNRESOLVED', bars: k - 1 };
    const f = facts[j];
    if (!f) return { outcome: 'UNRESOLVED', bars: k };
    if (f.rsi2 < FIRE_MAX && f.close < f.s5 && f.close > f.s200) return { outcome: 'FIRE', bars: k };
    if (f.close > f.s5) return { outcome: 'BOUNCE', bars: k };
    if (f.close < f.s200) return { outcome: 'REGIME_EXIT', bars: k };
  }
  return { outcome: 'UNRESOLVED', bars: cap };
}

// enumerateEpisodes: bars are [{date, close, ...}] ascending.
// An episode starts on the first NEAR_MISS bar whose predecessor was NOT in-band
// (neither NEAR_MISS nor FIRE), and no new episode starts inside a resolving one.
export function enumerateEpisodes(bars, { cap = RESOLUTION_CAP } = {}) {
  const closes = bars.map(b => b.close);
  const dates = bars.map(b => b.date);
  const facts = factsSeries(closes);
  const eps = [];
  let skipUntil = -1;
  for (let i = 1; i < facts.length; i += 1) {
    if (i <= skipUntil) continue;
    if (stateOf(facts[i]) !== 'NEAR_MISS') continue;
    const prev = stateOf(facts[i - 1]);
    if (prev === 'NEAR_MISS' || prev === 'FIRE') continue;
    const r = resolveEpisode(facts, i, { cap });
    eps.push({
      idx: i, date: dates[i], rsi2: facts[i].rsi2,
      outcome: r.outcome, bars: r.bars,
      resolveDate: dates[i + r.bars] ?? null,
    });
    skipUntil = i + r.bars;
  }
  return eps;
}
