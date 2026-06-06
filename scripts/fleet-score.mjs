// scripts/fleet-score.mjs
// Orchestrator (controller-authored, data-coupled): prereg FIRST → build lane daily series →
// align/weekly → correlation/β + descriptive crisis cut → docs/lab/fleet-correlation-RESULTS.md.
// No network — reads the data/lab caches populated by fleet-fetch-bars / fleet-fetch-earnings.
// Run: node scripts/fleet-score.mjs --root .
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildPrereg, hashPrereg } from './fleet-prereg.mjs';
import { loadFleetBars } from './fleet-bars.mjs';
import { TURTLE_ETFS } from './fleet-universe.mjs';
import { simulateTurtle } from './fleet-turtle-sim.mjs';
import { buildCoilSeries } from './fleet-coil-marks.mjs';
import { buildDriftSeries } from './fleet-drift-sim.mjs';
import { simulateDefensiveProxy } from './fleet-defensive-proxy.mjs';
import { unionDates, alignDaily, toWeekly } from './fleet-align.mjs';
import {
  pearson, spearman, betaTo, bootstrapCorrCI, bootstrapBetaCI, zeroFraction, conditionalSeries,
  crisisWeeks, crisisMean, crisisMeanCI, rhoCrisis, downsideBeta, rotationBand, effectiveN,
} from './fleet-correlate.mjs';
import { classifyLane, tailNote, renderReport } from './fleet-report.mjs';

const END = '2026-06-06';
const SPARSE = 0.40;
const f2 = (x) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(2));

function benchSeries(bars, start, end) {
  const out = [];
  for (let i = 1; i < bars.length; i += 1) {
    if (bars[i].date < start || bars[i].date > end) continue;
    out.push({ date: bars[i].date, ret: bars[i].close / bars[i - 1].close - 1, active: true });
  }
  return out;
}
const vec = (weekly) => weekly.map((p) => p.ret);

function fullStats(weeklyLane, weeklyQQQ) {
  const sparse = zeroFraction(weeklyLane) > SPARSE;
  let x, y;
  if (sparse) { const c = conditionalSeries(weeklyLane, weeklyQQQ); x = c.x; y = c.y; }
  else { x = vec(weeklyLane); y = vec(weeklyQQQ); }
  const betaCI = bootstrapBetaCI(x, y, { seed: 1234 });
  const corrCI = bootstrapCorrCI(x, y, { seed: 1234 });
  return {
    sparse, n: x.length,
    fullBeta: betaTo(x, y), betaLo: betaCI.lo, betaHi: betaCI.hi,
    corr: pearson(x, y), corrLo: corrCI.lo, corrHi: corrCI.hi, spearman: spearman(x, y),
  };
}

function crisisStats(name, weeklyLane, weeklyQQQ) {
  const idx = crisisWeeks(weeklyQQQ, 'quintile');
  const ci = crisisMeanCI(weeklyLane, idx, { seed: 1234 });
  const band = rotationBand(weeklyLane, weeklyQQQ, idx, 'rho', { K: 1000, seed: 1234 });
  const rc = rhoCrisis(weeklyLane, weeklyQQQ, idx);
  const effN = effectiveN(weeklyLane, idx);
  return {
    name, effN, mean: crisisMean(weeklyLane, idx), meanLo: ci.lo, meanHi: ci.hi,
    rhoCrisis: rc, downsideBeta: downsideBeta(weeklyLane, weeklyQQQ, idx),
    bandP5: band.p5, bandP50: band.p50, bandP95: band.p95,
    note: tailNote({ crisisMeanLo: ci.lo, crisisMeanHi: ci.hi, rhoCrisis: rc, rhoBandP95: band.p95, effN }),
  };
}

