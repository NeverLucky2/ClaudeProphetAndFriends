// scripts/overlay-candidates.mjs
// Build each hedge candidate's RAW daily return series (funding applied later in overlay-combine).
import { simulateDefensiveProxy } from './fleet-defensive-proxy.mjs';

export function staticSleeveDaily(bars, { start, end } = {}) {
  const out = [];
  for (let i = 1; i < bars.length; i += 1) {
    const d = bars[i].date;
    if ((start && d < start) || (end && d > end)) continue;
    out.push({ date: d, ret: bars[i].close / bars[i - 1].close - 1, active: true });
  }
  return out;
}

// candidate: from overlay-universe CANDIDATES. ctx: {barsByTicker, qqqBars, start, end, size}.
// For 'spread', `size` is the def-Prophet costPct (premium fraction). Returns [{date,ret,active}].
export function hedgeDaily(candidate, { barsByTicker, qqqBars, start, end, size } = {}) {
  if (candidate.kind === 'static') {
    return staticSleeveDaily(barsByTicker.get(candidate.ticker) || [], { start, end });
  }
  if (candidate.kind === 'spread') {
    return simulateDefensiveProxy(qqqBars, { start, end, costPct: size ?? 0.01 });
  }
  throw new Error(`unknown candidate kind: ${candidate.kind}`);
}
