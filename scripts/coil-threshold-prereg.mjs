// scripts/coil-threshold-prereg.mjs
// Hash-locked pre-registration for the RSI-threshold study. Mirrors the self-hash idiom of
// coil-eventstudy-prereg.mjs (reusing its sha256short).
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256short } from './coil-eventstudy-prereg.mjs';

export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => k !== 'artifact_hash')
      .map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function buildThresholdPrereg({ trainN, holdoutN, createdUtc }) {
  const a = {
    prereg_version: '1.0',
    created_utc: createdUtc ?? new Date().toISOString(),
    hypothesis: 'loosening Coil RSI(2)<5 does NOT improve risk-adjusted edge (expected null)',
    buckets: ['[0,5)', '[5,8)', '[8,10)', '[10,15)'],
    primary_T: 8,
    secondary_T: [10, 15],
    exit_model: { stop_pct: 7, rsi_exit: 70, sma5_cross: true, max_hold_days: 5, stop: 'intraday_gap_honest' },
    entry_fill: 'signal_day_close',
    earnings_filter: 'forward 5 trading bars, FMP stable earnings-calendar',
    enumeration: 'fresh signals only (one open trade per ticker)',
    friction_bps: { optimistic: 10, representative: 20, stress: 30 },
    decision_metric: 'friction-net return at 20bps',
    bootstrap: { method: 'date_block', block_sessions: 15, iterations: 10000, seed: 1234, ci_pct: [2.5, 97.5] },
    decision_rule: {
      gate1: 'holdout marginal-fill (present at T=8, absent at T=5) net-return 95% CI lo > 0',
      gate2: 'holdout portfolio net return(T=8) > net return(T=5) AND maxDD(T=8) <= maxDD(T=5)*1.1',
      verdict: 'CONSIDER iff gate1 AND gate2 else KEEP; UNDERPOWERED if marginal n < 30',
    },
    power_floor_n: 30,
    expected_outcome: 'KEEP',
    split: 'chronological 50/50',
    counts: { train_n: trainN, holdout_n: holdoutN },
  };
  a.artifact_hash = sha256short(stable(a));
  return a;
}

export function verifyThresholdPrereg(a) {
  const expected = sha256short(stable(a));
  return { ok: expected === a.artifact_hash, expected, found: a.artifact_hash };
}

// CLI: node scripts/coil-threshold-prereg.mjs --instances data/lab/coil-threshold-instances.json --out data/lab/coil-threshold-prereg.json
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const inst = JSON.parse(readFileSync(flag('--instances', 'data/lab/coil-threshold-instances.json'), 'utf8'));
    const trainN = inst.filter(r => r.split === 'train').length;
    const holdoutN = inst.filter(r => r.split === 'holdout').length;
    const a = buildThresholdPrereg({ trainN, holdoutN });
    const out = flag('--out', 'data/lab/coil-threshold-prereg.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(a, null, 2));
    process.stdout.write(`wrote ${out} (hash ${a.artifact_hash})\n`);
  }
}