function analyzeWindow(root, { name, start, lanes, earnings }) {
  const daily = {};
  if (lanes.includes('turtle')) daily.Turtle = simulateTurtle(new Map(TURTLE_ETFS.map((e) => [e.ticker, loadFleetBars(root, e.ticker)])), { start, end: END });
  if (lanes.includes('coil')) daily.Coil = buildCoilSeries(root, { earningsByTicker: earnings, start });
  if (lanes.includes('drift')) daily.Drift = buildDriftSeries(root, { earningsByTicker: earnings, start, end: END });
  if (lanes.includes('defensive_proxy')) daily.DefProxy = simulateDefensiveProxy(loadFleetBars(root, 'QQQ'), { start, end: END });
  daily.QQQ = benchSeries(loadFleetBars(root, 'QQQ'), start, END);
  daily.SPY = benchSeries(loadFleetBars(root, 'SPY'), start, END);

  const dates = unionDates(daily);
  const aligned = alignDaily(daily, dates);
  const weekly = {};
  for (const k of Object.keys(aligned)) weekly[k] = toWeekly(aligned[k]);
  const nWeeks = weekly.QQQ.length;

  const edgeNames = ['Coil', 'Turtle', 'Drift'].filter((n) => weekly[n]);
  const laneRows = edgeNames.map((n) => ({ name: n, ...fullStats(weekly[n], weekly.QQQ) }));
  for (const r of laneRows) r.class = classifyLane({ fullBeta: r.fullBeta, betaLo: r.betaLo, betaHi: r.betaHi });

  const crisisNames = [...edgeNames, ...(weekly.DefProxy ? ['DefProxy'] : [])];
  const crisisRows = crisisNames.map((n) => crisisStats(n, weekly[n], weekly.QQQ));

  const pairs = [];
  for (let i = 0; i < edgeNames.length; i += 1) for (let j = i + 1; j < edgeNames.length; j += 1) {
    const A = weekly[edgeNames[i]], B = weekly[edgeNames[j]];
    const aSparse = zeroFraction(A) > SPARSE, bSparse = zeroFraction(B) > SPARSE;
    const xs = [], ys = [];
    for (let k = 0; k < A.length; k += 1) { if ((aSparse && !A[k].active) || (bSparse && !B[k].active)) continue; xs.push(A[k].ret); ys.push(B[k].ret); }
    pairs.push({ pair: `${edgeNames[i]} × ${edgeNames[j]}`, pearson: pearson(xs, ys), spearman: spearman(xs, ys), n: xs.length });
  }

  const synthesis = [];
  for (const r of laneRows) {
    const c = crisisRows.find((x) => x.name === r.name);
    synthesis.push(`**${r.name}** — full-sample β ${f2(r.fullBeta)} (95% CI [${f2(r.betaLo)}, ${f2(r.betaHi)}]) → **${r.class}**; in QQQ's worst weeks: ${c.note} (mean ${(100 * c.mean).toFixed(2)}%, effN ${c.effN}).`);
  }
  if (weekly.DefProxy) { const c = crisisRows.find((x) => x.name === 'DefProxy'); synthesis.push(`**DefProxy (structural proxy)** — crisis mean ${(100 * c.mean).toFixed(2)}%, ${c.note}; designed long-vol hedge, proxy trigger, no full-sample claim.`); }
  const coCrash = crisisRows.filter((c) => c.name !== 'DefProxy' && (c.note === 'co_crashes' || c.note === 'co_crashes_with_tail_comove')).length;
  const cushions = crisisRows.filter((c) => c.name !== 'DefProxy' && c.note === 'cushions').length;
  const overt = laneRows.filter((r) => r.class === 'overt_long_beta').length;
  synthesis.push(`**Ballast gap:** ${overt}/${laneRows.length} edge lanes carry overt long-QQQ-β; in crisis weeks ${coCrash} co-crash vs ${cushions} cushion. ${coCrash >= cushions && coCrash > 0 ? 'Equity-selloff protection is thin → Subproject 2 should target a non-equity / idiosyncratic premium.' : 'See per-lane notes for where diversification holds vs evaporates.'}`);

  return { name, start, end: END, nWeeks, lanes: laneRows, crisisLanes: crisisRows, pairs, synthesis };
}

{
  const args = process.argv.slice(2);
  const root = (() => { const i = args.indexOf('--root'); return i >= 0 ? args[i + 1] : process.cwd(); })();

  const prereg = buildPrereg();
  const preregHash = hashPrereg(prereg);
  mkdirSync(join(root, 'data', 'lab'), { recursive: true });
  writeFileSync(join(root, 'data', 'lab', 'fleet-prereg.json'), JSON.stringify({ ...prereg, sha256: preregHash }, null, 2));

  const earnPath = join(root, 'data', 'lab', 'fleet-earnings.json');
  const earnings = existsSync(earnPath) ? JSON.parse(readFileSync(earnPath, 'utf8')) : {};

  const windows = [
    analyzeWindow(root, { name: '4-way headline', start: '2022-01-01', lanes: ['coil', 'turtle', 'drift', 'defensive_proxy'], earnings }),
    analyzeWindow(root, { name: '3-way crisis extension', start: '2016-01-01', lanes: ['coil', 'turtle', 'defensive_proxy'], earnings }),
  ];

  const md = renderReport(windows, { preregHash });
  mkdirSync(join(root, 'docs', 'lab'), { recursive: true });
  writeFileSync(join(root, 'docs', 'lab', 'fleet-correlation-RESULTS.md'), md, { encoding: 'utf-8' });
  process.stdout.write(`prereg ${preregHash}\nRESULTS: docs/lab/fleet-correlation-RESULTS.md\n`);
  for (const w of windows) { process.stdout.write(`\n[${w.name}] ${w.nWeeks} weeks\n`); for (const l of w.lanes) process.stdout.write(`  ${l.name}: n=${l.n} beta=${f2(l.fullBeta)} class=${l.class}\n`); }
}
