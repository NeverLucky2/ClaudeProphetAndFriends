// scripts/fleet-correlate.mjs
// Correlation / beta core for the fleet diagnostic. Reuses olsBeta (ema-beta) + mean
// (coil-threshold-metrics). T8 appends the crisis-conditional cut + surrogate null below.
import { olsBeta } from './ema-beta.mjs';
import { mean } from './coil-threshold-metrics.mjs';

// Reproducible PRNG (shared with the T8 surrogate). Module-local by design.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function pearson(x, y) {
  const n = Math.min(x.length, y.length); if (n < 2) return null;
  const mx = mean(x.slice(0, n)), my = mean(y.slice(0, n));
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i += 1) { const dx = x[i] - mx, dy = y[i] - my; cov += dx * dy; vx += dx * dx; vy += dy * dy; }
  return vx === 0 || vy === 0 ? null : cov / Math.sqrt(vx * vy);
}

function rank(a) {
  const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(a.length);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j < idx.length && idx[j][0] === idx[i][0]) j += 1;
    const avg = (i + j - 1) / 2 + 1;
    for (let k = i; k < j; k += 1) r[idx[k][1]] = avg;
    i = j;
  }
  return r;
}

export function spearman(x, y) { const n = Math.min(x.length, y.length); return pearson(rank(x.slice(0, n)), rank(y.slice(0, n))); }

export function zeroFraction(lane) { return lane.length ? lane.filter(p => p.ret === 0).length / lane.length : 1; }

export function conditionalSeries(lane, bench) {
  const x = [], y = [];
  for (let i = 0; i < lane.length; i += 1) if (lane[i].active) { x.push(lane[i].ret); y.push(bench[i].ret); }
  return { x, y };
}

export function betaTo(laneRets, benchRets) { return olsBeta(laneRets, benchRets); }

// Block-bootstrap 95% CI on the Pearson correlation. Blocks of `blockLen` consecutive weeks
// respect autocorrelation. Deterministic for a fixed seed.
export function bootstrapCorrCI(x, y, { seed = 1234, iterations = 2000, blockLen = 4 } = {}) {
  const n = Math.min(x.length, y.length);
  const point = pearson(x.slice(0, n), y.slice(0, n));
  if (n < 4) return { point, lo: null, hi: null, n };
  const rng = mulberry32(seed);
  const corrs = [];
  for (let it = 0; it < iterations; it += 1) {
    const xs = [], ys = [];
    while (xs.length < n) {
      const start = (rng() * (n - blockLen + 1)) | 0;
      for (let k = 0; k < blockLen && xs.length < n; k += 1) { xs.push(x[start + k]); ys.push(y[start + k]); }
    }
    const c = pearson(xs, ys); if (c != null) corrs.push(c);
  }
  corrs.sort((a, b) => a - b);
  const pct = (p) => corrs[Math.min(corrs.length - 1, Math.max(0, Math.floor((p / 100) * corrs.length)))];
  return { point, lo: pct(2.5), hi: pct(97.5), n };
}

// Block-bootstrap 95% CI on the OLS beta of laneRets on benchRets (the accidental-long-beta
// detector's significance). Same block-resample idiom as bootstrapCorrCI; deterministic per seed.
export function bootstrapBetaCI(laneRets, benchRets, { seed = 1234, iterations = 2000, blockLen = 4 } = {}) {
  const n = Math.min(laneRets.length, benchRets.length);
  const point = olsBeta(laneRets.slice(0, n), benchRets.slice(0, n));
  if (n < 4) return { point, lo: null, hi: null, n };
  const rng = mulberry32(seed); const betas = [];
  for (let it = 0; it < iterations; it += 1) {
    const xs = [], ys = [];
    while (xs.length < n) {
      const start = (rng() * (n - blockLen + 1)) | 0;
      for (let k = 0; k < blockLen && xs.length < n; k += 1) { xs.push(laneRets[start + k]); ys.push(benchRets[start + k]); }
    }
    betas.push(olsBeta(xs, ys));
  }
  betas.sort((a, b) => a - b);
  const pct = (p) => betas[Math.min(betas.length - 1, Math.max(0, Math.floor((p / 100) * betas.length)))];
  return { point, lo: pct(2.5), hi: pct(97.5), n };
}

