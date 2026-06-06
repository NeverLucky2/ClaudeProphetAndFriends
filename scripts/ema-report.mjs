// scripts/ema-report.mjs
// Pure report-enrichment helpers for the EMA study (§5 regime visibility + author-window
// decontamination). Operate on residual rows shaped { date: 'YYYY-MM-DD', net: number }
// (the same shape that feeds bootstrapMeanCI). Descriptive only — no decision logic.
import { mean } from './coil-threshold-metrics.mjs';

export function alphaByYear(residRows) {
  const byYear = {};
  for (const r of residRows) {
    const y = String(r.date).slice(0, 4);
    (byYear[y] ||= []).push(r.net);
  }
  return Object.keys(byYear).sort().map(y => ({ year: y, n: byYear[y].length, mean: mean(byYear[y]) }));
}

export function sliceFrom(residRows, fromDate) {
  return residRows.filter(r => String(r.date) >= fromDate);
}

export function sliceBefore(residRows, fromDate) {
  return residRows.filter(r => String(r.date) < fromDate);
}
