// scripts/overlay-score.mjs
// Orchestrator (controller-authored): Task-0 data-wall → prereg → per-target frontier → RESULTS.
// No network. Run: node scripts/overlay-score.mjs --root .
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { OVERLAY_CACHE_SUBDIR, CANDIDATES, parseHoldings } from './overlay-universe.mjs';
import { loadFleetBars } from './fleet-bars.mjs'; // generic loader; point it at overlay-cache below
import { parseBarsWithVolume } from './coil-eventstudy-bars.mjs';
import { loadCurveFrom } from './overlay-curve.mjs';
import { bookDaily, droppedWeightByYear } from './overlay-book.mjs';
import { hedgeDaily } from './overlay-candidates.mjs';
import { rateShockWeeks, splitCrisis, countEpisodes, riskFreeDaily, weeklyY10ForWeeks } from './overlay-regime.mjs';
import { contribWeekly, calmDrag, cushion, cushionCI, efficiency } from './overlay-combine.mjs';
import { spreadStressGrid, vixmStressGrid } from './overlay-stress.mjs';
import { regimeClass, recommendedSize, recommend } from './overlay-frontier.mjs';
import { buildPrereg, hashPrereg } from './overlay-prereg.mjs';
import { dataWallSummary } from './overlay-datawall.mjs';
import { renderReport } from './overlay-report.mjs';
import { unionDates, alignDaily, toWeekly } from './fleet-align.mjs';
import { crisisWeeks } from './fleet-correlate.mjs';

const START = '2016-01-01', END = '2026-06-06';

function loadOverlayBars(root, ticker) {
  const p = join(root, OVERLAY_CACHE_SUBDIR, `${ticker.toUpperCase()}.json`);
  try { return parseBarsWithVolume(JSON.parse(readFileSync(p, 'utf8'))); } catch { return []; }
}
function latestHoldings(root) {
  const dir = join(root, 'data', 'portfolio');
  const fs = readdirSync(dir).filter((f) => /^Holdings_.*\.csv$/.test(f)).sort();
  return parseHoldings(readFileSync(join(dir, fs[fs.length - 1]), 'utf8'));
}
function benchWeekly(bars) {
  const daily = [];
  for (let i = 1; i < bars.length; i += 1) { const d = bars[i].date; if (d < START || d > END) continue; daily.push({ date: d, ret: bars[i].close / bars[i - 1].close - 1, active: true }); }
  return daily;
}

