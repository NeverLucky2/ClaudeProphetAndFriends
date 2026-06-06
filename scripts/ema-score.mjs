// scripts/ema-score.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mean, winRate, bootstrapMeanCI } from './coil-threshold-metrics.mjs';
import { netWithCosts } from './ema-exitsim.mjs';
import { olsBeta, dailyReturns, benchReturnOverWindow, residual } from './ema-beta.mjs';
import { loadEmaBars } from './ema-bars.mjs';
import { alphaByYear, sliceFrom, sliceBefore } from './ema-report.mjs';

export function decideEma({ alphaSPY, alphaQQQ, trainAlpha, nTrades, distinctDates, powerFloor }) {
  if (nTrades < powerFloor.trades || distinctDates < powerFloor.distinct_dates) {
    return { verdict: 'UNDERPOWERED', reason: `n=${nTrades}/${distinctDates}d < ${powerFloor.trades}/${powerFloor.distinct_dates}d` };
  }
  const gAlpha = alphaSPY.lo > 0 && alphaQQQ.lo > 0;
  const gRobust = trainAlpha > 0;
  if (gAlpha && gRobust) return { verdict: 'KEEP-CANDIDATE', reason: 'alpha CI>0 vs both benchmarks + train sign-consistent', gAlpha, gRobust };
  return { verdict: 'REJECT', reason: `gate_alpha=${gAlpha} gate_robust=${gRobust}`, gAlpha, gRobust };
}

// CLI: node scripts/ema-score.mjs --instances data/lab/ema-instances.json \
//   --prereg data/lab/ema-prereg.json --out docs/lab/ema-pullback-RESULTS.md
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const { verifyEmaPrereg } = await import('./ema-prereg.mjs');
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const root = process.cwd();
    const inst = JSON.parse(readFileSync(flag('--instances', 'data/lab/ema-instances.json'), 'utf8'));
    const prereg = JSON.parse(readFileSync(flag('--prereg', 'data/lab/ema-prereg.json'), 'utf8'));
    const v = verifyEmaPrereg(prereg);
    if (!v.ok) { process.stderr.write(`REFUSING to score: prereg hash mismatch (expected ${v.expected}, found ${v.found}).\n`); process.exit(4); }

    const bps = prereg.friction_bps.representative;
    const boot = { iterations: prereg.bootstrap.iterations, seed: prereg.bootstrap.seed, blockSessions: prereg.bootstrap.block_sessions };

    // Benchmark bars + train-frozen per-instrument betas.
    const benchBars = {}; const benchByDate = {};
    for (const bm of prereg.benchmarks) { benchBars[bm] = loadEmaBars(root, bm); benchByDate[bm] = new Map(benchBars[bm].map(b => [b.date, b])); }
    const train = inst.filter(r => r.split === 'train');
    const holdout = inst.filter(r => r.split === 'holdout');
    const betas = {}; // betas[bm][ticker]
    for (const bm of prereg.benchmarks) {
      betas[bm] = {};
      const bRets = new Map(dailyReturns(benchBars[bm]).map(x => [x.date, x.ret]));
      const byTicker = {};
      for (const r of train) (byTicker[r.ticker] ||= true);
      for (const tk of Object.keys(byTicker)) {
        const tb = loadEmaBars(root, tk);
        const aR = [], bR = [];
        for (const x of dailyReturns(tb)) { const b = bRets.get(x.date); if (b != null) { aR.push(x.ret); bR.push(b); } }
        betas[bm][tk] = olsBeta(aR, bR);
      }
    }

    const netOf = (r) => netWithCosts(r.grossReturn, { direction: r.direction, daysHeld: r.daysHeld, frictionBps: bps, borrowBpsAnnual: prereg.borrow_bps_annual[r.cut] });
    const residRows = (rows, bm) => rows.map(r => {
      const benchRet = benchReturnOverWindow(benchByDate[bm], r.date, r.exitDate);
      if (benchRet == null) return null;
      return { date: r.date, net: residual(netOf(r), { direction: r.direction, beta: betas[bm][r.ticker] ?? 0, benchRet }) };
    }).filter(Boolean);

    const alphaSPY = bootstrapMeanCI(residRows(holdout, 'SPY'), boot);
    const alphaQQQ = bootstrapMeanCI(residRows(holdout, 'QQQ'), boot);
    const trainAlpha = mean(residRows(train, 'SPY').map(r => r.net)) ?? 0;
    const distinctDates = new Set(holdout.map(r => r.date)).size;
    const verdict = decideEma({ alphaSPY, alphaQQQ, trainAlpha, nTrades: holdout.length, distinctDates, powerFloor: prereg.power_floor });

    // Descriptive splits (raw net) for the report.
    const split = (rows, dir) => { const r = rows.filter(x => dir == null || x.direction === dir).map(netOf); return { n: r.length, win: winRate(r), mean: mean(r), avgWin: mean(r.filter(x => x > 0)), avgLoss: mean(r.filter(x => x < 0)) }; };
    const sameBarTie = holdout.length ? holdout.filter(r => r.sameBarBoth).length / holdout.length : 0;

    // §5 regime visibility + author-window decontamination (descriptive; not gating).
    const FROM = '2024-06-01';
    const perYear = alphaByYear(residRows(holdout, 'SPY'));
    const trailSPY = bootstrapMeanCI(sliceFrom(residRows(holdout, 'SPY'), FROM), boot);
    const trailQQQ = bootstrapMeanCI(sliceFrom(residRows(holdout, 'QQQ'), FROM), boot);
    const exTrailSPY = bootstrapMeanCI(sliceBefore(residRows(holdout, 'SPY'), FROM), boot);

    const md = renderEmaResults({ prereg, bps, verdict, alphaSPY, alphaQQQ, trainAlpha,
      nLong: split(holdout, 1), nShort: split(holdout, -1), nAll: split(holdout, null),
      distinctDates, sameBarTie, perYear, trail: { from: FROM, spy: trailSPY, qqq: trailQQQ, exSpy: exTrailSPY } });
    const out = flag('--out', join(root, 'docs', 'lab', 'ema-pullback-RESULTS.md'));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md);
    process.stdout.write(`VERDICT: ${verdict.verdict} (${verdict.reason}). Wrote ${out}\n`);
  }
}

