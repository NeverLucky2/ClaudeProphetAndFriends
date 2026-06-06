// scripts/fleet-drift-sim.mjs
// Drift PEAD event sim -> daily marks. Port of drift_signal_service.go signal pieces +
// TRADING_RULES_DRIFT.md entry/exit. CONTINUATION path ON. Documented simplification: the
// rarely-reachable weekly-PEAD-ready path is omitted; entries are continuation-driven.
import { loadFleetBars } from './fleet-bars.mjs';
import { DRIFT_UNIVERSE } from './fleet-universe.mjs';

function maOf(closes, n) { if (closes.length < n) return 0; let s = 0; for (let i = closes.length - n; i < closes.length; i += 1) s += closes[i]; return s / n; }
export function aboveMA(closes, n) { const m = maOf(closes, n); return m > 0 && closes[closes.length - 1] >= m; }

export function computeGapPct(bars, earningsDate, timing) {
  const idx = bars.findIndex(b => b.date === earningsDate);
  if (idx < 0) return null;
  let base, gap;
  if (String(timing).toLowerCase() === 'bmo') { if (idx === 0) return null; base = bars[idx - 1].close; gap = bars[idx].open; }
  else { if (idx + 1 >= bars.length) return null; base = bars[idx].close; gap = bars[idx + 1].open; }
  if (!base) return null;
  return (gap / base - 1) * 100;
}
export function scoreGap(absGap) { if (absGap >= 10) return 100; if (absGap >= 7) return 85; if (absGap >= 5) return 70; if (absGap >= 3) return 55; if (absGap >= 1) return 35; return 15; }
export function scoreTrend(r) { if (r >= 15) return 100; if (r >= 10) return 85; if (r >= 5) return 70; if (r >= 0) return 50; if (r >= -5) return 30; return 15; }
export function scoreVol(ratio) { if (ratio >= 2) return 100; if (ratio >= 1.5) return 80; if (ratio >= 1.2) return 60; if (ratio >= 1) return 40; return 20; }
export function scoreMA200(d) { if (d >= 20) return 100; if (d >= 10) return 85; if (d >= 5) return 70; if (d >= 0) return 55; if (d >= -5) return 35; return 15; }
export function scoreMA50(d) { if (d >= 10) return 100; if (d >= 5) return 80; if (d >= 0) return 60; if (d >= -5) return 35; return 15; }
export function composite(gapS, trendS, volS, ma200S, ma50S) { return gapS * 0.25 + trendS * 0.30 + volS * 0.20 + ma200S * 0.15 + ma50S * 0.10; }
export function grade(score) { if (score >= 85) return 'A'; if (score >= 70) return 'B'; if (score >= 55) return 'C'; return 'D'; }
export function isContinuation({ daysAfterGap, latestClose, gapBarHigh, priorHigh }) { return daysAfterGap >= 1 && latestClose > gapBarHigh && latestClose > priorHigh; }
export function inferTiming(bars, earningsDate) {
  const idx = bars.findIndex(b => b.date === earningsDate);
  if (idx < 0) return 'amc';
  const haveBMO = idx >= 1 && bars[idx - 1].close > 0 && bars[idx].open > 0;
  const haveAMC = idx + 1 < bars.length && bars[idx].close > 0 && bars[idx + 1].open > 0;
  if (haveBMO && haveAMC) {
    const gBMO = Math.abs(bars[idx].open / bars[idx - 1].close - 1);
    const gAMC = Math.abs(bars[idx + 1].open / bars[idx].close - 1);
    return gBMO > gAMC ? 'bmo' : 'amc';
  }
  return haveBMO ? 'bmo' : 'amc';
}
export function trend20(bars, earningsDate) {
  const idx = bars.findIndex(b => b.date === earningsDate); if (idx < 20) return null;
  const base = bars[idx - 20].close; if (!base) return null;
  return (bars[idx].close / base - 1) * 100;
}
export function volRatio2060(bars, earningsDate) {
  const idx = bars.findIndex(b => b.date === earningsDate); if (idx < 59) return null;
  let s20 = 0, s60 = 0;
  for (let i = idx - 19; i <= idx; i += 1) s20 += (bars[i].volume || 0);
  for (let i = idx - 59; i <= idx; i += 1) s60 += (bars[i].volume || 0);
  const a60 = s60 / 60; if (!a60) return null; return (s20 / 20) / a60;
}
export function driftEntryQualifies({ gapPct, aboveMA200, aboveMA50, grade, continuation, peadStage }) {
  if (gapPct < 3.0) return false;
  if (!aboveMA200 || !aboveMA50) return false;
  if (grade !== 'A' && grade !== 'B') return false;
  return continuation || peadStage === 'SIGNAL_READY' || peadStage === 'BREAKOUT';
}
export function driftExit({ pnlPct, daysHeld, aboveMA50 }) {
  if (pnlPct >= 0.20) return { reason: 'target' };
  if (pnlPct <= -0.10) return { reason: 'stop' };
  if (daysHeld >= 60) return { reason: 'time_stop' };
  if (!aboveMA50) return { reason: 'ma50_break' };
  return { reason: '' };
}

