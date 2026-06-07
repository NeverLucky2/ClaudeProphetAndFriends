// scripts/overlay-combine.mjs
// Overlay metrics: calm-period drag (non-crisis weeks) vs regime-split crash cushion (crisis weeks),
// on the per-week contribution series. Reuses fleet-correlate crisisMean/crisisMeanCI as the
// paired-difference bootstrap (contrib IS the per-week combined−book difference). Spec §5.
import { crisisMean, crisisMeanCI } from './fleet-correlate.mjs';
import { mean } from './coil-threshold-metrics.mjs';

const WEEKS_PER_YEAR = 52;

// hedgeW, bookW: [{ret}] aligned. rf: number[] weekly risk-free (same length). Returns [{ret}].
export function contribWeekly(hedgeW, bookW, { w = 1, funding = 'cash', rf = [], isSpread = false } = {}) {
  const n = Math.min(hedgeW.length, bookW.length);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const h = hedgeW[i].ret;
    let c;
    if (isSpread) c = h;                                    // size already in costPct
    else if (funding === 'book') c = w * (h - bookW[i].ret);
    else c = w * (h - (rf[i] ?? 0));                        // cash-funded (default)
    out.push({ ret: c });
  }
  return out;
}

// Positive number = positive annualized COST. Computed over NON-crisis weeks only (spec §5).
export function calmDrag(contribW, crisisIdx) {
  const crisis = new Set(crisisIdx);
  const calm = contribW.filter((_, i) => !crisis.has(i)).map((p) => p.ret);
  if (!calm.length) return 0;
  return -WEEKS_PER_YEAR * mean(calm);
}

export function cushion(contribW, idx) { return crisisMean(contribW, idx); }
export function cushionCI(contribW, idx, opts = {}) { return crisisMeanCI(contribW, idx, opts); }

// cushion per 1%/yr drag; drag<=0 → free_ballast (honest positive calm carry). drag is a fraction/yr.
export function efficiency(cushionVal, dragFrac) {
  if (dragFrac == null || dragFrac <= 0) return { flag: 'free_ballast', value: null };
  return { flag: 'ok', value: cushionVal / dragFrac };
}

// combinedW: number[] weekly returns. Returns the most-negative peak-to-trough (a negative number).
export function maxDrawdown(rets) {
  let eq = 1, peak = 1, mdd = 0;
  for (const r of rets) { eq *= (1 + r); if (eq > peak) peak = eq; const dd = eq / peak - 1; if (dd < mdd) mdd = dd; }
  return mdd;
}

export function sharpe(rets) {
  if (rets.length < 2) return null;
  const m = mean(rets);
  let v = 0; for (const r of rets) v += (r - m) * (r - m);
  const sd = Math.sqrt(v / (rets.length - 1));
  return sd === 0 ? null : (m / sd) * Math.sqrt(WEEKS_PER_YEAR);
}
