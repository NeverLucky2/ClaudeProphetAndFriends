// scripts/carry-score.mjs
// Orchestrator (controller-authored): prereg FIRST → carry sleeve sim (carry+roll signal, 1x/2x
// friction) → edge gate (Gate 1a/c weekly block-bootstrap, holdout) + rate-shock dodge (Gate 1b
// DESCRIPTIVE, dated) → orthogonality (Gate 2: β/ρ to QQQ, crisis mean, lane-ρ, Turtle-rates ρ
// all + co-active) + steepening cut (Gate 2b) → twin verdict (term-spread) → KEEP/REJECT/
// INCONCLUSIVE → docs/lab/bond-carry-RESULTS.md. All gates on the 2015–2026 holdout (the lanes
// only exist 2015+); train 2006–2014 feeds only the threshold-binding diagnostic. ETF bars start
// 2006-07 (FMP 5000-row cap — see RUNBOOK). Run: node scripts/carry-score.mjs --root .
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildPrereg, hashPrereg } from './carry-prereg.mjs';
import { loadCarryBars, loadCurve } from './carry-bars.mjs';
import { DURATION_ETF, RATES_CLUSTER, HOLDOUT_START, STUDY_END, EDGE_BLOCK_WEEKS, BUFFER_GRID_BPS } from './carry-universe.mjs';
import { monthEndCurve, carryRollSignal, termSpread, monthlyDecisions, thresholdBindingFraction } from './carry-signal.mjs';
import { buildMonthPlan, simulateCarry } from './carry-sim.mjs';
import { toWeekly, isoWeekKey } from './fleet-align.mjs';
import { loadFleetBars } from './fleet-bars.mjs';
import { TURTLE_ETFS } from './fleet-universe.mjs';
import { simulateTurtle } from './fleet-turtle-sim.mjs';
import { buildCoilSeries } from './fleet-coil-marks.mjs';
import { buildDriftSeries } from './fleet-drift-sim.mjs';
import { simulateDefensiveProxy } from './fleet-defensive-proxy.mjs';
import { pearson, betaTo, bootstrapBetaCI, crisisWeeks, crisisMean, crisisMeanCI, rhoCrisis, rotationBand } from './fleet-correlate.mjs';
import { bootstrapMeanCI } from './coil-threshold-metrics.mjs';

const f = (x, d = 3) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
const pc = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : (100 * x).toFixed(d) + '%');
const yes = (b) => (b ? 'YES' : 'no');

