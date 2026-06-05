// scripts/coil-timeout-prereg.mjs
// Hash-locked pre-registration for the exit-timeout study. Self-contained build+verify share one
// `stable` so the hash can never disagree across modules; reuses sha256short from the event study.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256short } from './coil-eventstudy-prereg.mjs';

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => k !== 'artifact_hash')
      .map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function buildTimeoutPrereg({ pairedN, trainN, holdoutN, createdUtc }) {
  const a = {
    prereg_version: '1.0',
    created_utc: createdUtc ?? new Date().toISOString(),
    hypothesis: 'extending Coil 5-day time stop does NOT improve risk-adjusted edge (expected null)',
    variants: [5, 7, 8, 10],
    baseline_maxHold: 5,
    primary_maxHold: 7,
    secondary_maxHold: [8, 10],
    exit_model: { stop_pct: 7, rsi_exit: 70, sma5_cross: true, entry_rsi: 5, stop: 'intraday_gap_honest' },
    entry_fill: 'signal_day_close',
    earnings_filter: 'forward 5 trading bars, FMP stable earnings-calendar',
    enumeration: 'paired on the 5-day schedule (Phase 1); per-variant fresh enumeration (Phase 2)',
    friction_bps: { optimistic: 10, representative: 20, stress: 30 },
    decision_metric: 'friction-net per-trade delta (gross delta, friction cancels) at 20bps',
    winsorize_pct: 90,
    bootstrap: { method: 'date_block', block_sessions: 15, iterations: 10000, seed: 1234, ci_pct: [2.5, 97.5] },
    decision_rule: {
      gate1a: 'holdout paired Δ (return@7 − return@5) over time_stop@5 trades: 95% CI lo > 0',
      gate1b: 'gate1a recomputed with upside winsorized at p90: 95% CI lo > 0 (edge not tail-funded)',
      gate2: 'holdout portfolio net(7) > net(5) AND maxDD(7) <= maxDD(5)*1.1',
      verdict: 'EXTEND iff gate1a AND gate1b AND gate2; else KEEP (labeled by failing gate); UNDERPOWERED if n_delta@7 < 30',
      dd_untested_ratio: 0.5,
    },
    power_floor_n: 30,
    expected_outcome: 'KEEP',
    split: 'chronological 50/50',
    counts: { paired_n: pairedN, train_n: trainN, holdout_n: holdoutN },
  };
  a.artifact_hash = sha256short(stable(a));
  return a;
}

export function verifyTimeoutPrereg(a) {
  const expected = sha256short(stable(a));
  return { ok: expected === a.artifact_hash, expected, found: a.artifact_hash };
}

// CLI: node scripts/coil-timeout-prereg.mjs --instances data/lab/coil-timeout-instances.json --out data/lab/coil-timeout-prereg.json
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const inst = JSON.parse(readFileSync(flag('--instances', 'data/lab/coil-timeout-instances.json'), 'utf8'));
    const paired = inst.paired || [];
    const trainN = paired.filter(r => r.split === 'train').length;
    const holdoutN = paired.filter(r => r.split === 'holdout').length;
    const a = buildTimeoutPrereg({ pairedN: paired.length, trainN, holdoutN });
    const out = flag('--out', 'data/lab/coil-timeout-prereg.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(a, null, 2));
    process.stdout.write(`wrote ${out} (hash ${a.artifact_hash})\n`);
  }
}
