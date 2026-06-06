// scripts/cef-score.mjs
// Orchestrator (controller-authored): prereg FIRST → CEF sleeve sim (full + train/holdout) →
// edge gate (8-week block bootstrap, 1x + 2x friction) + orthogonality gate (reuse the S1
// fleet-correlate engine vs QQQ + regenerated Coil/Turtle/Drift) → KEEP/REJECT → RESULTS.
// Reads data/lab caches (cef-cache + S1 fleet-bar-cache/fleet-earnings.json). Run: node scripts/cef-score.mjs --root .
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildPrereg, hashPrereg } from './cef-prereg.mjs';
import { allCefTickers, tierOf } from './cef-universe.mjs';
import { loadCefBars } from './cef-bars.mjs';
import { simulateCef } from './cef-sim.mjs';
import { loadFleetBars } from './fleet-bars.mjs';
import { TURTLE_ETFS } from './fleet-universe.mjs';
import { simulateTurtle } from './fleet-turtle-sim.mjs';
import { buildCoilSeries } from './fleet-coil-marks.mjs';
import { buildDriftSeries } from './fleet-drift-sim.mjs';
import { toWeekly } from './fleet-align.mjs';
import { pearson, betaTo, bootstrapBetaCI, crisisWeeks, crisisMean, crisisMeanCI, rhoCrisis, rotationBand } from './fleet-correlate.mjs';
import { bootstrapMeanCI } from './coil-threshold-metrics.mjs';

const START = '2021-01-01';
const END = '2026-06-06';
const f = (x, d = 3) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
const pc = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : (100 * x).toFixed(d) + '%');

function dailyRet(bars, start) {
  const out = [];
  for (let i = 1; i < bars.length; i += 1) if (bars[i].date >= start) out.push({ date: bars[i].date, ret: bars[i].close / bars[i - 1].close - 1, active: true });
  return out;
}
// weekly series -> Map<week, ret>
const wkMap = (weekly) => new Map(weekly.map((p) => [p.week, p.ret]));
// align named weekly series on common weeks -> { weeks:[...], vec:{name:[ret...]} }
function alignOnWeek(byName) {
  const maps = Object.fromEntries(Object.entries(byName).map(([n, w]) => [n, wkMap(w)]));
  const names = Object.keys(maps);
  const weeks = [...maps[names[0]].keys()].filter((wk) => names.every((n) => maps[n].has(wk))).sort();
  const vec = {}; for (const n of names) vec[n] = weeks.map((wk) => maps[n].get(wk));
  return { weeks, vec };
}

