// scripts/fleet-coil-marks.mjs
// Coil daily re-mark: turn the RSI(2) trade tape into a daily-marked portfolio return
// series. Day-0 anchored to the tape `entry` fill (matches grossReturn); close-to-close after.
import { loadFleetBars } from './fleet-bars.mjs';
import { enumerateFreshTrades } from './coil-threshold-build.mjs';
import { MEANREV_UNIVERSE } from './fleet-universe.mjs';

export function remarkTrade(trade, bars) {
  const bd = new Map(bars.map((b, i) => [b.date, i]));
  const i0 = bd.get(trade.date); const iE = bd.get(trade.exitDate);
  if (i0 == null || iE == null || iE < i0) return [];
  const marks = [];
  for (let i = i0; i <= iE; i += 1) {
    const prev = i === i0 ? trade.entry : bars[i - 1].close;
    marks.push({ date: bars[i].date, ret: bars[i].close / prev - 1 });
  }
  return marks;
}

export function simulateCoilDaily(trades, barsByTicker, { sizePct = 0.05, maxPositions = 4, deployCap = 0.24 } = {}) {
  const marksByTrade = trades.map(t => ({ t, marks: barsByTicker.has(t.ticker) ? remarkTrade(t, barsByTicker.get(t.ticker)) : [] }))
    .filter(x => x.marks.length);
  const retByDateTrade = marksByTrade.map(({ t, marks }) => ({ t, byDate: new Map(marks.map(m => [m.date, m.ret])), dates: marks.map(m => m.date) }));
  const allDates = [...new Set(retByDateTrade.flatMap(x => x.dates))].sort();
  const open = []; const series = [];
  const byEntryDate = new Map();
  for (const x of retByDateTrade) { const k = x.t.date; if (!byEntryDate.has(k)) byEntryDate.set(k, []); byEntryDate.get(k).push(x); }
  for (const d of allDates) {
    for (let i = open.length - 1; i >= 0; i -= 1) if (open[i].t.exitDate < d) open.splice(i, 1);
    const held = new Set(open.map(o => o.t.ticker));
    const cands = (byEntryDate.get(d) || []).slice().sort((a, b) => a.t.rsi2 - b.t.rsi2);
    for (const c of cands) {
      if (open.length >= maxPositions) break;
      if (open.length * sizePct + sizePct > deployCap + 1e-9) break;
      if (held.has(c.t.ticker)) continue;
      open.push(c); held.add(c.t.ticker);
    }
    let ret = 0;
    for (const o of open) { const r = o.byDate.get(d); if (r != null) ret += sizePct * r; }
    series.push({ date: d, ret, active: open.length > 0 });
  }
  return series;
}

// buildCoilSeries: rebuild the RSI(2)<5 tape across the MeanRev universe from the fleet bar cache,
// then daily-re-mark + overlay the 5%/≤4/24% portfolio. earningsByTicker is {ticker:[{date,...}]};
// only the dates feed Coil's no-earnings-within-5-trading-days filter.
export function buildCoilSeries(root, { earningsByTicker = {}, start = '2016-01-01' } = {}) {
  const barsByTicker = new Map();
  const trades = [];
  for (const t of MEANREV_UNIVERSE) {
    const bars = loadFleetBars(root, t);
    if (bars.length < 210) continue;
    barsByTicker.set(t, bars);
    const ed = (earningsByTicker[t] || []).map(e => e.date);
    for (const tr of enumerateFreshTrades(bars, { rsiMax: 5, earningsDates: ed })) {
      if (tr.censored || !tr.exitDate) continue;
      trades.push({ ticker: t, date: tr.date, rsi2: tr.rsi2, entry: tr.entry, exitDate: tr.exitDate });
    }
  }
  return simulateCoilDaily(trades, barsByTicker).filter(p => p.date >= start);
}
