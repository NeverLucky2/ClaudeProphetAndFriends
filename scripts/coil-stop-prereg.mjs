// scripts/coil-stop-prereg.mjs
// Hash-locked pre-registration for the stop-tightening study (mirror of coil-timeout-prereg.mjs).
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

export function buildStopPrereg({ marginalN, trainN, holdoutN, createdUtc }) {
  const a = {
    prereg_version: '1.0',
    created_utc: createdUtc ?? new Date().toISOString(),
    hypothesis: 'tightening Coil -7% stop does NOT cut risk enough to justify the expectancy give-up (expected null: KEEP)',
    variants: [0.03, 0.04, 0.05, 0.06],
    baseline_stop_pct: 0.07,
    primary_stop_pct: 0.05,
    secondary_stop_pct: [0.03, 0.04, 0.06],
    marginal_probe_pct: 0.03,
    exit_model: { rsi_exit: 70, sma5_cross: true, max_hold_days: 5, entry_rsi: 5, stop: 'intraday_gap_honest' },
    entry_fill: 'signal_day_close',
    earnings_filter: 'forward 5 trading bars, FMP stable earnings-calendar',
    enumeration: 'paired on the 0.07 baseline schedule (Phase 1 marginal subset); per-variant fresh enumeration (Phase 2)',
    friction_bps: { optimistic: 10, representative: 20, stress: 30 },
    stop_slippage_bps: 10,
    success_criterion: 'cut risk, hold returns',
    decision_metric: 'friction-net total return + max drawdown at 20bps',
    bootstrap: { method: 'date_block', block_sessions: 15, iterations: 10000, seed: 1234, ci_pct: [2.5, 97.5] },
    winsorize_pct: 90,
    decision_rule: {
      gateA_risk: 'holdout |maxDD(0.05)| <= 0.90 * |maxDD(0.07)| (>=10% relative drawdown reduction)',
      gateB_returns: 'holdout totalNet(0.05) >= 0.90 * totalNet(0.07) (<=10% relative give-up)',
      cvar: 'trade-level CVaR(5%) reported as corroboration, NOT a hard sub-gate',
      verdict: 'TIGHTEN iff gateA AND gateB; else KEEP labeled by failing gate; UNDERPOWERED if marginal n@0.05 < 30',
      dd_reduction_floor: 0.90,
      return_retention_floor: 0.90,
      dd_untested_ratio: 0.5,
    },
    power_floor_n: 30,
    expected_outcome: 'KEEP',
    split: 'chronological 50/50',
    counts: { marginal_n: marginalN, train_n: trainN, holdout_n: holdoutN },
  };
  a.artifact_hash = sha256short(stable(a));
  return a;
}

export function verifyStopPrereg(a) {
  const expected = sha256short(stable(a));
  return { ok: expected === a.artifact_hash, expected, found: a.artifact_hash };
}

// CLI: node scripts/coil-stop-prereg.mjs --instances data/lab/coil-stop-instances.json --out data/lab/coil-stop-prereg.json
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const inst = JSON.parse(readFileSync(flag('--instances', 'data/lab/coil-stop-instances.json'), 'utf8'));
    const marginal = inst.marginal || [];
    const trainN = marginal.filter(r => r.split === 'train').length;
    const holdoutN = marginal.filter(r => r.split === 'holdout').length;
    const a = buildStopPrereg({ marginalN: marginal.length, trainN, holdoutN });
    const out = flag('--out', 'data/lab/coil-stop-prereg.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(a, null, 2));
    process.stdout.write(`wrote ${out} (hash ${a.artifact_hash})\n`);
  }
}
