// scripts/orb-prereg.mjs
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256short } from './coil-eventstudy-prereg.mjs';

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => k !== 'artifact_hash').map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function buildOrbPrereg({ trainN, holdoutN, createdUtc }) {
  const a = {
    prereg_version: '1.0',
    created_utc: createdUtc ?? new Date().toISOString(),
    hypothesis: 'a daily-bar-free generic ORB on liquid ETFs has uncertain net + market-relative edge',
    primary: { or_minutes: 15, entry: 'next_bar_open', stop: 'or_opposite', exit: 'eod', target: 'none', vwap_filter: true, volume_filter: false },
    gated_metric: 'r_multiple',
    grid_train_only: { or_minutes: [5, 30], target: ['1R', '2R'], ema21_filter: [true], vwap_filter: [false], breakout_buffer_or_frac: [0.05] },
    friction_bps: { etf: { optimistic: 1, representative: 2, stress: 5, decision: 2 }, largecap: { optimistic: 5, central: 10, stress: 20, decision: 10 } },
    benchmark: 'SPY',
    beta: 'per-name OLS on TRAIN 5-min RTH returns vs SPY, frozen',
    bootstrap: { method: 'date_block', block_sessions: 15, iterations: 10000, seed: 1234, ci_pct: [2.5, 97.5] },
    decision_rule: {
      gate_net: 'holdout friction-net R-multiple 95% CI lo > 0 over ETF cut',
      gate_mktrel: 'holdout per-name-beta market-relative R-multiple 95% CI lo > 0 over ETF cut EX-SPY',
      gate_robust: 'both positive on train',
      verdict: 'KEEP-CANDIDATE iff all three else REJECT; UNDERPOWERED if holdout trades < 200 or distinct dates < 100',
    },
    power_floor: { trades: 200, distinct_dates: 100 },
    decision_universe: ['SPY', 'QQQ', 'IWM', 'DIA'],
    largecap_exploratory: ['AAPL', 'NVDA', 'TSLA', 'AMD', 'META'],
    iex_caveat: 'IEX inward-OR bias flatters ORB; any KEEP must be re-confirmed on SIP',
    split: 'chronological 50/50',
    counts: { train_n: trainN, holdout_n: holdoutN },
    expected_outcome: 'UNCERTAIN',
  };
  a.artifact_hash = sha256short(stable(a));
  return a;
}

export function verifyOrbPrereg(a) {
  const expected = sha256short(stable(a));
  return { ok: expected === a.artifact_hash, expected, found: a.artifact_hash };
}

{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const inst = JSON.parse(readFileSync(flag('--instances', 'data/lab/orb-instances.json'), 'utf8'));
    const a = buildOrbPrereg({ trainN: inst.filter(r => r.split === 'train').length, holdoutN: inst.filter(r => r.split === 'holdout').length });
    const out = flag('--out', 'data/lab/orb-prereg.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(a, null, 2));
    process.stdout.write(`wrote ${out} (hash ${a.artifact_hash})\n`);
  }
}