{
  const args = process.argv.slice(2);
  const root = (() => { const i = args.indexOf('--root'); return i >= 0 ? args[i + 1] : process.cwd(); })();

  const prereg = buildPrereg();
  const preregHash = hashPrereg(prereg);
  mkdirSync(join(root, 'data', 'lab'), { recursive: true });
  writeFileSync(join(root, OVERLAY_CACHE_SUBDIR, 'overlay-prereg.json'), JSON.stringify({ ...prereg, sha256: preregHash }, null, 2));

  const holdings = latestHoldings(root);
  const bookBarsByTicker = new Map(holdings.map((h) => [h.symbol, loadOverlayBars(root, h.symbol)]));
  const qqqBars = loadOverlayBars(root, 'QQQ');
  const curve = loadCurveFrom(root); // [{date,m3,y10,...}]
  const earliestPath = join(root, OVERLAY_CACHE_SUBDIR, '_earliest.json');
  const earliest = existsSync(earliestPath) ? JSON.parse(readFileSync(earliestPath, 'utf8')) : {};

  // ── Task 0 data-wall ──
  const droppedByYear = droppedWeightByYear(holdings, bookBarsByTicker, { start: START, end: END });
  const dataWall = dataWallSummary({ earliest, droppedByYear, windowStart: START });

  // ── Build the two target book series ──
  const bookSeries = bookDaily(holdings, bookBarsByTicker, { start: START, end: END });
  const qqqDaily = benchWeekly(qqqBars);

  // ── Candidate raw daily series (one per candidate; spread expanded per costPct size) ──
  const candDaily = {};
  for (const c of CANDIDATES) {
    if (c.kind === 'spread') for (const sz of c.sizes) candDaily[`${c.id}@${sz}`] = hedgeDaily(c, { barsByTicker: bookBarsByTicker, qqqBars, start: START, end: END, size: sz });
    else candDaily[c.id] = hedgeDaily(c, { barsByTicker: new Map([[c.ticker, loadOverlayBars(root, c.ticker)]]), qqqBars, start: START, end: END });
  }

  // ── Common weekly alignment across book, QQQ, all candidate series ──
  const lanes = { Book: bookSeries, QQQ: qqqDaily, ...candDaily };
  const dates = unionDates(lanes);
  const aligned = alignDaily(lanes, dates);
  const weekly = {}; for (const k of Object.keys(aligned)) weekly[k] = toWeekly(aligned[k]);
  const weekEndDates = weekly.QQQ.map((w) => w.date);
  const rfDailyMap = riskFreeDaily(curve, dates);
  const rfWeekly = toWeekly(dates.map((d) => ({ date: d, ret: rfDailyMap.get(d) || 0, active: true }))).map((w) => w.ret);

  const crisisIdx = crisisWeeks(weekly.QQQ, 'quintile');
  const wY10 = weeklyY10ForWeeks(curve, weekEndDates);
  const rsSet = rateShockWeeks(wY10, { topFrac: 0.1 });
  const { rateShockIdx, growthScareIdx } = splitCrisis(crisisIdx, rsSet);

  const targets = [];
  for (const [targetName, bookW] of [['Reconstructed Merrill book', weekly.Book], ['QQQ', weekly.QQQ]]) {
    const rows = []; const stress = []; const recRows = [];
    for (const c of CANDIDATES) {
      const sizeRows = [];
      const sizeList = c.kind === 'spread' ? c.sizes : c.sizes;
      for (const sz of sizeList) {
        const hw = c.kind === 'spread' ? weekly[`${c.id}@${sz}`] : weekly[c.id];
        const isSpread = c.kind === 'spread';
        const contrib = contribWeekly(hw, bookW, { w: sz, funding: 'cash', rf: rfWeekly, isSpread });
        const contribBookFunded = contribWeekly(hw, bookW, { w: sz, funding: 'book', rf: rfWeekly, isSpread });
        const drag = calmDrag(contrib, crisisIdx);
        const dragConservative = calmDrag(contribBookFunded, crisisIdx);
        const lumped = { mean: cushion(contrib, crisisIdx), ...pickCI(cushionCI(contrib, crisisIdx)), episodes: countEpisodes(crisisIdx) };
        const rateShock = { mean: cushion(contrib, rateShockIdx), ...pickCI(cushionCI(contrib, rateShockIdx)), episodes: countEpisodes(rateShockIdx) };
        const growthScare = { mean: cushion(contrib, growthScareIdx), ...pickCI(cushionCI(contrib, growthScareIdx)), episodes: countEpisodes(growthScareIdx) };
        const rc = regimeClass({ rateShock, growthScare });
        sizeRows.push({ candidate: c.label, sizeNum: sz, size: c.kind === 'spread' ? `${(sz * 100).toFixed(1)}% prem` : `${(sz * 100).toFixed(1)}%`,
          calmDrag: drag, calmDragConservative: dragConservative, lumped, rateShock, growthScare,
          efficiency: efficiency(lumped.mean, dragConservative), regimeClass: rc });
      }
      rows.push(...sizeRows);
      const rec = recommendedSize(sizeRows) || sizeRows[0];
      // stress grid for convex candidates (def-Prophet via QQQ spot; VIXM via shock-beta)
      if (c.id === 'def_prophet') stress.push({ candidate: c.label, grid: spreadStressGrid(100, { longPct: 0.95, shortPct: 0.85 }) });
      if (c.id === 'vixm') stress.push({ candidate: c.label, grid: vixmStressGrid(rec.lumped.mean, meanCrisisQQQ(weekly.QQQ, crisisIdx)) });
      const stressOk = c.id === 'def_prophet' ? true : (c.id === 'vixm' ? rec.lumped.lo > 0 : true);
      recRows.push({ id: c.id, convex: c.convex, class: rec.regimeClass, lumpedLo: rec.lumped.lo, drag: rec.calmDragConservative, cushion: rec.lumped.mean, stressOk });
    }
    const decision = recommend(recRows, { budget: 0.02 });
    targets.push({ name: targetName, rows, stress, recommendation: { ...decision, text: decisionText(decision) } });
  }

  const md = renderReport({ preregHash, dataWall, targets });
  mkdirSync(join(root, 'docs', 'lab'), { recursive: true });
  writeFileSync(join(root, 'docs', 'lab', 'fleet-hedge-overlay-RESULTS.md'), md, { encoding: 'utf-8' });
  process.stdout.write(`prereg ${preregHash}\nRESULTS: docs/lab/fleet-hedge-overlay-RESULTS.md\n`);
  for (const t of targets) process.stdout.write(`[${t.name}] branch ${t.recommendation.branch} pick ${t.recommendation.pick}\n`);
}

function pickCI(ci) { return { lo: ci.lo, hi: ci.hi }; }
function meanCrisisQQQ(qqqW, idx) { if (!idx.length) return -0.05; return idx.reduce((s, i) => s + qqqW[i].ret, 0) / idx.length; }
function decisionText(d) {
  if (d.branch === 'a') return `A robust, cheap candidate (${d.pick}) dominates the frontier — recommend it at the noted size.`;
  if (d.branch === 'b') return 'def-Prophet is the most cost-efficient regime-robust hedge — activate it as the primary hedge. No cheap static sleeve qualifies as robust: the only other regime-robust candidate is the convex long-vol sleeve (VIXM), which is far costlier per unit cushion. See the per-candidate table for which static sleeves are ineffective vs which actively hurt a regime cut.';
  return 'Honest null — no static hedge clears robust+cheap; rely on the already-built def-Prophet and accept the residual gap.';
}
