// scripts/stage1-signals.mjs
// Assemble firings: catalyst trigger x summed sentiment x price-state agreement,
// then per-ticker thinning to >= H sessions apart, then chronological split. Spec §2/§5/§6.

import { keywordPolarityV1 } from './keyword-polarity.mjs';
import { priceState, forwardReturn } from './stage1-bars.mjs';

export function groupCatalysts(catalysts) {
  const byKey = new Map();
  for (const c of catalysts) {
    const key = `${c.ticker} ${c.date}`;
    const pol = keywordPolarityV1(`${c.headline ?? ''} ${c.snippet ?? ''}`);
    const prev = byKey.get(key) ?? { ticker: c.ticker, date: c.date, polaritySum: 0 };
    prev.polaritySum += pol;
    byKey.set(key, prev);
  }
  return [...byKey.values()].map(g => ({
    ticker: g.ticker, date: g.date, sentiment: Math.sign(g.polaritySum),
  }));
}

function dateIndex(bars) {
  const m = new Map();
  for (let i = 0; i < bars.length; i += 1) m.set(bars[i].date, i);
  return m;
}

export function buildFirings(catalysts, barsByTicker, H) {
  const grouped = groupCatalysts(catalysts);
  const idxCache = new Map();
  const firings = [];
  for (const g of grouped) {
    if (g.sentiment === 0) continue;
    const bars = barsByTicker.get(g.ticker);
    if (!bars) continue;
    let di = idxCache.get(g.ticker);
    if (!di) { di = dateIndex(bars); idxCache.set(g.ticker, di); }
    const dIdx = di.get(g.date);
    if (dIdx === undefined) continue;        // catalyst date is not a session for this ticker
    const ps = priceState(bars, dIdx);
    if (ps === 0 || ps !== g.sentiment) continue; // neutral or disagreement -> no fire
    const fr = forwardReturn(bars, dIdx, H, ps);
    if (fr === null) continue;               // forward window not computable
    firings.push({ ticker: g.ticker, date: g.date, dIdx, s: ps, R: fr.R, hit: fr.hit });
  }
  return firings;
}

export function thinFirings(firings, H) {
  const byTicker = new Map();
  for (const f of firings) (byTicker.get(f.ticker) ?? byTicker.set(f.ticker, []).get(f.ticker)).push(f);
  const kept = [];
  for (const list of byTicker.values()) {
    list.sort((a, b) => a.dIdx - b.dIdx);
    let lastKept = -Infinity;
    for (const f of list) {
      if (f.dIdx - lastKept >= H) { kept.push(f); lastKept = f.dIdx; }
    }
  }
  // stable order: ticker then dIdx
  kept.sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : a.dIdx - b.dIdx));
  return kept;
}

export function splitByDate(firings, splitDate) {
  return firings.map(f => ({ ...f, split: f.date >= splitDate ? 'holdout' : 'train' }));
}
