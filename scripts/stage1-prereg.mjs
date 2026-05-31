// scripts/stage1-prereg.mjs
// Builds + verifies the frozen pre-registration artifact (spec §7). The self-hash
// over canonical content (minus artifact_hash) gates holdout scoring in Task 7.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binomialPowerN } from './binomial-stats.mjs';

export function sha256short(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

// Canonical JSON: sorted keys, artifact_hash excluded, for a stable self-hash.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(k => k !== 'artifact_hash')
      .map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function buildPreregArtifact({ universeText, frictionText, splitDate, createdUtc }) {
  const HR0_floor = 0.55;
  const HR1 = HR0_floor + 0.08;
  const requiredN = binomialPowerN(HR0_floor, HR1, 0.05, 0.80); // 235 at the floor
  const artifact = {
    preregistration_version: '1.0',
    created_utc: createdUtc ?? new Date().toISOString(),
    horizon_sessions: 3,
    entry: 'open[d+1]', exit: 'close[d+3]',
    universe_file: 'config/prophet_tradable_universe.txt',
    universe_hash: sha256short(universeText),
    signal: {
      trigger: 'catalyst flag (ma|earnings) on (ticker,d), news <= d close',
      sentiment_source: 'keyword_polarity_v1',
      price_state: 'close>SMA20 & ret5d>0 => bull; mirror => bear; else no-fire',
      fire_rule: 'sentiment_sign == price_state_sign != 0; s = that sign',
    },
    null: { HR0_floor, HR0_rule: 'max(0.55, derived_breakeven_train)',
      derived_breakeven: 'MC stylized 3d ATM call, TRAIN-only, upward-only', HR0_final: null },
    power: { alpha: 0.05, sided: 'one', HR1_rule: 'HR0+0.08', HR1_at_floor: HR1, power: 0.80,
      required_independent_n_per_split: requiredN },
    variants: { k: 1, declared: ['keyword_polarity_v1'],
      rule_abandon: 'peeking-then-abandoning does NOT reduce k',
      rule_model_variant: 'must verify no training exposure to holdout period' },
    split: { scheme: 'chronological_50_50', train_pct: 0.5, holdout_pct: 0.5, split_date: splitDate },
    thinning: 'per-ticker, keep firings >= 3 sessions apart (greedy earliest-first)',
    bootstrap: { method: 'date_block', block_sessions: 10, iterations: 10000, seed: 1234,
      require: 'p5 HR > HR0_final', residual_note: 'long-horizon clustering uncaptured; p slightly optimistic' },
    verdict: { PASS: 'binom p<alpha/k AND bootstrap_p5>HR0_final AND n>=required',
      FAIL: 'binom not rejected at power', UNDERPOWERED: 'achievable n < required n' },
    friction_config_hash: sha256short(frictionText),
  };
  artifact.artifact_hash = sha256short(stableStringify(artifact));
  return artifact;
}

export function verifyPrereg(artifact) {
  const expected = sha256short(stableStringify(artifact));
  return { ok: expected === artifact.artifact_hash, expected, found: artifact.artifact_hash };
}

export function writePrereg(artifact, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(artifact, null, 2));
  writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  return outPath;
}

// CLI: node scripts/stage1-prereg.mjs --split-date YYYY-MM-DD [--out data/lab/stage1-preregistration.json]
{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const flag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
    const splitDate = flag('--split-date');
    if (!splitDate) { process.stderr.write('Usage: --split-date YYYY-MM-DD [--out <path>]\n'); process.exit(2); }
    const root = process.cwd();
    const out = flag('--out') ?? join(root, 'data', 'lab', 'stage1-preregistration.json');
    const universePath = join(root, 'config', 'prophet_tradable_universe.txt');
    const frictionPath = join(root, 'config', 'friction.json');
    const universeText = existsSync(universePath) ? readFileSync(universePath, 'utf8') : '';
    const frictionText = existsSync(frictionPath) ? readFileSync(frictionPath, 'utf8') : '';
    if (!universeText) process.stderr.write(`warn: universe file missing at ${universePath}\n`);
    const artifact = buildPreregArtifact({ universeText, frictionText, splitDate });
    writePrereg(artifact, out);
    process.stdout.write(`wrote ${out} (hash ${artifact.artifact_hash}, required n ${artifact.power.required_independent_n_per_split})\n`);
  }
}
