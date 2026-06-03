// scripts/coil-eventstudy-prereg.mjs
// Hash-locked pre-registration for the B1 two-sample event study. Freezes the cut
// threshold, effect size, horizons, benchmark, and bootstrap/verdict rules BEFORE
// scoring. Mirrors stage1-prereg's self-hash idiom.
import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

export function sha256short(t) { return createHash('sha256').update(t).digest('hex').slice(0, 8); }
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => k !== 'artifact_hash')
      .map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

// 66.667th percentile (nearest-rank) of the train composites — the catalyst-like cut.
export function tercileThreshold(train) {
  const xs = train.map(r => r.composite).filter(v => v != null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const rank = Math.ceil((2 / 3) * xs.length);
  return xs[Math.min(rank, xs.length) - 1];
}

export function buildPrereg({ cutThreshold, trainN, holdoutN, createdUtc }) {
  const a = {
    prereg_version: '1.0',
    created_utc: createdUtc ?? new Date().toISOString(),
    hypothesis: 'catalyst-like oversold dips have LOWER market-adjusted forward return than clean dips',
    horizons: [5, 10, 20],
    benchmark: 'SPY',
    entry: 'open[d+1]', exit: 'close[d+H]',
    composite: 'volume_ratio * abs(gap_pct)',
    cut: { rule: 'composite >= top-tercile of TRAIN composites', threshold: cutThreshold },
    effect_size_mde: 0.010,
    sd_prior: 0.07,
    sided: 'one (catalyst worse => diff < 0)',
    bootstrap: { method: 'date_block', block_sessions: 10, iterations: 10000, seed: 1234, ci_pct: [2.5, 97.5] },
    verdict_rule: {
      SIGNAL: 'hi < 0 AND meanDiff <= -effect_size_mde',
      NO_EFFECT: 'lo >= -effect_size_mde AND hi <= +effect_size_mde (equivalence)',
      INSUFFICIENT: 'otherwise',
    },
    counts: { train_n: trainN, holdout_n: holdoutN },
  };
  a.artifact_hash = sha256short(stable(a));
  return a;
}

export function verifyPrereg(a) {
  const expected = sha256short(stable(a));
  return { ok: expected === a.artifact_hash, expected, found: a.artifact_hash };
}

// CLI: node scripts/coil-eventstudy-prereg.mjs --instances data/lab/coil-instances.json --out data/lab/coil-prereg.json
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const { readFileSync } = await import('node:fs');
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const inst = JSON.parse(readFileSync(flag('--instances', 'data/lab/coil-instances.json'), 'utf8'));
    const train = inst.filter(r => r.split === 'train');
    const holdout = inst.filter(r => r.split === 'holdout');
    const thr = tercileThreshold(train);
    const a = buildPrereg({ cutThreshold: thr, trainN: train.length, holdoutN: holdout.length });
    const out = flag('--out', 'data/lab/coil-prereg.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(a, null, 2));
    process.stdout.write(`wrote ${out} (hash ${a.artifact_hash}, cut ${thr})\n`);
  }
}