{
  const args = process.argv.slice(2);
  const root = (() => { const i = args.indexOf('--root'); return i >= 0 ? args[i + 1] : process.cwd(); })();

  // 1) prereg FIRST
  const prereg = buildPrereg(); const preregHash = hashPrereg(prereg);
  mkdirSync(join(root, 'data', 'lab'), { recursive: true });
  writeFileSync(join(root, 'data', 'lab', 'cef-prereg.json'), JSON.stringify({ ...prereg, sha256: preregHash }, null, 2));

  // 2) CEF sleeve sim (1x and 2x friction)
  const barsByTicker = new Map(); const tierByTicker = {};
  let nNames = 0;
  for (const t of allCefTickers()) { const b = loadCefBars(root, t); if (b.length > 60) { barsByTicker.set(t, b); tierByTicker[t] = tierOf(t); nNames += 1; } }
  const simOpts = { L: 52, zEnter: 1.5, timeStop: 26, maxPositions: 10, tierByTicker };
  const sim1 = simulateCef(barsByTicker, { ...simOpts, stressMult: 1 });
  const sim2 = simulateCef(barsByTicker, { ...simOpts, stressMult: 2 });
  const cefWk = toWeekly(sim1.weekly);          // ISO-week keyed sleeve (net 1x)
  const cefWk2 = toWeekly(sim2.weekly);
  const mid = Math.floor(cefWk.length / 2);
  const splitWeek = cefWk[mid] ? cefWk[mid].week : null;
  const trainWk = cefWk.slice(0, mid); const holdoutWk = cefWk.slice(mid);
  const holdoutWk2 = cefWk2.slice(mid);

  // 3) Edge gate — holdout 8-week block bootstrap (reuse bootstrapMeanCI: blockSessions=8 distinct weeks)
  const toRows = (wk) => wk.map((p) => ({ date: p.week, net: p.ret }));
  const edge1 = bootstrapMeanCI(toRows(holdoutWk), { blockSessions: 8, iterations: 2000, seed: 7 });
  const edge2 = bootstrapMeanCI(toRows(holdoutWk2), { blockSessions: 8, iterations: 2000, seed: 7 });
  const trainMean = trainWk.length ? trainWk.reduce((a, p) => a + p.ret, 0) / trainWk.length : null;
  // independent discount-widening episodes: entry-weeks with >=3 new trades
  const entriesByWeek = new Map();
  for (const tr of sim1.trades) { const wk = tr.entryDate; entriesByWeek.set(wk, (entriesByWeek.get(wk) || 0) + 1); }
  const episodes = [...entriesByWeek.values()].filter((c) => c >= 3).length;

  // 4) Orthogonality gate — align sleeve to QQQ + regenerated lanes on ISO week
  const earnPath = join(root, 'data', 'lab', 'fleet-earnings.json');
  const earnings = existsSync(earnPath) ? JSON.parse(readFileSync(earnPath, 'utf8')) : {};
  const qqqWk = toWeekly(dailyRet(loadFleetBars(root, 'QQQ'), START));
  const etfMap = new Map(TURTLE_ETFS.map((e) => [e.ticker, loadFleetBars(root, e.ticker)]));
  const turtleWk = toWeekly(simulateTurtle(etfMap, { start: START, end: END }));
  const coilWk = toWeekly(buildCoilSeries(root, { earningsByTicker: earnings, start: START }));
  const driftWk = toWeekly(buildDriftSeries(root, { earningsByTicker: earnings, start: START, end: END }));
  const aligned = alignOnWeek({ CEF: cefWk, QQQ: qqqWk, Coil: coilWk, Turtle: turtleWk, Drift: driftWk });
  const S = aligned.vec.CEF, Q = aligned.vec.QQQ;
  const beta = betaTo(S, Q); const betaCI = bootstrapBetaCI(S, Q, { seed: 7 });
  const corr = pearson(S, Q);
  const qWeekly = Q.map((r) => ({ ret: r })); const sWeekly = S.map((r) => ({ ret: r }));
  const crIdx = crisisWeeks(qWeekly, 'quintile');
  const crMean = crisisMean(sWeekly, crIdx); const crCI = crisisMeanCI(sWeekly, crIdx, { seed: 7 });
  const rc = rhoCrisis(sWeekly, qWeekly, crIdx); const band = rotationBand(sWeekly, qWeekly, crIdx, 'rho', { K: 1000, seed: 7 });
  const laneRho = { Coil: pearson(S, aligned.vec.Coil), Turtle: pearson(S, aligned.vec.Turtle), Drift: pearson(S, aligned.vec.Drift) };

  // 5) Decomposition + regime-chase
  const tr = sim1.trades;
  const meanNav = tr.length ? tr.reduce((a, x) => a + x.navMove, 0) / tr.length : null;
  const meanDisc = tr.length ? tr.reduce((a, x) => a + x.discountChange, 0) / tr.length : null;
  const meanNet = tr.length ? tr.reduce((a, x) => a + x.netReturn, 0) / tr.length : null;
  const byYear = {};
  for (const x of tr) { const y = x.entryDate.slice(0, 4); (byYear[y] ??= []).push(x.netReturn); }
  const regime = Object.entries(byYear).sort().map(([y, arr]) => ({ year: y, n: arr.length, meanNet: arr.reduce((a, b) => a + b, 0) / arr.length }));

  // 6) Verdict (dual gate)
  const edgePass = edge1.lo != null && edge1.lo > 0;
  const betaPass = (betaCI.lo != null && betaCI.lo <= 0 && betaCI.hi >= 0) || Math.abs(beta) < 0.2;
  const crisisPass = crCI.hi != null && crCI.hi >= 0;          // not entirely below 0
  const lanePass = ['Coil', 'Turtle', 'Drift'].every((n) => laneRho[n] != null && Math.abs(laneRho[n]) < 0.3);
  const keep = edgePass && betaPass && crisisPass && lanePass;
  const reasons = [];
  if (!edgePass) reasons.push('edge gate FAIL (holdout net CI lower bound ≤ 0)');
  if (!betaPass) reasons.push(`equity-β too high (β=${f(beta)})`);
  if (!crisisPass) reasons.push('co-crashes (crisis-mean CI entirely < 0)');
  if (!lanePass) reasons.push('redundant (|ρ| ≥ 0.3 to a lane)');

  // 7) RESULTS
  const L = [];
  L.push('# CEF Discount-Reversion — RESULTS', '');
  L.push(`**Pre-registration hash (sha256):** \`${preregHash}\``);
  L.push(`**VERDICT: ${keep ? 'KEEP' : 'REJECT'}**${keep ? '' : ' — ' + reasons.join('; ')}`, '');
  L.push('> Reconstructed PAPER returns. **Return basis = price-change** (NAV-move + Δdiscount), friction-NET; **excludes distribution yield (conservative; yield unavailable from CEFConnect)**. Edge gate = holdout weekly sleeve, 8-week block bootstrap, 1× and 2× friction. Orthogonality reuses the S1 `fleet-correlate` engine.', '');
  L.push('> ⚠️ **Survivorship bias (upward / toward false-KEEP):** the universe is a 2026 current-snapshot; CEFs that liquidated/merged by 2026 — disproportionately distressed wide-discount names that did NOT recover — are invisible. ⚠️ **Regime caveat:** the train/holdout midpoint straddles the 2022–23 rate-regime break; the train half is reported alongside.', '');
  L.push(`**Universe:** ${nNames} CEFs with > 60 weekly bars. **Sleeve weeks:** ${cefWk.length} (split @ ${splitWeek}). **Trades:** ${tr.length}. **Independent widening episodes (≥3 simultaneous entries):** ${episodes}.`, '');
  L.push('## Edge gate (holdout)', '');
  L.push('| friction | n weeks | mean weekly | 95% CI | pass? |', '|---|--:|--:|:--|:--|');
  L.push(`| 1× (net) | ${edge1.n} | ${pc(edge1.mean)} | [${pc(edge1.lo)}, ${pc(edge1.hi)}] | ${edge1.lo > 0 ? 'YES' : 'no'} |`);
  L.push(`| 2× (stress) | ${edge2.n} | ${pc(edge2.mean)} | [${pc(edge2.lo)}, ${pc(edge2.hi)}] | ${edge2.lo > 0 ? 'YES' : 'no'} |`);
  L.push(`| train half (ref) | ${trainWk.length} | ${pc(trainMean)} | — | — |`, '');
  L.push('## Orthogonality gate (vs QQQ + fleet lanes, weekly)', '');
  L.push('| metric | value | bar | pass? |', '|---|--:|:--|:--|');
  L.push(`| β to QQQ | ${f(beta)} [${f(betaCI.lo)}, ${f(betaCI.hi)}] | CI brackets 0 or \\|β\\|<0.2 | ${betaPass ? 'YES' : 'no'} |`);
  L.push(`| ρ to QQQ | ${f(corr)} | — | — |`);
  L.push(`| crisis mean (QQQ worst-quintile) | ${pc(crMean)} [${pc(crCI.lo)}, ${pc(crCI.hi)}] | CI not entirely <0 | ${crisisPass ? 'YES' : 'no'} |`);
  L.push(`| ρ_crisis (vs rot band p5/p95) | ${f(rc)} [${f(band.p5)}, ${f(band.p95)}] | descriptive | — |`);
  L.push(`| ρ to Coil / Turtle / Drift | ${f(laneRho.Coil)} / ${f(laneRho.Turtle)} / ${f(laneRho.Drift)} | each \\|ρ\\|<0.3 | ${lanePass ? 'YES' : 'no'} |`, '');
  L.push('## Return decomposition (per-trade means) + regime-chase', '');
  L.push(`- Mean per-trade: **net ${pc(meanNet)}** = NAV-move ${pc(meanNav)} + Δdiscount ${pc(meanDisc)} − friction. (If the edge is mostly NAV-move, it's underlying drift, not reversion.)`);
  for (const r of regime) L.push(`- Entries ${r.year}: n=${r.n}, mean net ${pc(r.meanNet)}${(r.year === '2022' || r.year === '2023') ? '  ← rate-regime re-rating window (mean-reversion-into-a-break risk)' : ''}`);
  L.push('');
  const md = L.join('\n') + '\n';
  mkdirSync(join(root, 'docs', 'lab'), { recursive: true });
  writeFileSync(join(root, 'docs', 'lab', 'cef-discount-reversion-RESULTS.md'), md, { encoding: 'utf-8' });
  process.stdout.write(`prereg ${preregHash}\nVERDICT: ${keep ? 'KEEP' : 'REJECT'}${keep ? '' : ' — ' + reasons.join('; ')}\n`);
  process.stdout.write(`edge1x net mean ${pc(edge1.mean)} CI[${pc(edge1.lo)},${pc(edge1.hi)}] | beta ${f(beta)} [${f(betaCI.lo)},${f(betaCI.hi)}] | crisisMean ${pc(crMean)} [${pc(crCI.lo)},${pc(crCI.hi)}] | laneRho C${f(laneRho.Coil)} T${f(laneRho.Turtle)} D${f(laneRho.Drift)} | trades ${tr.length}\n`);
}
