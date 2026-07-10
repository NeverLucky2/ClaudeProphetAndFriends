// scripts/coil-frontrun-prereg.mjs
// Hash-locked pre-registration for the Coil front-run monitor. Mirrors coil-threshold-prereg.
//
// The one invariant that makes the forward test confirmatory: the rule is frozen before any
// forward observation exists. Measuring the past to set the benchmark and size the gate cannot
// violate that — the forward window is empty at the time.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256short } from './coil-eventstudy-prereg.mjs';
import { stable } from './coil-threshold-prereg.mjs';
import { tercileBoundaries, VOL_WINDOW } from './coil-frontrun-vol.mjs';
import { FIRE_MAX, NEAR_MISS_HI, RESOLUTION_CAP } from './coil-nearmiss-enum.mjs';

export function conversionRate(episodes) {
  const resolved = episodes.filter(e => e.outcome === 'FIRE' || e.outcome === 'BOUNCE');
  if (!resolved.length) return null;
  return resolved.filter(e => e.outcome === 'FIRE').length / resolved.length;
}

export function buildFrontrunPrereg({ episodes, forwardWindowStart, nGate = 200, createdUtc }) {
  const hist = episodes.filter(e => e.date < forwardWindowStart);
  const histResolved = hist.filter(e => e.outcome === 'FIRE' || e.outcome === 'BOUNCE');
  const a = {
    prereg_version: '1.0',
    created_utc: createdUtc ?? new Date().toISOString(),
    hypothesis:
      'Coil\'s RSI(2)<5 trigger is increasingly front-run: near-miss episodes convert to fires ' +
      'LESS often in the forward window than historically (expected null: no change)',
    near_miss_band: [FIRE_MAX, NEAR_MISS_HI],
    fire_threshold: FIRE_MAX,
    gates: 'close > SMA200 AND close < SMA5 (entryFiresAt strict gates)',
    bounce_definition: 'close > SMA5',
    resolution_cap: RESOLUTION_CAP,
    enumeration: 'fresh-signal episodes; no new episode starts inside a resolving one',
    earnings_filter: 'NOT applied — conversion is a price-dynamics question',
    vol_control: { series: 'SPY', window_sessions: VOL_WINDOW, strata: ['low', 'mid', 'high'] },
    vol_tercile_boundaries: tercileBoundaries(hist.map(e => e.vol)),
    benchmark_conversion_rate: conversionRate(hist),
    forward_window_start: forwardWindowStart,
    bootstrap: { method: 'date_block', block_sessions: 15, iterations: 10000, seed: 1234, ci_pct: [2.5, 97.5] },
    decision_rule: {
      gate1: 'n >= n_gate resolved forward episodes',
      gate2: 'pooled bootstrapDiffCI(historical, forward) on binary FIRE outcome has hi < 0',
      gate3: 'the same diff has hi < 0 in at least 2 of the 3 vol terciles',
      verdict: 'SUPPORTED iff gate1 AND gate2 AND gate3; UNDERPOWERED if !gate1; else NOT_SUPPORTED',
    },
    n_gate: nGate,
    secondary_not_gating: [
      'forward vs trailing-12-month historical rate',
      'C2/C3 shallow and deep return trends',
    ],
    expected_outcome: 'NOT_SUPPORTED',
    counts: { historical_total: hist.length, historical_resolved: histResolved.length },
  };
  a.artifact_hash = sha256short(stable(a));
  return a;
}

export function verifyFrontrunPrereg(a) {
  const expected = sha256short(stable(a));
  return { ok: expected === a.artifact_hash, expected, found: a.artifact_hash };
}

// CLI: node scripts/coil-frontrun-prereg.mjs --episodes data/lab/coil-frontrun-episodes.json \
//        --forward-start 2026-07-09 --n-gate 200 --out data/lab/coil-frontrun-prereg.json
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const episodes = JSON.parse(readFileSync(flag('--episodes', 'data/lab/coil-frontrun-episodes.json'), 'utf8'));
    const forwardWindowStart = flag('--forward-start', null);
    if (!forwardWindowStart) { process.stderr.write('--forward-start YYYY-MM-DD is required\n'); process.exit(2); }
    const a = buildFrontrunPrereg({
      episodes, forwardWindowStart, nGate: Number(flag('--n-gate', '200')),
    });
    const out = flag('--out', 'data/lab/coil-frontrun-prereg.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(a, null, 2));
    process.stdout.write(`wrote ${out} (hash ${a.artifact_hash}, benchmark ${a.benchmark_conversion_rate}, historical resolved ${a.counts.historical_resolved})\n`);
  }
}
