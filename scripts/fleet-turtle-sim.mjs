// scripts/fleet-turtle-sim.mjs
// Faithful long-only Donchian trend port (trend_signal_service.go + turtle_executor.go),
// daily mark-to-market. Simplified-out gates (documented): corr-guard, agg-risk cap,
// segment breaker, regime gate (neutral). Reuses fleet bar loader.
import { loadFleetBars, barsByDate } from './fleet-bars.mjs';
import { TURTLE_ETFS } from './fleet-universe.mjs';

export function donchianHigh(closes, n) {
  const L = closes.length; if (L < n + 2) return 0;
  let m = closes[L - n - 1];
  for (let i = L - n; i <= L - 2; i += 1) if (closes[i] > m) m = closes[i];
  return m;
}
export function donchianLow(closes, n) {
  const L = closes.length; if (L < n + 2) return 0;
  let m = closes[L - n - 1];
  for (let i = L - n; i <= L - 2; i += 1) if (closes[i] < m) m = closes[i];
  return m;
}
export function sma(closes, n) {
  const L = closes.length; if (L < n + 2) return 0;
  let s = 0; for (let i = L - n - 1; i <= L - 2; i += 1) s += closes[i];
  return s / n;
}
export function wilderATR(highs, lows, closes, n) {
  const L = closes.length; if (L < n + 1) return 0;
  const tr = new Array(L).fill(0);
  for (let i = 1; i < L; i += 1) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr[i] = Math.max(hl, Math.max(hc, lc));
  }
  let s = 0; for (let i = 1; i <= n; i += 1) s += tr[i];
  let atr = s / n;
  for (let i = n + 1; i < L; i += 1) atr = (atr * (n - 1) + tr[i]) / n;
  return atr;
}
export function entryFires({ lastClose, d100High, sma200, atr20 }) {
  if (lastClose <= d100High) return false;
  if (lastClose <= sma200) return false;
  if (lastClose === 0 || atr20 / lastClose < 0.005) return false;
  return true;
}
export function exitFires({ todayOpen, d50Low, entry, atrAtEntry, daysHeld }) {
  if (todayOpen <= d50Low) return { reason: 'trailing_stop' };
  if (daysHeld <= 20 && todayOpen <= entry - 2 * atrAtEntry) return { reason: 'initial_hard_stop' };
  return { reason: '' };
}
export function positionDollars(portfolio, lastClose, atr20) {
  if (portfolio <= 0 || lastClose <= 0 || atr20 <= 0) return 0;
  const raw = (portfolio * 0.005) / ((2 * atr20) / lastClose);
  const cap = portfolio * 0.04;
  return raw > cap ? cap : raw;
}

export function simulateTurtle(barsByTicker, { start, end, portfolio = 100000 } = {}) {
  const idx = {}; const closesAll = {};
  for (const [t, bars] of barsByTicker) { idx[t] = barsByDate(bars); closesAll[t] = bars; }
  const allDates = [...new Set([...barsByTicker.values()].flatMap(bs => bs.map(b => b.date)))]
    .filter(d => d >= start && d <= end).sort();
  const open = []; const series = [];
  const prevCloseByTicker = {};
  for (const d of allDates) {
    let dayPnL = 0;
    for (const p of open) {
      const bi = idx[p.ticker].get(d); if (bi == null) continue;
      const c = closesAll[p.ticker][bi].close;
      const prev = prevCloseByTicker[p.ticker] ?? p.entryPrice;
      dayPnL += p.shares * (c - prev);
    }
    series.push({ date: d, ret: dayPnL / portfolio, active: open.length > 0 });
    for (let i = open.length - 1; i >= 0; i -= 1) {
      const p = open[i]; const bi = idx[p.ticker].get(d); if (bi == null) continue;
      const closes = closesAll[p.ticker].slice(0, bi + 1).map(b => b.close);
      const d50Low = donchianLow(closes, 50);
      const todayOpen = closesAll[p.ticker][bi].open;
      if (exitFires({ todayOpen, d50Low, entry: p.entryPrice, atrAtEntry: p.atrAtEntry, daysHeld: p.daysHeld }).reason) open.splice(i, 1);
    }
    const heldClusters = new Set(open.map(p => p.cluster));
    const heldTickers = new Set(open.map(p => p.ticker));
    for (const { ticker: t, cluster } of TURTLE_ETFS) {
      if (open.length >= 6) break;
      if (heldTickers.has(t) || heldClusters.has(cluster)) continue;
      const bi = idx[t]?.get(d); if (bi == null) continue;
      const b = closesAll[t]; const closes = b.slice(0, bi + 1).map(x => x.close);
      const highs = b.slice(0, bi + 1).map(x => x.high); const lows = b.slice(0, bi + 1).map(x => x.low);
      if (closes.length < 252) continue;
      const sig = { lastClose: closes[closes.length - 1], d100High: donchianHigh(closes, 100), sma200: sma(closes, 200), atr20: wilderATR(highs, lows, closes, 20) };
      if (!entryFires(sig)) continue;
      const dollars = positionDollars(portfolio, sig.lastClose, sig.atr20);
      const shares = Math.floor(dollars / sig.lastClose);
      if (shares < 1) continue;
      open.push({ ticker: t, cluster, entryPrice: sig.lastClose, shares, atrAtEntry: sig.atr20, entryDate: d, daysHeld: 0 });
      heldClusters.add(cluster); heldTickers.add(t);
    }
    for (const p of open) { const bi = idx[p.ticker].get(d); if (bi != null) prevCloseByTicker[p.ticker] = closesAll[p.ticker][bi].close; p.daysHeld += 1; }
  }
  return series;
}
