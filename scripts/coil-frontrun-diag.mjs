// scripts/coil-frontrun-diag.mjs
// EXPLORATORY historical diagnostic for the front-run thesis.
//
// C1 — conversion rate by year and vol tercile (the mechanism; a count statistic, real power).
// C2/C3 — shallow and deep friction-net return trends (the economics; a return statistic,
//         almost no power). Reported because their DIRECTIONS discriminate the rival stories:
//           operator's story    -> shallow up,  deep flat  => enter earlier
//           adverse selection   -> shallow flat, deep down => do NOT enter earlier
//           mechanism-only      -> both flat               => change nothing
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFriction, mean, bootstrapMeanCI, bootstrapDiffCI } from './coil-threshold-metrics.mjs';
import { tercileOf } from './coil-frontrun-vol.mjs';

const BOOT = { blockSessions: 15, iterations: 10000, seed: 1234 };
const RESOLVED = (e) => e.outcome === 'FIRE' || e.outcome === 'BOUNCE';
const binRows = (eps) => eps.map(e => ({ date: e.date, net: e.outcome === 'FIRE' ? 1 : 0 }));

function convCell(eps) {
  const r = eps.filter(RESOLVED);
  if (!r.length) return { n: 0, fire: 0, bounce: 0, rate: null, lo: null, hi: null };
  const ci = bootstrapMeanCI(binRows(r), BOOT);
  return {
    n: r.length,
    fire: r.filter(e => e.outcome === 'FIRE').length,
    bounce: r.filter(e => e.outcome === 'BOUNCE').length,
    rate: ci.mean, lo: ci.lo, hi: ci.hi,
  };
}

export function conversionByYear(episodes) {
  const out = {};
  for (const y of [...new Set(episodes.map(e => e.date.slice(0, 4)))].sort()) {
    out[y] = convCell(episodes.filter(e => e.date.startsWith(y)));
  }
  return out;
}

export function conversionByTercile(episodes, boundaries) {
  const out = {};
  for (const t of ['low', 'mid', 'high']) {
    out[t] = convCell(episodes.filter(e => tercileOf(e.vol, boundaries) === t));
  }
  return out;
}

export function returnTrendByYear(instances, bps = 20) {
  const usable = instances.filter(r => !r.censored && Number.isFinite(r.grossReturn));
  const out = {};
  for (const y of [...new Set(usable.map(r => r.date.slice(0, 4)))].sort()) {
    const rows = usable.filter(r => r.date.startsWith(y));
    const toRows = (rs) => rs.map(r => ({ date: r.date, net: applyFriction(r.grossReturn, bps) }));
    const deep = toRows(rows.filter(r => r.bucket === '[0,5)'));
    const shallow = toRows(rows.filter(r => r.bucket !== '[0,5)'));
    const gap = (deep.length && shallow.length)
      ? bootstrapDiffCI(deep, shallow, BOOT)      // CI on (shallow - deep)
      : { mean: null, lo: null, hi: null };
    out[y] = {
      deep: { n: deep.length, mean: mean(deep.map(r => r.net)) },
      shallow: { n: shallow.length, mean: mean(shallow.map(r => r.net)) },
      gap: { mean: gap.mean, lo: gap.lo, hi: gap.hi },
    };
  }
  return out;
}

const pct = (x) => (x == null ? 'n/a' : (x * 100).toFixed(2) + '%');
const rate = (x) => (x == null ? 'n/a' : (x * 100).toFixed(1) + '%');