// ── Crisis-conditional cut (descriptive lens; rotation surrogate = context BAND, not a gate) ──
// Design note: the downside-β-JUMP (crisis − full) + surrogate-gated binary label was abandoned
// (2026-06-06) — empirically underpowered: β over crisis weeks divides by a tiny var(QQQ|crisis)
// (leverage-explosive null), and when crisis weeks dominate full-sample variance the jump shrinks
// toward zero for a genuine tail co-move. Replaced with: crisis-conditional MEAN return (primary,
// robust) + ρ_crisis / downside β reported BESIDE a rotation band (how much selection-on-X
// manufactures) and an explicit insufficient-power flag. Full-sample β (above) stays the primary
// accidental-long-beta detector.

// crisisWeeks: indices of the worst-quintile (primary) or worst-decile QQQ weeks.
export function crisisWeeks(qqqWeekly, bucket = 'quintile') {
  const frac = bucket === 'decile' ? 0.1 : 0.2;
  const k = Math.max(1, Math.floor(qqqWeekly.length * frac));
  return qqqWeekly.map((w, i) => [w.ret, i]).sort((a, b) => a[0] - b[0]).slice(0, k).map(p => p[1]).sort((a, b) => a - b);
}

// effectiveN: count of nonzero-exposure lane-weeks within a crisis index set (the n-floor input).
export function effectiveN(lane, idxSet) { return idxSet.filter(i => lane[i] && lane[i].ret !== 0).length; }

// crisisMean: mean lane return over the crisis weeks — the PRIMARY robust ballast metric
// (positive = cushions QQQ's worst weeks; negative = co-crashes).
export function crisisMean(lane, idxSet) {
  if (!idxSet.length) return null;
  return idxSet.reduce((s, i) => s + lane[i].ret, 0) / idxSet.length;
}

// Bootstrap 95% CI on the crisis-conditional mean (resample crisis weeks with replacement).
export function crisisMeanCI(lane, idxSet, { seed = 1234, iterations = 2000 } = {}) {
  const xs = idxSet.map(i => lane[i].ret);
  const point = crisisMean(lane, idxSet);
  if (xs.length < 4) return { point, lo: null, hi: null, n: xs.length };
  const rng = mulberry32(seed); const means = [];
  for (let it = 0; it < iterations; it += 1) {
    let s = 0; for (let j = 0; j < xs.length; j += 1) s += xs[(rng() * xs.length) | 0];
    means.push(s / xs.length);
  }
  means.sort((a, b) => a - b);
  const pct = (p) => means[Math.min(means.length - 1, Math.floor((p / 100) * means.length))];
  return { point, lo: pct(2.5), hi: pct(97.5), n: xs.length };
}

// rhoCrisis / downsideBeta: crisis-conditional correlation + OLS slope (DESCRIPTIVE; compared
// against the rotation band below, never used to mint a binary verdict).
export function rhoCrisis(lane, qqq, idxSet) {
  return pearson(idxSet.map(i => lane[i].ret), idxSet.map(i => qqq[i].ret));
}
export function downsideBeta(lane, qqq, idxSet) {
  return olsBeta(idxSet.map(i => lane[i].ret), idxSet.map(i => qqq[i].ret));
}

// rotationBand: rotate the lane by a random offset against the FIXED QQQ + FIXED crisis indices
// (preserves the lane's marginal + autocorrelation, destroys QQQ cross-dependence), recompute the
// chosen conditional stat ('rho'|'beta') under NO real dependence. Returns {p5,p50,p95,n} — a
// CONTEXT band showing how much of the observed value the crisis selection manufactures. An
// observed stat outside [p5,p95] is "beyond the selection artifact"; the report treats this as
// suggestive, not a verdict, and pairs it with the effective-n insufficient-power flag.
export function rotationBand(lane, qqq, idxSet, stat = 'rho', { K = 1000, seed = 1234 } = {}) {
  const fn = stat === 'beta' ? downsideBeta : rhoCrisis;
  const n = lane.length; const rng = mulberry32(seed); const vals = [];
  for (let k = 0; k < K; k += 1) {
    const off = 1 + ((rng() * (n - 1)) | 0);
    const rot = Array.from({ length: n }, (_, i) => lane[(i + off) % n]);
    const v = fn(rot, qqq, idxSet);
    if (v != null && Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  const pct = (p) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor((p / 100) * vals.length))] : null);
  return { p5: pct(5), p50: pct(50), p95: pct(95), n: vals.length };
}

// rollingCorr: trailing-window Pearson of lane vs QQQ (regime-drift view).
export function rollingCorr(lane, qqq, win = 26) {
  const out = [];
  for (let i = win; i <= lane.length; i += 1) out.push(pearson(lane.slice(i - win, i).map(p => p.ret), qqq.slice(i - win, i).map(p => p.ret)));
  return out;
}
