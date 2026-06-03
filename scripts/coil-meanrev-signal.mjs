// scripts/coil-meanrev-signal.mjs
// JS port of services/meanrev_signal_service.go — Wilder RSI(2), SMA(200)/SMA(5)
// INCLUDING the current bar, entry = rsi2<5 && close>sma200 && close<sma5.
// Min 210 bars of history through the instance index (mirrors meanRevMinBars).
const RSI_PERIOD = 2, SMA200 = 200, SMA5 = 5, RSI_MAX = 5.0, MIN_BARS = 210;

export function wilderRSI(closes, n = RSI_PERIOD) {
  const L = closes.length;
  if (L < n + 1 || n <= 0) return 50;
  let sumGain = 0, sumLoss = 0;
  for (let i = 1; i <= n; i += 1) {
    const ch = closes[i] - closes[i - 1];
    if (ch > 0) sumGain += ch; else if (ch < 0) sumLoss -= ch;
  }
  let avgGain = sumGain / n, avgLoss = sumLoss / n;
  for (let i = n + 1; i < L; i += 1) {
    const ch = closes[i] - closes[i - 1];
    const gain = ch > 0 ? ch : 0, loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (n - 1) + gain) / n;
    avgLoss = (avgLoss * (n - 1) + loss) / n;
  }
  if (avgLoss === 0 && avgGain === 0) return 50;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// Mean of the n closes ending at idx (INCLUSIVE), or null if not enough history.
export function sma(closes, idx, n) {
  if (idx < n - 1) return null;
  let s = 0; for (let i = idx - n + 1; i <= idx; i += 1) s += closes[i];
  return s / n;
}

// Entry predicate evaluated at index idx using closes[0..idx].
export function entryFires(closes, idx) {
  if (idx + 1 < MIN_BARS) return false;
  const rsi2 = wilderRSI(closes.slice(0, idx + 1), RSI_PERIOD);
  const sma200 = sma(closes, idx, SMA200);
  const sma5 = sma(closes, idx, SMA5);
  if (sma200 === null || sma5 === null) return false;
  const c = closes[idx];
  return rsi2 < RSI_MAX && c > sma200 && c < sma5;
}

// Every bar index where the entry fired, with the computed signal values attached.
export function enumerateInstances(bars) {
  const closes = bars.map(b => b.close);
  const out = [];
  for (let i = MIN_BARS - 1; i < bars.length; i += 1) {
    if (!entryFires(closes, i)) continue;
    out.push({
      idx: i, date: bars[i].date,
      rsi2: wilderRSI(closes.slice(0, i + 1), RSI_PERIOD),
      sma200: sma(closes, i, SMA200), sma5: sma(closes, i, SMA5), close: closes[i],
    });
  }
  return out;
}
