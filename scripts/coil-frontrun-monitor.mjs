// scripts/coil-frontrun-monitor.mjs
// CONFIRMATORY forward monitor for the front-run thesis. Reads the frozen pre-registration,
// splits episodes at forward_window_start, and applies the pre-registered decision rule.
// Refuses to emit a verdict on a prereg-hash mismatch.
//
// A SUPPORTED verdict licenses exactly one thing: proposing a separate, pre-registered
// threshold study with a fresh holdout. It does NOT license changing Coil, and it does not
// imply "enter earlier" — see the spec's rival-stories table.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapDiffCI } from './coil-threshold-metrics.mjs';
import { tercileOf } from './coil-frontrun-vol.mjs';
import { verifyFrontrunPrereg } from './coil-frontrun-prereg.mjs';

const RESOLVED = (e) => e.outcome === 'FIRE' || e.outcome === 'BOUNCE';
const binRows = (eps) => eps.map(e => ({ date: e.date, net: e.outcome === 'FIRE' ? 1 : 0 }));
const passes = (ci) => !!(ci && Number.isFinite(ci.hi) && ci.hi < 0);

export function decideFrontrun({ nForward, pooled, byTercile, nGate }) {
  const gate1 = nForward >= nGate;
  if (!gate1) return { verdict: 'UNDERPOWERED', reason: `n=${nForward} < ${nGate}`, gate1, gate2: false, gate3: false };
  const gate2 = passes(pooled);
  const nPass = ['low', 'mid', 'high'].filter(t => passes(byTercile[t])).length;
  const gate3 = nPass >= 2;
  if (gate2 && gate3) return { verdict: 'SUPPORTED', reason: `pooled hi<0 and ${nPass}/3 terciles hi<0`, gate1, gate2, gate3 };
  return { verdict: 'NOT_SUPPORTED', reason: `gate2=${gate2} gate3=${gate3} (${nPass}/3 terciles)`, gate1, gate2, gate3 };
}

export function monitor(episodes, prereg) {
  const v = verifyFrontrunPrereg(prereg);
  if (!v.ok) throw new Error(`prereg hash mismatch (expected ${v.expected}, found ${v.found})`);

  const boot = {
    blockSessions: prereg.bootstrap.block_sessions,
    iterations: prereg.bootstrap.iterations,
    seed: prereg.bootstrap.seed,
  };
  const start = prereg.forward_window_start;
  const hist = episodes.filter(e => e.date < start && RESOLVED(e));
  const fwd = episodes.filter(e => e.date >= start && RESOLVED(e));

  const pooled = (hist.length && fwd.length) ? bootstrapDiffCI(binRows(hist), binRows(fwd), boot) : { lo: null, hi: null, mean: null };
  const byTercile = {};
  for (const t of ['low', 'mid', 'high']) {
    const h = hist.filter(e => tercileOf(e.vol, prereg.vol_tercile_boundaries) === t);
    const f = fwd.filter(e => tercileOf(e.vol, prereg.vol_tercile_boundaries) === t);
    byTercile[t] = (h.length && f.length) ? bootstrapDiffCI(binRows(h), binRows(f), boot) : { lo: null, hi: null, mean: null };
  }

  // SECONDARY, never decision-gating: forward vs the TRAILING-12-MONTH historical rate.
  // This is the guard against trend continuation — if the pooled benchmark was already falling,
  // the primary test can be satisfied without any new front-running.
  // Same month/day one year earlier; string comparison only, so no Date math is needed.
  const t12Start = `${Number(start.slice(0, 4)) - 1}${start.slice(4)}`;
  const hist12 = hist.filter(e => e.date >= t12Start);
  const trailing12 = (hist12.length && fwd.length)
    ? bootstrapDiffCI(binRows(hist12), binRows(fwd), boot)
    : { lo: null, hi: null, mean: null };
  const trailing12Rate = hist12.length ? hist12.filter(e => e.outcome === 'FIRE').length / hist12.length : null;

  const decision = decideFrontrun({ nForward: fwd.length, pooled, byTercile, nGate: prereg.n_gate });
  // Realized MDE: half the pooled CI width — the smallest shift this run could have detected.
  const mde = (pooled.lo != null && pooled.hi != null) ? (pooled.hi - pooled.lo) / 2 : null;
  const forwardRate = fwd.length ? fwd.filter(e => e.outcome === 'FIRE').length / fwd.length : null;

  return {
    nForward: fwd.length, nHistorical: hist.length, forwardRate,
    pooled, byTercile, trailing12, trailing12Rate, decision, mde,
  };
}