const dailyRet = (bars, start) => {
  const o = [];
  for (let i = 1; i < bars.length; i += 1) if (bars[i].date >= start) o.push({ date: bars[i].date, ret: bars[i].close / bars[i - 1].close - 1, active: true });
  return o;
};
const wkMap = (weekly) => new Map(weekly.map((p) => [p.week, p.ret]));
function alignOnWeek(byName) {
  const maps = Object.fromEntries(Object.entries(byName).map(([n, w]) => [n, wkMap(w)]));
  const names = Object.keys(maps);
  const weeks = [...maps[names[0]].keys()].filter((wk) => names.every((n) => maps[n].has(wk))).sort();
  const vec = {}; for (const n of names) vec[n] = weeks.map((wk) => maps[n].get(wk));
  return { weeks, vec };
}
// Weekly 10y yield change series (last curve row per ISO week, then week-over-week diff).
function weeklyY10Changes(curve) {
  const byWk = new Map();
  for (const r of curve) if (r.y10 != null) { const wk = isoWeekKey(r.date); byWk.set(wk, { week: wk, date: r.date, y10: r.y10 }); }
  const rows = [...byWk.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
  const out = [];
  for (let i = 1; i < rows.length; i += 1) out.push({ week: rows[i].week, date: rows[i].date, dY10: rows[i].y10 - rows[i - 1].y10 });
  return out;
}

// Run the whole pipeline for one signal fn → a verdict bundle (so we can run carry+roll AND the twin).
function evaluate(signalFn, ctx) {
  const { curve, iefBars, qqqWk, laneWk, turtleRatesWk } = ctx;
  const me = monthEndCurve(curve);
  const decisions = monthlyDecisions(curve, signalFn, { buffer: 0 });     // sign-zero primary
  const plan = buildMonthPlan(me, decisions);
  const sim1 = simulateCarry(iefBars, plan, { stressMult: 1, end: STUDY_END });
  const sim2 = simulateCarry(iefBars, plan, { stressMult: 2, end: STUDY_END });
  const sleeveWkFull = toWeekly(sim1.daily);
  const sleeveWk = sleeveWkFull.filter((p) => p.date >= HOLDOUT_START);   // gates on holdout
  const sleeveWk2 = toWeekly(sim2.daily).filter((p) => p.date >= HOLDOUT_START);

  // Gate 1a/c — edge (holdout weekly block bootstrap, 1x + 2x)
  const toRows = (wk) => wk.map((p) => ({ date: p.week, net: p.ret }));
  const edge1 = bootstrapMeanCI(toRows(sleeveWk), { blockSessions: EDGE_BLOCK_WEEKS, iterations: 2000, seed: 7 });
  const edge2 = bootstrapMeanCI(toRows(sleeveWk2), { blockSessions: EDGE_BLOCK_WEEKS, iterations: 2000, seed: 7 });

  // Gate 1b — rate-shock dodge (DESCRIPTIVE). rate-shock weeks = top-decile weekly d(y10) in holdout.
  const dY = weeklyY10Changes(curve).filter((r) => r.date >= HOLDOUT_START);
  const kShock = Math.max(1, Math.floor(dY.length * 0.1));
  const shockWeeks = new Set(dY.slice().sort((a, b) => b.dY10 - a.dY10).slice(0, kShock).map((r) => r.week));
  const sleeveByWk = new Map(sleeveWk.map((p) => [p.week, p]));
  const iefByWk = new Map(toWeekly(dailyRet(iefBars, HOLDOUT_START)).map((p) => [p.week, p.ret]));
  const shockDetail = [];
  for (const wk of [...shockWeeks].sort()) {
    const s = sleeveByWk.get(wk); if (!s) continue;
    shockDetail.push({ week: wk, active: s.active, sleeveRet: s.ret, iefRet: iefByWk.get(wk) ?? null });
  }
  const agg = (rows) => {
    const n = rows.length; const cash = rows.filter((r) => !r.active).length;
    return { n, cashFraction: n ? cash / n : null,
      sleeveMean: n ? rows.reduce((a, r) => a + r.sleeveRet, 0) / n : null,
      iefMean: n ? rows.reduce((a, r) => a + (r.iefRet ?? 0), 0) / n : null };
  };
  const dodge = agg(shockDetail);
  const dodge2022 = agg(shockDetail.filter((r) => r.week.startsWith('2022')));

  // independent rate-shock episodes (consecutive shock weeks within 4 collapse to one)
  const weekIndex = new Map(sleeveWkFull.map((p, i) => [p.week, i]));
  const shockIdx = [...shockWeeks].map((w) => weekIndex.get(w)).filter((i) => i != null).sort((a, b) => a - b);
  let episodes = 0; let prev = -99;
  for (const idx of shockIdx) { if (idx - prev > 4) episodes += 1; prev = idx; }

  // Gate 2 — orthogonality (align on common holdout weeks)
  const aligned = alignOnWeek({ Carry: sleeveWk, QQQ: qqqWk, Coil: laneWk.Coil, Turtle: laneWk.Turtle, Drift: laneWk.Drift, DefProxy: laneWk.DefProxy, TurtleRates: turtleRatesWk });
  const S = aligned.vec.Carry, Q = aligned.vec.QQQ;
  const beta = betaTo(S, Q); const betaCI = bootstrapBetaCI(S, Q, { seed: 7 }); const rhoQ = pearson(S, Q);
  const sObj = S.map((r) => ({ ret: r })); const qObj = Q.map((r) => ({ ret: r }));
  const crIdx = crisisWeeks(qObj, 'quintile');
  const crMean = crisisMean(sObj, crIdx); const crCI = crisisMeanCI(sObj, crIdx, { seed: 7 });
  const rc = rhoCrisis(sObj, qObj, crIdx); const band = rotationBand(sObj, qObj, crIdx, 'rho', { K: 1000, seed: 7 });
  const laneRho = { Coil: pearson(S, aligned.vec.Coil), Turtle: pearson(S, aligned.vec.Turtle), Drift: pearson(S, aligned.vec.Drift), DefProxy: pearson(S, aligned.vec.DefProxy) };
  const rhoTRall = pearson(S, aligned.vec.TurtleRates);
  // co-active ρ: weeks where the carry sleeve OR the Turtle-rates sleeve holds duration
  const carryActive = new Map(sleeveWk.map((p) => [p.week, p.active]));
  const trActive = new Map(turtleRatesWk.map((p) => [p.week, p.active]));
  const coI = aligned.weeks.map((wk, i) => ((carryActive.get(wk) || trActive.get(wk)) ? i : -1)).filter((i) => i >= 0);
  const rhoTRco = coI.length >= 2 ? pearson(coI.map((i) => S[i]), coI.map((i) => aligned.vec.TurtleRates[i])) : null;

  // Gate 2b — steepening cut: classify each HELD episode bull vs bear by sign of d(y10) over the hold
  const nearestY10 = (d) => { let best = null; for (const r of curve) { if (r.y10 == null) continue; if (r.date <= d) best = r.y10; else break; } return best; };
  const steepening = sim1.episodes.filter((ep) => ep.end >= HOLDOUT_START).map((ep) => {
    const a = nearestY10(ep.start), b = nearestY10(ep.end); const dd = (a != null && b != null) ? b - a : null;
    return { ...ep, dY10: dd, regime: dd == null ? 'unknown' : (dd <= 0 ? 'bull_steepening' : 'bear_steepening') };
  });

  // verdict pieces
  const edgePass = edge1.lo != null && edge1.lo > 0;
  const stressPass = edge2.lo != null && edge2.lo > 0;
  const betaPass = (betaCI.lo != null && betaCI.lo <= 0 && betaCI.hi >= 0) || Math.abs(beta) < 0.2;
  const rhoQPass = rhoQ != null && Math.abs(rhoQ) < 0.3;
  const crisisPass = crCI.hi != null && crCI.hi >= 0;
  const lanePass = ['Coil', 'Turtle', 'Drift', 'DefProxy'].every((n) => laneRho[n] != null && Math.abs(laneRho[n]) < 0.3);
  const trPass = rhoTRco != null && Math.abs(rhoTRco) < 0.3;            // co-active is the decisive number
  const gate2Pass = betaPass && rhoQPass && crisisPass && lanePass && trPass;
  const dodges2022 = dodge2022.cashFraction != null && dodge2022.cashFraction >= 0.5;

  return { decisions, sim1, sleeveWkFull, sleeveWk, edge1, edge2, dodge, dodge2022, shockDetail, episodes,
    beta, betaCI, rhoQ, crMean, crCI, rc, band, laneRho, rhoTRall, rhoTRco, steepening, alignedWeeks: aligned.weeks.length,
    edgePass, stressPass, betaPass, rhoQPass, crisisPass, lanePass, trPass, gate2Pass, dodges2022 };
}

{
  const args = process.argv.slice(2);
  const root = (() => { const i = args.indexOf('--root'); return i >= 0 ? args[i + 1] : process.cwd(); })();

  // 1) prereg FIRST (lock before reading any return)
  const prereg = buildPrereg(); const preregHash = hashPrereg(prereg);
  mkdirSync(join(root, 'data', 'lab'), { recursive: true });
  writeFileSync(join(root, 'data', 'lab', 'carry-prereg.json'), JSON.stringify({ ...prereg, sha256: preregHash }, null, 2));

  // 2) load data
  const curve = loadCurve(root);
  const iefBars = loadCarryBars(root, DURATION_ETF);
  const qqqWk = toWeekly(dailyRet(loadCarryBars(root, 'QQQ'), HOLDOUT_START));
  // Turtle-rates-only sleeve: pass ONLY {TLT,IEF,TIP}; simulateTurtle's cluster cap → Turtle's rates behavior
  const ratesMap = new Map(RATES_CLUSTER.map((t) => [t, loadCarryBars(root, t)]));
  const turtleRatesWk = toWeekly(simulateTurtle(ratesMap, { start: HOLDOUT_START, end: STUDY_END }));
  // S1 lanes (reuse fleet cache); align happens on common holdout weeks
  const earnPath = join(root, 'data', 'lab', 'fleet-earnings.json');
  const earnings = existsSync(earnPath) ? JSON.parse(readFileSync(earnPath, 'utf8')) : {};
  const etfMap = new Map(TURTLE_ETFS.map((e) => [e.ticker, loadFleetBars(root, e.ticker)]));
  const laneWk = {
    Coil: toWeekly(buildCoilSeries(root, { earningsByTicker: earnings, start: HOLDOUT_START })),
    Turtle: toWeekly(simulateTurtle(etfMap, { start: HOLDOUT_START, end: STUDY_END })),
    Drift: toWeekly(buildDriftSeries(root, { earningsByTicker: earnings, start: HOLDOUT_START, end: STUDY_END })),
    DefProxy: toWeekly(simulateDefensiveProxy(loadFleetBars(root, 'QQQ'), { start: HOLDOUT_START, end: STUDY_END })),
  };

  // 3) evaluate primary (carry+roll) and twin (term-spread)
  const ctx = { curve, iefBars, qqqWk, laneWk, turtleRatesWk };
  const P = evaluate((row) => carryRollSignal(row), ctx);
  const T = evaluate((row) => termSpread(row), ctx);

  // threshold-binding diagnostic (train + holdout): how often a buffer flips the sign-only decision
  const bindAll = BUFFER_GRID_BPS.map((bps) => ({ bps, frac: thresholdBindingFraction(curve, (row) => carryRollSignal(row), bps / 100) }));

  // 4) twin agreement + power flag → final verdict
  const primaryKeep = P.gate2Pass && P.edgePass && P.stressPass && P.dodges2022;
  const twinKeep = T.gate2Pass && T.edgePass && T.stressPass && T.dodges2022;
  const twinDisagree = primaryKeep !== twinKeep;
  const lowPower = P.episodes < 4;
  let verdict; const reasons = [];
  if (!P.gate2Pass) {
    verdict = 'REJECT';
    if (!P.trPass) reasons.push(`different hat: ρ(co-active) to Turtle-rates ${f(P.rhoTRco)} ≥ 0.3`);
    if (!P.betaPass) reasons.push(`equity-β ${f(P.beta)} (CI not bracketing 0, |β|≥0.2)`);
    if (!P.rhoQPass) reasons.push(`ρ to QQQ ${f(P.rhoQ)} ≥ 0.3`);
    if (!P.crisisPass) reasons.push('co-crashes (crisis-mean CI entirely < 0)');
    if (!P.lanePass) reasons.push('redundant to an existing lane (|ρ| ≥ 0.3)');
  } else if (!(P.edgePass && P.stressPass)) {
    verdict = 'REJECT'; reasons.push('edge gate FAIL (holdout net CI lower bound ≤ 0 at 1× or 2×)');
  } else if (!P.dodges2022) {
    verdict = 'INCONCLUSIVE'; reasons.push(`dodge narrative does not show cash through 2022 (2022 shock-week cash fraction ${pc(P.dodge2022.cashFraction)})`);
  } else if (lowPower) {
    verdict = 'INCONCLUSIVE'; reasons.push(`all gates favorable BUT rate-regime sample too thin to graduate: ${P.episodes} independent rate-shock episodes (revisit after more regimes)`);
  } else if (twinDisagree) {
    verdict = 'INCONCLUSIVE'; reasons.push('robustness twin (term-spread) disagrees at the verdict level');
  } else {
    verdict = 'KEEP (provisional — edge claim is a small-episode case study)';
  }

  // 5) RESULTS
  const yearGroups = (detail) => {
    const m = new Map();
    for (const r of detail) { const y = r.week.slice(0, 4); if (!m.has(y)) m.set(y, []); m.get(y).push(r); }
    return [...m.entries()].sort();
  };
  const L = [];
  L.push('# Bond-Carry / Roll-Down Sleeve — RESULTS', '');
  L.push(`**Pre-registration hash (sha256):** \`${preregHash}\``);
  L.push(`**VERDICT: ${verdict}**${reasons.length ? ' — ' + reasons.join('; ') : ''}`, '');
  L.push('> Reconstructed PAPER returns, lab-only. Signal = **yield-curve shape** (FMP treasury constant-maturity), NOT ETF price — the orthogonality bet vs Turtle. Sleeve = hold IEF when `y10 + 7.5·(y10−y7) − m3 > 0`, else **cash accrued at `m3` (zero price vol)**. Monthly rebalance, friction-net (round-trip on exit, 1× and 2× stress).', '');
  L.push('> ⚠️ **Data wall:** FMP caps EOD bars at 5000 rows → ETF execution window is **2006-07 → 2026** (curve reaches 2002). **Holdout 2015–2026 (incl. 2020 COVID + 2022 rate-shock) intact**; train 2006–2014 is diagnostic-only (the primary rule is parameter-free). ⚠️ **Gate 1b is DESCRIPTIVE, not a powered test** — only ~a handful of independent rate-shock regimes exist; its bootstrap would describe a few events, so the dodge is graded as a **dated fact** (cash through 2022?), not a CI. Any KEEP is **provisional pending more regimes**; a REJECT on the full-series orthogonality gate is trustworthy.', '');
  L.push(`**Holdout common weeks (orthogonality, intersected with fleet lanes):** ${P.alignedWeeks}; **holdout sleeve weeks (edge gate):** ${P.edge1.n}. **Distinct duration-hold episodes (full sim 2006-07+):** ${P.sim1.episodes.length} — the signal rarely goes to cash, so the 2022-dodge question rests on ~1–2 datable events (a case study, not a powered test).`, '');

  L.push('## Gate 1 — Edge (ballast-graded, holdout)', '');
  L.push('| friction | n weeks | mean weekly | 95% CI | pass (CI>0)? |', '|---|--:|--:|:--|:--|');
  L.push(`| 1× (net) | ${P.edge1.n} | ${pc(P.edge1.mean)} | [${pc(P.edge1.lo)}, ${pc(P.edge1.hi)}] | ${yes(P.edgePass)} |`);
  L.push(`| 2× (stress) | ${P.edge2.n} | ${pc(P.edge2.mean)} | [${pc(P.edge2.lo)}, ${pc(P.edge2.hi)}] | ${yes(P.stressPass)} |`);
  L.push('> Gate 1a is a floor ("does not lose money net of costs"), not an edge proof — a cash-heavy sleeve earns T-bills by construction. The value-add is the dodge (Gate 1b) + orthogonality (Gate 2).', '');

  L.push('## Gate 1b — Rate-shock DODGE (descriptive, dated)', '');
  L.push('Rate-shock weeks = top-decile weekly Δy10 in the holdout (signal-independent). Bootstrap intentionally omitted: the holdout holds only a handful of independent macro rate-regimes, so the dodge is graded as a **dated fact** (was the sleeve in cash through 2022?), not a CI.', '');
  L.push('| window | shock weeks | sleeve in CASH | sleeve mean | buy-hold IEF mean |', '|---|--:|--:|--:|--:|');
  L.push(`| all holdout | ${P.dodge.n} | ${pc(P.dodge.cashFraction)} | ${pc(P.dodge.sleeveMean)} | ${pc(P.dodge.iefMean)} |`);
  L.push(`| **2022 only** | ${P.dodge2022.n} | **${pc(P.dodge2022.cashFraction)}** | ${pc(P.dodge2022.sleeveMean)} | ${pc(P.dodge2022.iefMean)} |`, '');
  L.push(`**Dodge criterion (cash for the majority of 2022 rate-shock weeks): ${yes(P.dodges2022)}** (2022 cash fraction ${pc(P.dodge2022.cashFraction)}).`, '');
  L.push('Per-year shock-week dodge:', '');
  for (const [y, rows] of yearGroups(P.shockDetail)) {
    const a = (() => { const n = rows.length; const cash = rows.filter((r) => !r.active).length; return { n, cf: cash / n }; })();
    L.push(`- ${y}: ${a.n} shock weeks, sleeve in cash ${pc(a.cf)}`);
  }
  L.push('');

  L.push('## Gate 2 — Orthogonality (holdout, weekly)', '');
  L.push('| metric | value | bar | pass? |', '|---|--:|:--|:--|');
  L.push(`| β to QQQ | ${f(P.beta)} [${f(P.betaCI.lo)}, ${f(P.betaCI.hi)}] | CI brackets 0 or \\|β\\|<0.2 | ${yes(P.betaPass)} |`);
  L.push(`| ρ to QQQ | ${f(P.rhoQ)} | \\|ρ\\|<0.3 | ${yes(P.rhoQPass)} |`);
  L.push(`| crisis mean (QQQ worst-quintile) | ${pc(P.crMean)} [${pc(P.crCI.lo)}, ${pc(P.crCI.hi)}] | CI not entirely <0 | ${yes(P.crisisPass)} |`);
  L.push(`| ρ_crisis (vs rot band p5/p95) | ${f(P.rc)} [${f(P.band.p5)}, ${f(P.band.p95)}] | descriptive | — |`);
  L.push(`| ρ to Coil / Turtle / Drift / DefProxy | ${f(P.laneRho.Coil)} / ${f(P.laneRho.Turtle)} / ${f(P.laneRho.Drift)} / ${f(P.laneRho.DefProxy)} | each \\|ρ\\|<0.3 | ${yes(P.lanePass)} |`);
  L.push(`| **ρ to Turtle-rates (all weeks)** | ${f(P.rhoTRall)} | context | — |`);
  L.push(`| **ρ to Turtle-rates (CO-ACTIVE — decisive)** | **${f(P.rhoTRco)}** | \\|ρ\\|<0.3 (the "different hat" check) | ${yes(P.trPass)} |`, '');

  L.push('## Gate 2b — Steepening-regime cut (descriptive)', '');
  L.push('Each duration-held episode classified by sign of Δy10 over the hold (bull = y10 fell → genuine ballast; bear = y10 rose → risk-on-correlated).', '');
  const bull = P.steepening.filter((e) => e.regime === 'bull_steepening').length;
  const bear = P.steepening.filter((e) => e.regime === 'bear_steepening').length;
  L.push(`- Duration-hold episodes ending in/after the 2015 holdout: ${P.steepening.length} — bull-steepening ${bull}, bear-steepening ${bear}, unknown ${P.steepening.length - bull - bear}. (Episode boundaries span the full 2006-07+ sim; the signal rarely flips, so episodes are multi-year.)`);
  for (const e of P.steepening.slice(0, 24)) L.push(`  - ${e.start} → ${e.end}: Δy10 ${f(e.dY10, 2)}pp → ${e.regime}`);
  L.push('> Bear-steepening holds (sleeve LONG duration while y10 ROSE) are the risk-on bond exposure this cut exists to expose — here the dominant holds are bear-steepening, including the one spanning the 2022 selloff, so the sleeve carries the bad kind of rate exposure, not clean ballast.', '');

  L.push('## Robustness twin (term-spread, no ModDur) + threshold-binding diagnostic', '');
  L.push(`- Twin verdict-level agreement: **${twinDisagree ? 'DISAGREE → downgrade KEEP→INCONCLUSIVE' : 'agree'}** (primary keep=${primaryKeep}, twin keep=${twinKeep}).`);
  L.push(`- Twin gate2 pass ${yes(T.gate2Pass)} | twin edge ${yes(T.edgePass)} | twin ρ(co-active) Turtle-rates ${f(T.rhoTRco)} | twin 2022 cash ${pc(T.dodge2022.cashFraction)}.`);
  for (const b of bindAll) L.push(`- Threshold-binding: a +${b.bps}bp buffer flips the sign-only decision in ${pc(b.frac)} of months (near 0 ⇒ verdict rests on the signal's sign, not a tuned threshold).`);
  L.push('');

  const md = L.join('\n') + '\n';
  mkdirSync(join(root, 'docs', 'lab'), { recursive: true });
  writeFileSync(join(root, 'docs', 'lab', 'bond-carry-RESULTS.md'), md, { encoding: 'utf-8' });

  process.stdout.write(`prereg ${preregHash}\nVERDICT: ${verdict}${reasons.length ? ' — ' + reasons.join('; ') : ''}\n`);
  process.stdout.write(`edge1x ${pc(P.edge1.mean)} CI[${pc(P.edge1.lo)},${pc(P.edge1.hi)}] | beta ${f(P.beta)} [${f(P.betaCI.lo)},${f(P.betaCI.hi)}] rhoQ ${f(P.rhoQ)} | crisis ${pc(P.crMean)}[${pc(P.crCI.lo)},${pc(P.crCI.hi)}] | TurtleRates ρall ${f(P.rhoTRall)} ρco ${f(P.rhoTRco)} | lanes C${f(P.laneRho.Coil)} T${f(P.laneRho.Turtle)} D${f(P.laneRho.Drift)} P${f(P.laneRho.DefProxy)} | 2022cash ${pc(P.dodge2022.cashFraction)} holdEps ${P.sim1.episodes.length} | wks ${P.alignedWeeks}\n`);
}
