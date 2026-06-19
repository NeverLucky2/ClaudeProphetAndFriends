export function trailingMean(values, idx, window = 21) {
  if (idx < window) return null;
  let s = 0;
  for (let i = idx - window; i < idx; i += 1) s += values[i];
  return s / window;
}

export function reducedEOV(values, idx, window = 21) {
  const tm = trailingMean(values, idx, window);
  if (tm == null || tm === 0) return null;
  return values[idx] / tm;
}

export function splitExcludedDates(tradingDates, splitDate, window = 21) {
  const i = tradingDates.indexOf(splitDate);
  const out = new Set();
  if (i < 0) return out;
  for (let j = i; j <= i + window && j < tradingDates.length; j += 1) out.add(tradingDates[j]);
  return out;
}

export function crossSectionalRank(valueByTicker, minNames = 12) {
  const entries = Object.entries(valueByTicker).filter(([, v]) => Number.isFinite(v));
  if (entries.length < minNames) return null;
  entries.sort((a, b) => a[1] - b[1]);
  const n = entries.length;
  const out = {};
  // percentile rank: 0 for the min, 1 for the max
  entries.forEach(([tk], i) => { out[tk] = n === 1 ? 0.5 : i / (n - 1); });
  return out;
}
