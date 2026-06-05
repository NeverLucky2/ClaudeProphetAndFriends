// scripts/coil-threshold-metrics.mjs
// Pure metrics + date-block bootstrap (resamples whole calendar blocks so same-day,
// beta-correlated trades move together; block length >> the 5-day hold).

export function applyFriction(grossReturn, bps) { return grossReturn - bps / 10000; }
export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function winRate(returns) { return returns.length ? returns.filter(r => r > 0).length / returns.length : null; }
export function profitFactor(returns) {
  let g = 0, l = 0;
  for (const r of returns) { if (r > 0) g += r; else l += -r; }
  return l === 0 ? (g > 0 ? Infinity : null) : g / l;
}

// mulberry32 — reproducible PRNG (same idiom as coil-eventstudy-score.mjs).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Group rows ({date, net}) into consecutive date-blocks of `blockSessions` distinct dates.
function blocksByDate(rows, blockSessions) {
  const dates = [...new Set(rows.map(r => r.date))].sort();
  const blocks = [];
  for (let i = 0; i < dates.length; i += blockSessions) {
    const set = new Set(dates.slice(i, i + blockSessions));
    blocks.push(rows.filter(r => set.has(r.date)));
  }
  return blocks;
}
const pctOf = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))];

// 95% CI on the mean net of a single group, by date-block resampling.
export function bootstrapMeanCI(rows, { iterations = 10000, seed = 1234, blockSessions = 15 } = {}) {
  const usable = rows.filter(r => Number.isFinite(r.net));
  const blocks = blocksByDate(usable, blockSessions);
  const rng = mulberry32(seed);
  const means = [];
  for (let it = 0; it < iterations; it += 1) {
    const sample = [];
    for (let b = 0; b < blocks.length; b += 1) sample.push(...blocks[(rng() * blocks.length) | 0]);
    const m = mean(sample.map(r => r.net));
    if (m != null) means.push(m);
  }
  means.sort((a, b) => a - b);
  return { n: usable.length, mean: mean(usable.map(r => r.net)), lo: pctOf(means, 2.5), hi: pctOf(means, 97.5), iters: means.length };
}

// 95% CI on (mean net of B - mean net of A), resampling a shared date-block index so both
// groups move together on the same dates.
export function bootstrapDiffCI(rowsA, rowsB, { iterations = 10000, seed = 1234, blockSessions = 15 } = {}) {
  const A = rowsA.filter(r => Number.isFinite(r.net));
  const B = rowsB.filter(r => Number.isFinite(r.net));
  const dates = [...new Set([...A, ...B].map(r => r.date))].sort();
  const blockIdx = [];
  for (let i = 0; i < dates.length; i += blockSessions) blockIdx.push(new Set(dates.slice(i, i + blockSessions)));
  const aBlocks = blockIdx.map(set => A.filter(r => set.has(r.date)));
  const bBlocks = blockIdx.map(set => B.filter(r => set.has(r.date)));
  const rng = mulberry32(seed);
  const diffs = [];
  for (let it = 0; it < iterations; it += 1) {
    const aS = [], bS = [];
    for (let k = 0; k < blockIdx.length; k += 1) { const j = (rng() * blockIdx.length) | 0; aS.push(...aBlocks[j]); bS.push(...bBlocks[j]); }
    const ma = mean(aS.map(r => r.net)), mb = mean(bS.map(r => r.net));
    if (ma != null && mb != null) diffs.push(mb - ma);
  }
  diffs.sort((a, b) => a - b);
  const md = (mean(B.map(r => r.net)) ?? 0) - (mean(A.map(r => r.net)) ?? 0);
  return { nA: A.length, nB: B.length, mean: md, lo: pctOf(diffs, 2.5), hi: pctOf(diffs, 97.5), iters: diffs.length };
}
