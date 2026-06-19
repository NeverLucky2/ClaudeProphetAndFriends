// scripts/eov-prereg.mjs
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

export function buildEovPrereg({ trainN, holdoutN, validDatesN, splitBoundary, createdUtc }) {
  const a = {
    prereg_version: '1.0',
    created_utc: createdUtc ?? new Date().toISOString(),
    hypothesis: 'reduced-EOV (call-volume intensity, half-signal: no OI) has uncertain tradable forward edge on 20 heavily-optioned mega-caps, in either direction',
    signal: { definition: 'CallVol(T)/mean(CallVol(T-21..T-1))', window: 21, half: 'callvol_over_trailing_only', oi_half: 'unavailable' },
    universe: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AMD', 'NFLX', 'ADBE', 'BABA', 'SHOP', 'PYPL', 'ROKU', 'MRNA', 'BA', 'WMT', 'JPM', 'ZM', 'EBAY'],
    benchmark: 'QQQ', benchmark_robustness: 'SPY',
    confirmatory_cell: { construction: 'long_short_top5_minus_bottom5', h: 3, k: 5, beta_neutralized: true },
    horizons_exploratory: [1, 5],
    timing: 'signal day T (post-close) -> enter T+1 open, exit T+1+h open, open-to-open, adjustment=all',
    min_names_per_date: 12,
    friction_bps: { equity: { optimistic: 1, decision: 2, stress: 5 } },
    friction_model: 'spread_net = gross - 4*bps/1e4; leg_net = gross - 2*bps/1e4 (no overlap netting, conservative)',
    beta: 'spread-vs-QQQ and per-name-vs-QQQ OLS on TRAIN daily returns, frozen, applied to holdout',
    bootstrap: { method: 'date_block', block_sessions: 15, iterations: 10000, seed: 1234, ci_pct: [2.5, 97.5] },
    direction_rule: "d* = sign(mean train beta-neutral spread_resid at h=3); REJECT(NO-SIGNAL) unless train oriented CI lo>0",
    decision_rule: {
      gate_a: 'holdout beta-neutral spread_resid oriented (by d*) 95% CI lo>0',
      gate_b: 'held-leg (top if d*>0 else bottom) pooled per-name beta-adjusted alpha 95% CI lo>0',
      robustness: 'spread_resid same sign as d* at h=1 and h=5 (supportive, non-gating)',
      verdict: 'KEEP-CANDIDATE iff train-signal & gate_a & gate_b & not underpowered; else REJECT',
    },
    power_floor: { distinct_dates: 100, name_trades: 200 },
    split: 'chronological 70/30 on valid formation dates (h=3)',
    counts: { train_n: trainN, holdout_n: holdoutN, valid_dates_n: validDatesN, split_boundary: splitBoundary },
    limitations: ['half-signal-no-OI', '~2.3yr-thin-holdout', 'enumeration-survivorship', 'options-bar-volume-consolidation-unverified', 'train-beta-stability'],
    expected_outcome: 'REJECT',
  };
  a.artifact_hash = sha256short(stable(a));
  return a;
}

export function verifyEovPrereg(a) {
  const expected = sha256short(stable(a));
  return { ok: expected === a.artifact_hash, expected, found: a.artifact_hash };
}

{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const bundle = JSON.parse(readFileSync(flag('--instances', 'data/lab/eov-instances.json'), 'utf8'));
    const a = buildEovPrereg({ trainN: bundle.meta.trainN, holdoutN: bundle.meta.holdoutN, validDatesN: bundle.meta.validDates.length, splitBoundary: bundle.meta.splitBoundary });
    const out = flag('--out', 'data/lab/eov-prereg.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(a, null, 2));
    process.stdout.write(`wrote ${out} (hash ${a.artifact_hash})\n`);
  }
}