// One ticker's continuation trades. Scans up to ~25 bars after the gap for the first qualifying
// continuation entry, then marks daily (entry-anchored day-0) to its exit.
export function buildDriftTrades(bars, earningsList) {
  const byDate = new Map(bars.map((b, i) => [b.date, i]));
  const trades = [];
  for (const ev of earningsList) {
    const timing = ev.timing || inferTiming(bars, ev.date);
    const E = byDate.get(ev.date); if (E == null) continue;
    const gapBar = timing === 'bmo' ? E : E + 1; if (gapBar >= bars.length) continue;
    const gapPct = computeGapPct(bars, ev.date, timing); if (gapPct == null || gapPct < 3) continue;
    const gS = scoreGap(Math.abs(gapPct));
    const tr = trend20(bars, ev.date); const tS = tr == null ? 50 : scoreTrend(tr);
    const vr = volRatio2060(bars, ev.date); const vS = vr == null ? 40 : scoreVol(vr);
    let entryIdx = -1;
    for (let d = gapBar + 1; d <= Math.min(gapBar + 25, bars.length - 1); d += 1) {
      const closes = bars.slice(0, d + 1).map(b => b.close);
      const ma200 = maOf(closes, 200), ma50 = maOf(closes, 50);
      if (ma200 === 0 || ma50 === 0) continue;
      const last = closes[closes.length - 1];
      const ma200S = scoreMA200((last / ma200 - 1) * 100);
      const ma50S = scoreMA50((last / ma50 - 1) * 100);
      const g = grade(composite(gS, tS, vS, ma200S, ma50S));
      const cont = isContinuation({ daysAfterGap: d - gapBar, latestClose: bars[d].close, gapBarHigh: bars[gapBar].high, priorHigh: bars[d - 1].high });
      if (driftEntryQualifies({ gapPct, aboveMA200: last >= ma200, aboveMA50: last >= ma50, grade: g, continuation: cont, peadStage: 'MONITORING' })) { entryIdx = d; break; }
    }
    if (entryIdx < 0) continue;
    const entryPrice = bars[entryIdx].close; const marks = []; let exitIdx = bars.length - 1;
    for (let d = entryIdx; d < bars.length; d += 1) {
      const prev = d === entryIdx ? entryPrice : bars[d - 1].close;
      marks.push({ date: bars[d].date, ret: bars[d].close / prev - 1 });
      const pnlPct = bars[d].close / entryPrice - 1; const daysHeld = d - entryIdx;
      const closes = bars.slice(0, d + 1).map(b => b.close); const ma50 = maOf(closes, 50);
      const ex = driftExit({ pnlPct, daysHeld, aboveMA50: ma50 > 0 && bars[d].close >= ma50 });
      if (ex.reason) { exitIdx = d; break; }
    }
    trades.push({ entryDate: bars[entryIdx].date, exitDate: bars[exitIdx].date, marks });
  }
  return trades;
}

export function simulateDrift(barsByTicker, earningsByTicker, { start, end, portfolio = 100000, posWeight = 0.04, maxPositions = 3 } = {}) {
  const all = [];
  for (const [t, bars] of barsByTicker) { const evs = earningsByTicker[t] || []; for (const tr of buildDriftTrades(bars, evs)) all.push({ ticker: t, ...tr }); }
  const items = all.map(tr => ({ tr, byDate: new Map(tr.marks.map(m => [m.date, m.ret])) }));
  const allDates = [...new Set(items.flatMap(x => x.tr.marks.map(m => m.date)))].filter(d => d >= start && d <= end).sort();
  const byEntry = new Map(); for (const x of items) { const k = x.tr.entryDate; if (!byEntry.has(k)) byEntry.set(k, []); byEntry.get(k).push(x); }
  const open = []; const series = [];
  for (const d of allDates) {
    for (let i = open.length - 1; i >= 0; i -= 1) if (open[i].tr.exitDate < d) open.splice(i, 1);
    const held = new Set(open.map(o => o.tr.ticker));
    for (const c of (byEntry.get(d) || [])) { if (open.length >= maxPositions) break; if (held.has(c.tr.ticker)) continue; open.push(c); held.add(c.tr.ticker); }
    let ret = 0; for (const o of open) { const r = o.byDate.get(d); if (r != null) ret += posWeight * r; }
    series.push({ date: d, ret, active: open.length > 0 });
  }
  return series;
}

// buildDriftSeries: event-driven Drift series across the DriftUniverse from the fleet bar cache +
// fetched earnings ({ticker:[{date,timing}]}; timing inferred when ''). Windowed to 2022+.
export function buildDriftSeries(root, { earningsByTicker = {}, start = '2022-01-01', end = '2026-06-06' } = {}) {
  const barsByTicker = new Map();
  for (const t of DRIFT_UNIVERSE) {
    const bars = loadFleetBars(root, t);
    if (bars.length >= 210) barsByTicker.set(t, bars);
  }
  return simulateDrift(barsByTicker, earningsByTicker, { start, end });
}
