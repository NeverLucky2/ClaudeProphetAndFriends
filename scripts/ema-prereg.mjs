// scripts/ema-prereg.mjs
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

export function buildEmaPrereg({ trainN, holdoutN, createdUtc }) {
  const a = {
    prereg_version: '1.0',
    created_utc: createdUtc ?? new Date().toISOString(),
    hypothesis: 'a daily mechanical EMA-pullback has no positive BETA-ADJUSTED edge net of costs (expected null)',
    primary: { fast: 25, slow: 75, W: 10, kStop: 1.5, kTarget: 1.5, maxHold: 10, cci: false, width_filter: false },
    grid_train_only: {
      ema_pairs: [[10, 30], [20, 50], [50, 150]], W: [5, 20], kStop: [1.0, 2.0],
      kTarget: [1.0, 3.0], maxHold: [5, 20], width_filter: [true], cci: [true],
    },
    entry_fill: 'signal_day_close',
    atr: 'wilder_14_asof_t',
    exit_gap_model: 'stop=market(gap_worse); target=limit(capped_at_target); same_bar_both=stop_loss',
    friction_bps: { optimistic: 10, representative: 20, stress: 30 },
    borrow_bps_annual: { etf: 50, largecap: 200 },
    decision_metric: 'beta-adjusted residual at 20bps (+ short borrow)',
    benchmarks: ['SPY', 'QQQ'],
    beta: 'per-instrument OLS on TRAIN daily returns, frozen',
    bootstrap: { method: 'date_block', block_sessions: 15, iterations: 10000, seed: 1234, ci_pct: [2.5, 97.5] },
    decision_rule: {
      gate_alpha: 'holdout beta-adjusted residual mean/trade 95% CI lo > 0 vs BOTH SPY and QQQ',
      gate_robust: 'train beta-adjusted residual mean > 0 (alpha sign-consistency)',
      verdict: 'KEEP-CANDIDATE iff gate_alpha AND gate_robust else REJECT; UNDERPOWERED if holdout trades < 100 OR distinct dates < 40',
    },
    power_floor: { trades: 100, distinct_dates: 40 },
    author_window_decontam: 'score trailing 24 months (2024-06..2026-06) separately',
    split: 'chronological 50/50',
    counts: { train_n: trainN, holdout_n: holdoutN },
    expected_outcome: 'REJECT',
  };
  a.artifact_hash = sha256short(stable(a));
  return a;
}

export function verifyEmaPrereg(a) {
  const expected = sha256short(stable(a));
  return { ok: expected === a.artifact_hash, expected, found: a.artifact_hash };
}

// CLI: node scripts/ema-prereg.mjs --instances data/lab/ema-instances.json --out data/lab/ema-prereg.json
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const inst = JSON.parse(readFileSync(flag('--instances', 'data/lab/ema-instances.json'), 'utf8'));
    const a = buildEmaPrereg({
      trainN: inst.filter(r => r.split === 'train').length,
      holdoutN: inst.filter(r => r.split === 'holdout').length,
    });
    const out = flag('--out', 'data/lab/ema-prereg.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(a, null, 2));
    process.stdout.write(`wrote ${out} (hash ${a.artifact_hash})\n`);
  }
}