const rate = (x) => (x == null ? 'n/a' : (x * 100).toFixed(1) + '%');
const pp = (x) => (x == null ? 'n/a' : (x * 100).toFixed(1) + 'pp');

export function renderMonitor({ prereg, result }) {
  const L = [];
  L.push('# Coil Front-Run Monitor — Results', '');
  L.push(`**Verdict: ${result.decision.verdict}** — ${result.decision.reason}`, '');
  L.push(`Pre-registered rule, hash \`${prereg.artifact_hash}\`. Forward window opens \`${prereg.forward_window_start}\`.`);
  L.push(`Benchmark (historical) conversion rate: **${rate(prereg.benchmark_conversion_rate)}**. Expected outcome: NOT_SUPPORTED.`, '');

  L.push('## Forward window', '');
  L.push(`- resolved forward episodes: **${result.nForward}** (gate: n ≥ ${prereg.n_gate})`);
  L.push(`- forward conversion rate: **${rate(result.forwardRate)}**`);
  L.push(`- pooled diff (forward − historical): ${pp(result.pooled.mean)}, 95% CI [${pp(result.pooled.lo)}, ${pp(result.pooled.hi)}]`);
  L.push(`- realized MDE at this n: ${pp(result.mde)}`, '');

  L.push('## Vol-tercile decomposition (gate 3: ≥2 of 3 with hi < 0)', '');
  L.push('| tercile | diff | 95% CI | passes |', '|---|---|---|---|');
  for (const t of ['low', 'mid', 'high']) {
    const c = result.byTercile[t];
    const ok = !!(c && Number.isFinite(c.hi) && c.hi < 0);
    L.push(`| ${t} | ${pp(c.mean)} | [${pp(c.lo)}, ${pp(c.hi)}] | ${ok ? 'yes' : 'no'} |`);
  }
  L.push('');

  L.push('## Secondary — forward vs trailing-12-month history (never decision-gating)', '');
  L.push(`- trailing-12-month historical conversion rate: **${rate(result.trailing12Rate)}**`);
  L.push(`- pooled benchmark conversion rate: **${rate(prereg.benchmark_conversion_rate)}**`);
  L.push(`- diff (forward − trailing-12m): ${pp(result.trailing12.mean)}, 95% CI [${pp(result.trailing12.lo)}, ${pp(result.trailing12.hi)}]`, '');
  L.push('If the pooled benchmark sits well **above** the trailing-12-month rate, the primary test can be');
  L.push('satisfied by trend continuation alone. Compare the two before believing a SUPPORTED verdict.', '');

  L.push('## How to read this', '');
  L.push('- A SUPPORTED verdict licenses **one** thing: proposing a separate, pre-registered threshold');
  L.push('  study with a fresh holdout. It does **not** license changing Coil.');
  L.push('- **It does not mean "enter earlier."** Adverse selection predicts the same conversion decline');
  L.push('  while the deep-band edge decays. Read C2/C3 in the diagnostic to tell the stories apart.');
  L.push('- **Trend continuation is the live risk.** If the historical yearly series was already');
  L.push('  declining, "forward < pooled historical" can be satisfied by a pre-existing trend that has');
  L.push('  nothing to do with AI adoption. Check the yearly series in');
  L.push('  `docs/lab/coil-frontrun-diag-RESULTS.md` against the secondary comparison above.');
  return L.join('\n');
}

// CLI: node scripts/coil-frontrun-monitor.mjs
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const episodes = JSON.parse(readFileSync(flag('--episodes', 'data/lab/coil-frontrun-episodes.json'), 'utf8'));
    const prereg = JSON.parse(readFileSync(flag('--prereg', 'data/lab/coil-frontrun-prereg.json'), 'utf8'));
    let result;
    try { result = monitor(episodes, prereg); }
    catch (e) { process.stderr.write(`REFUSING to score: ${e.message}\n`); process.exit(4); }
    const md = renderMonitor({ prereg, result });
    const out = flag('--out', 'docs/lab/coil-frontrun-monitor-RESULTS.md');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md);
    process.stdout.write(`VERDICT: ${result.decision.verdict} (${result.decision.reason}). Wrote ${out}\n`);
  }
}
