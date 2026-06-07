// scripts/overlay-book.mjs
// Reconstruct the Merrill book's daily return series from current value-weights, with daily
// renormalization over names that have a usable (prior + today) bar. Pure: takes a barsByTicker Map.
import { barsByDate } from './fleet-bars.mjs';

// Returns [{date, ret, active:true}] over [start,end]; ret = Σ w_i r_i renormalized over available names.
export function bookDaily(holdings, barsByTicker, { start, end } = {}) {
  const idx = new Map(); const arr = new Map();
  for (const h of holdings) { const b = barsByTicker.get(h.symbol) || []; idx.set(h.symbol, barsByDate(b)); arr.set(h.symbol, b); }
  const allDates = [...new Set(holdings.flatMap((h) => (barsByTicker.get(h.symbol) || []).map((b) => b.date)))]
    .filter((d) => (!start || d >= start) && (!end || d <= end)).sort();
  const series = [];
  for (const d of allDates) {
    let wsum = 0; const parts = [];
    for (const h of holdings) {
      const bi = idx.get(h.symbol).get(d); if (bi == null || bi < 1) continue;
      const b = arr.get(h.symbol);
      const r = b[bi].close / b[bi - 1].close - 1;
      parts.push({ w: h.value, r }); wsum += h.value;
    }
    if (!parts.length || wsum <= 0) continue;
    let ret = 0; for (const p of parts) ret += (p.w / wsum) * p.r;
    series.push({ date: d, ret, active: true });
  }
  return series;
}

// Mean fraction of book value (by year) whose names had NO bar that calendar year.
export function droppedWeightByYear(holdings, barsByTicker, { start, end } = {}) {
  const total = holdings.reduce((s, h) => s + h.value, 0) || 1;
  const years = new Set();
  for (const h of holdings) for (const b of (barsByTicker.get(h.symbol) || [])) {
    if ((!start || b.date >= start) && (!end || b.date <= end)) years.add(b.date.slice(0, 4));
  }
  const out = {};
  for (const y of [...years].sort()) {
    let present = 0;
    for (const h of holdings) {
      const has = (barsByTicker.get(h.symbol) || []).some((b) => b.date.slice(0, 4) === y);
      if (has) present += h.value;
    }
    out[y] = 1 - present / total;
  }
  return out;
}
