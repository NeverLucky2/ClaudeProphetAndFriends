// scripts/fleet-defensive-proxy.mjs
// defensive-Prophet structural-light proxy: QQQ<200DMA trigger opens a defined-risk QQQ
// put-spread, priced daily via BSM (reuses coil-opt-bsm). Caveated, crisis-only downstream.
import { bsPrice } from './coil-opt-bsm.mjs';

export function sma200(closes) {
  if (closes.length < 200) return 0;
  let s = 0; for (let i = closes.length - 200; i < closes.length; i += 1) s += closes[i];
  return s / 200;
}
export function triggered(closes) { const m = sma200(closes); return m > 0 && closes[closes.length - 1] < m; }
export function putSpreadValue(S, Klong, Kshort, T, r, sigma) {
  return bsPrice('put', S, Klong, T, r, sigma) - bsPrice('put', S, Kshort, T, r, sigma);
}
export function realizedVol(closes, win = 20) {
  if (closes.length < win + 1) return 0.2;
  const rets = [];
  for (let i = closes.length - win; i < closes.length; i += 1) rets.push(Math.log(closes[i] / closes[i - 1]));
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  let v = 0; for (const x of rets) v += (x - m) * (x - m);
  return Math.max(0.05, Math.sqrt(v / rets.length) * Math.sqrt(252));
}

export function simulateDefensiveProxy(qqqBars, { start, end, portfolio = 100000, r = 0.04, costPct = 0.01, tenorBars = 21 } = {}) {
  const series = []; let pos = null;
  for (let i = 0; i < qqqBars.length; i += 1) {
    const d = qqqBars[i].date;
    if (d < start || d > end) continue;
    const closes = qqqBars.slice(0, i + 1).map(b => b.close);
    const S = qqqBars[i].close;
    const sigma = realizedVol(closes, 20);
    const trig = triggered(closes);
    let ret = 0, heldToday = false;
    if (pos) {
      heldToday = true;
      const Trem = Math.max(1, pos.expiryIdx - i) / 252;
      const value = putSpreadValue(S, pos.Klong, pos.Kshort, Trem, r, sigma);
      ret = pos.contracts * (value - pos.prevValue) / portfolio;
      pos.prevValue = value;
      if (!trig || i >= pos.expiryIdx) pos = null; // close after marking today
    } else if (trig) {
      const Klong = Math.round(S * 0.95), Kshort = Math.round(S * 0.85);
      const v0 = putSpreadValue(S, Klong, Kshort, tenorBars / 252, r, sigma);
      if (v0 > 0) { pos = { Klong, Kshort, expiryIdx: i + tenorBars, contracts: (costPct * portfolio) / v0, prevValue: v0 }; heldToday = true; }
    }
    series.push({ date: d, ret, active: heldToday });
  }
  return series;
}
