// scripts/orb-report.mjs
// Pure decision-informing report helpers for the ORB study (robustness + intraday texture).
import { mean } from './coil-threshold-metrics.mjs';

export function dropTopN(values, n) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const kept = n > 0 ? s.slice(0, Math.max(0, s.length - n)) : s;
  return mean(kept);
}

export function edgeByHour(rows) {
  const by = {};
  for (const r of rows) { const h = Math.floor(r.entryMinutes / 60); (by[h] ||= []).push(r.r); }
  return Object.keys(by).map(Number).sort((a, b) => a - b)
    .map(h => ({ hour: h, n: by[h].length, mean: mean(by[h]) }));
}