export function renderDiag({ byYear, byTercile, returns, prereg }) {
  const L = [];
  L.push('# Coil Front-Run Diagnostic — Results', '');
  L.push('> **EXPLORATORY.** This sample\'s holdout was already spent on the RSI-threshold study');
  L.push('> (`08a17a3`). These results set a prior. They are **not** a confirmatory test and');
  L.push('> must not drive a live Coil change. The confirmatory test is the forward monitor');
  L.push('> (`coil-frontrun-monitor.mjs`), whose rule is frozen in prereg hash');
  L.push(`> \`${prereg.artifact_hash}\` with benchmark conversion rate ${rate(prereg.benchmark_conversion_rate)}.`, '');

  L.push('## C1 — conversion rate by year', '');
  L.push('`conversion = FIRE / (FIRE + BOUNCE)`. A **declining** rate is the front-run signature.', '');
  L.push('| year | n resolved | fire | bounce | rate | 95% CI |', '|---|---|---|---|---|---|');
  for (const [y, c] of Object.entries(byYear)) {
    L.push(`| ${y} | ${c.n} | ${c.fire} | ${c.bounce} | ${rate(c.rate)} | [${rate(c.lo)}, ${rate(c.hi)}] |`);
  }
  L.push('');

  L.push('## C1 — conversion rate by SPY volatility tercile', '');
  L.push('Low-vol regimes produce fewer deep-oversold events regardless of crowding. A decline that');
  L.push('appears **only** in one tercile is a volatility artifact, not front-running.', '');
  L.push('| tercile | n resolved | fire | bounce | rate | 95% CI |', '|---|---|---|---|---|---|');
  for (const t of ['low', 'mid', 'high']) {
    const c = byTercile[t];
    L.push(`| ${t} | ${c.n} | ${c.fire} | ${c.bounce} | ${rate(c.rate)} | [${rate(c.lo)}, ${rate(c.hi)}] |`);
  }
  L.push('');

  L.push('## C2 / C3 — shallow and deep friction-net edge by year', '');
  L.push('**Underpowered by construction** (per-trade σ ≈ 4–5%; MDE ≈ 1.6–2.0%/trade). Read the');
  L.push('*directions*, never the point estimates. Story discrimination:', '');
  L.push('- shallow ↑, deep flat → operator\'s story (crowd front-runs; entering earlier would pay)');
  L.push('- shallow flat, deep ↓ → adverse selection (only toxic dips reach RSI<5; do **not** enter earlier)');
  L.push('- both flat → mechanism-only (front-running real, edge already competed away; change nothing)', '');
  L.push('| year | deep n | deep net | shallow n | shallow net | gap (shallow−deep) | 95% CI |', '|---|---|---|---|---|---|---|');
  for (const [y, r] of Object.entries(returns)) {
    L.push(`| ${y} | ${r.deep.n} | ${pct(r.deep.mean)} | ${r.shallow.n} | ${pct(r.shallow.mean)} | ${pct(r.gap.mean)} | [${pct(r.gap.lo)}, ${pct(r.gap.hi)}] |`);
  }
  L.push('');

  L.push('## Limitations', '');
  L.push('- Exploratory: this sample\'s holdout is spent. No verdict is drawn here.');
  L.push('- Survivorship: today\'s 80-name universe only.');
  L.push('- Conversion uses **no earnings filter** (price-dynamics question); the return metrics do');
  L.push('  (they mirror Coil\'s tradeable set). The two populations therefore differ.');
  L.push('- Conversion measures **signal** conversion, not Coil fills — the ≤4-position cap means a');
  L.push('  converted signal need not become a Coil trade.');
  L.push('- Yearly deep-bucket n is ~80. Those CIs are wide. Do not over-read a single cell.');
  return L.join('\n');
}

// CLI: node scripts/coil-frontrun-diag.mjs
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const episodes = JSON.parse(readFileSync(flag('--episodes', 'data/lab/coil-frontrun-episodes.json'), 'utf8'));
    const prereg = JSON.parse(readFileSync(flag('--prereg', 'data/lab/coil-frontrun-prereg.json'), 'utf8'));
    const instances = JSON.parse(readFileSync(flag('--instances', 'data/lab/coil-threshold-instances.json'), 'utf8'));
    const hist = episodes.filter(e => e.date < prereg.forward_window_start);
    const md = renderDiag({
      byYear: conversionByYear(hist),
      byTercile: conversionByTercile(hist, prereg.vol_tercile_boundaries),
      returns: returnTrendByYear(instances, 20),
      prereg,
    });
    const out = flag('--out', 'docs/lab/coil-frontrun-diag-RESULTS.md');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md);
    process.stdout.write(`wrote ${out}\n`);
  }
}
