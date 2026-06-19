import { mean } from './coil-threshold-metrics.mjs';

export function forwardReturnOpenToOpen(openByDate, dates, t, h) {
  const ei = t + 1, xi = t + 1 + h;
  if (ei >= dates.length || xi >= dates.length) return null;
  const e = openByDate.get(dates[ei]), x = openByDate.get(dates[xi]);
  if (!Number.isFinite(e) || !Number.isFinite(x) || e === 0) return null;
  return x / e - 1;
}

export function dailySpread(rankByTicker, retByTicker, k = 5) {
  const usable = Object.keys(rankByTicker)
    .filter(tk => Number.isFinite(rankByTicker[tk]) && Number.isFinite(retByTicker[tk]));
  if (usable.length < 2 * k) return null;
  usable.sort((a, b) => rankByTicker[b] - rankByTicker[a]); // high rank first
  const top = usable.slice(0, k);
  const bottom = usable.slice(-k);
  return { spread: mean(top.map(t => retByTicker[t])) - mean(bottom.map(t => retByTicker[t])), top, bottom };
}
