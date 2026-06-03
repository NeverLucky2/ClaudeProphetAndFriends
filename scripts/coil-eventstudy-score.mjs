// scripts/coil-eventstudy-score.mjs
// Two-sample scorer: mean market-adjusted forward-return difference (catalyst - clean),
// date-block bootstrap CI on the difference, equivalence-aware verdict. Refuses to
// score the holdout on a prereg hash mismatch.
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPrereg } from './coil-eventstudy-prereg.mjs';

export function assignBuckets(instances, threshold) {
  return instances.map(r => ({ ...r, bucket: (r.composite != null && r.composite >= threshold) ? 'catalyst' : 'clean' }));
}

function bucketReturns(instances, H) {
  const cat = [], cln = [];
  for (const r of instances) {
    const v = r.madj && r.madj[H];
    if (v == null) continue;
    (r.bucket === 'catalyst' ? cat : cln).push(v);
  }
  return { cat, cln };
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function meanDiff(instances, H) {
  const { cat, cln } = bucketReturns(instances, H);
  if (!cat.length || !cln.length) return null;
  return mean(cat) - mean(cln);
}

// mulberry32 PRNG — reproducible bootstrap (same idiom as trade-ledger.mjs).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Resample whole date-blocks with replacement; recompute the catalyst-clean mean diff each iter.
export function dateBlockBootstrapDiff(instances, H, { blockSessions = 10, iterations = 10000, seed = 1234 } = {}) {
  const usable = instances.filter(r => r.madj && r.madj[H] != null);
  const dates = [...new Set(usable.map(r => r.date))].sort();
  const blocks = [];
  for (let i = 0; i < dates.length; i += blockSessions) blocks.push(new Set(dates.slice(i, i + blockSessions)));
  const byBlock = blocks.map(set => usable.filter(r => set.has(r.date)));
  const rng = mulberry32(seed);
  const diffs = [];
  for (let it = 0; it < iterations; it += 1) {
    const sample = [];
    for (let b = 0; b < byBlock.length; b += 1) sample.push(...byBlock[(rng() * byBlock.length) | 0]);
    const d = meanDiff(sample, H);
    if (d != null) diffs.push(d);
  }
  diffs.sort((a, b) => a - b);
  const pct = (p) => diffs[Math.min(diffs.length - 1, Math.max(0, Math.floor((p / 100) * diffs.length)))];
  return { meanDiff: meanDiff(usable, H), lo: pct(2.5), hi: pct(97.5), iters: diffs.length };
}

export function scoreSplit(instances, H, artifact) {
  const mde = artifact.effect_size_mde;
  const boot = dateBlockBootstrapDiff(instances, H, {
    blockSessions: artifact.bootstrap.block_sessions,
    iterations: artifact.bootstrap.iterations, seed: artifact.bootstrap.seed,
  });
  const { cat, cln } = bucketReturns(instances, H);
  let verdict;
  if (boot.meanDiff == null) verdict = 'INSUFFICIENT';
  else if (boot.hi < 0 && boot.meanDiff <= -mde) verdict = 'SIGNAL';
  else if (boot.lo >= -mde && boot.hi <= mde) verdict = 'NO_EFFECT';
  else verdict = 'INSUFFICIENT';
  return { H, n_catalyst: cat.length, n_clean: cln.length, ...boot, mde, verdict };
}

// CLI: cat data/lab/coil-instances.json | node scripts/coil-eventstudy-score.mjs --artifact data/lab/coil-prereg.json --split holdout
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const artifact = JSON.parse(readFileSync(flag('--artifact', 'data/lab/coil-prereg.json'), 'utf8'));
    const split = flag('--split', 'holdout');
    const v = verifyPrereg(artifact);
    if (split === 'holdout' && !v.ok) {
      process.stderr.write(`REFUSING to score holdout: prereg hash mismatch (expected ${v.expected}, found ${v.found}).\n`);
      process.exit(4);
    }
    let stdin = ''; process.stdin.on('data', c => { stdin += c; });
    process.stdin.on('end', () => {
      const all = JSON.parse(stdin);
      const inSplit = assignBuckets(all.filter(r => (r.split ?? split) === split), artifact.cut.threshold);
      const out = { split, by_horizon: artifact.horizons.map(H => scoreSplit(inSplit, H, artifact)) };
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    });
  }
}