function pct(x) { return x == null ? 'n/a' : (x * 100).toFixed(2) + '%'; }
function renderEmaResults(d) {
  const L = [];
  L.push('# EMA-Pullback Backtest — Results', '');
  L.push(`**Verdict: ${d.verdict.verdict}** — ${d.verdict.reason}`, '');
  L.push(`This tests a **daily mechanical adaptation** (fleet runs daily). The author's claim spans down to 400-tick; a daily REJECT does **not** debunk the intraday strategy. Prereg hash \`${d.prereg.artifact_hash}\`. Decision metric: beta-adjusted residual at ${d.bps}bps. Expected: REJECT.`, '');
  L.push('## Beta-adjusted holdout alpha (PRIMARY gate)', '', '| benchmark | n | mean | CI lo | CI hi |', '|---|---|---|---|---|');
  L.push(`| SPY | ${d.alphaSPY.n} | ${pct(d.alphaSPY.mean)} | ${pct(d.alphaSPY.lo)} | ${pct(d.alphaSPY.hi)} |`);
  L.push(`| QQQ | ${d.alphaQQQ.n} | ${pct(d.alphaQQQ.mean)} | ${pct(d.alphaQQQ.lo)} | ${pct(d.alphaQQQ.hi)} |`);
  L.push(`- train alpha (SPY-hedged) mean: ${pct(d.trainAlpha)}`, '');
  L.push(`## Author-window decontamination (trailing 24mo, from ${d.trail.from})`, '');
  L.push(`- holdout FROM ${d.trail.from} (author's likely in-sample): SPY ${pct(d.trail.spy.mean)} CI [${pct(d.trail.spy.lo)}, ${pct(d.trail.spy.hi)}] (n=${d.trail.spy.n}); QQQ ${pct(d.trail.qqq.mean)} CI [${pct(d.trail.qqq.lo)}, ${pct(d.trail.qqq.hi)}]`);
  L.push(`- holdout EXCLUDING trailing (independent): SPY ${pct(d.trail.exSpy.mean)} CI [${pct(d.trail.exSpy.lo)}, ${pct(d.trail.exSpy.hi)}] (n=${d.trail.exSpy.n})`);
  L.push("- A pass concentrated in the trailing window reads as \"reproduces the author's own backtest\", not independent confirmation.", '');
  L.push('## Beta-adjusted alpha by year (SPY-hedged; regime visibility)', '', '| year | n | mean |', '|---|---|---|');
  for (const y of d.perYear) L.push(`| ${y.year} | ${y.n} | ${pct(y.mean)} |`);
  L.push('', '## Raw net by side (descriptive — NOT the gate)', '', '| side | n | win | mean | avgWin | avgLoss |', '|---|---|---|---|---|---|');
  for (const [k, s] of [['long', d.nLong], ['short', d.nShort], ['all', d.nAll]]) {
    L.push(`| ${k} | ${s.n} | ${pct(s.win)} | ${pct(s.mean)} | ${pct(s.avgWin)} | ${pct(s.avgLoss)} |`);
  }
  L.push('', `- distinct entry dates (effective N): ${d.distinctDates}`);
  L.push(`- same-bar both-touched booked-as-loss: ${pct(d.sameBarTie)}`, '');
  L.push('## Ballast lens (§6) — deferred', '', '- The downside/conditional-beta ballast lens needs a strategy equity-curve return series the per-trade design does not produce, and only matters on a KEEP-CANDIDATE verdict. Deferred until/unless the strategy clears the alpha gate; revisit with a proper equity-curve build then.', '');
  L.push('## Limitations', '', '- Signal-day-close fill; large-cap survivorship flatters longs (discount KEEP on that cut); daily bars only (intraday out of scope); CCI proxy ablation-only; train-frozen betas; flat short borrow; no regime sizing.');
  return L.join('\n');
}
