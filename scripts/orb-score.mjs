// scripts/orb-score.mjs
// ORB scoring: R-multiple dual gates (friction-net + per-name-beta market-relative), decided on
// the ETF cut (market-relative ex-SPY). Pure decideOrb is unit-tested; the CLI wires real data.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mean, bootstrapMeanCI } from './coil-threshold-metrics.mjs';
import { netR, mktRelR, spyWindowReturn } from './orb-marketrel.mjs';
import { olsBeta } from './ema-beta.mjs';
import { loadOrbSessions } from './orb-bars.mjs';
import { dropTopN, edgeByHour } from './orb-report.mjs';
import { BENCHMARK, gatedMktrelTickers } from './orb-universe.mjs';

export function decideOrb({ gateNet, gateMktrel, trainNetMean, trainMktrelMean, nTrades, distinctDates, powerFloor }) {
  if (nTrades < powerFloor.trades || distinctDates < powerFloor.distinct_dates) {
    return { verdict: 'UNDERPOWERED', reason: `n=${nTrades}/${distinctDates}d < ${powerFloor.trades}/${powerFloor.distinct_dates}d` };
  }
  const gNet = gateNet.lo > 0, gMkt = gateMktrel.lo > 0, gRobust = trainNetMean > 0 && trainMktrelMean > 0;
  if (gNet && gMkt && gRobust) return { verdict: 'KEEP-CANDIDATE', reason: 'net & market-relative R CI>0 + train sign-consistent', gNet, gMkt, gRobust };
  return { verdict: 'REJECT', reason: `gate_net=${gNet} gate_mktrel=${gMkt} gate_robust=${gRobust}`, gNet, gMkt, gRobust };
}

// date|minutes -> {open,close} price map + date|minutes -> within-session 5-min return map.
function barMaps(sessions) {
  const px = new Map(), ret = new Map();
  for (const s of sessions) {
    for (let i = 0; i < s.bars.length; i += 1) {
      const b = s.bars[i];
      px.set(`${s.date}|${b.minutes}`, { open: b.open, close: b.close });
      if (i > 0) ret.set(`${s.date}|${b.minutes}`, b.close / s.bars[i - 1].close - 1);
    }
  }
  return { px, ret };
}

function r3(x) { return x == null ? 'n/a' : (typeof x === 'number' ? x.toFixed(3) : String(x)); }
function render(d) {
  const L = [];
  L.push('# ORB Backtest — Results', '');
  L.push(`**Verdict: ${d.verdict.verdict}** — ${d.verdict.reason}`, '');
  L.push(`Generic daily-bar-free ORB on liquid ETFs. A backtest of generic ORB answers "does ORB carry edge for me", NOT "is the seller legit" (his exact config is unknown + ILM undefinable). A REJECT is not a verdict on the seller, and a 5-min-bar test does not bear on tick-level variants. Prereg hash \`${d.prereg.artifact_hash}\`. Gated metric: R-multiple at ETF friction ${d.etfBps}bps. Expected: UNCERTAIN.`, '');
  L.push('## Primary gates (R-multiple, holdout, ETF cut)', '', '| gate | n | mean | CI lo | CI hi |', '|---|---|---|---|---|');
  L.push(`| net (SPY/QQQ/IWM/DIA) | ${d.gateNet.n} | ${r3(d.gateNet.mean)} | ${r3(d.gateNet.lo)} | ${r3(d.gateNet.hi)} |`);
  L.push(`| market-relative (ex-SPY) | ${d.gateMktrel.n} | ${r3(d.gateMktrel.mean)} | ${r3(d.gateMktrel.lo)} | ${r3(d.gateMktrel.hi)} |`);
  L.push(`- train net R mean: ${r3(d.trainNetMean)}; train market-relative R mean: ${r3(d.trainMktrelMean)}`);
  L.push(`- holdout distinct entry dates (effective N): ${d.distinctDates}`, '');
  L.push('## Robustness & intraday texture', '');
  L.push(`- net R mean after dropping top 5 days: ${r3(d.dropTop5)} (vs ${r3(d.gateNet.mean)} full) — tail-concentration check`);
  L.push('- edge by ET hour (net R):');
  for (const h of d.byHour) L.push(`  - ${h.hour}:00  n=${h.n}  meanR=${r3(h.mean)}`);
  L.push(`- train→holdout split boundary (last train date): ${d.splitBoundary ?? 'n/a'} — disclose which of 2018-Q4 / 2020 / 2022 vol episodes fall on each side`, '');
  L.push('## Large-cap cut (EXPLORATORY — selected on the dependent variable; NEVER gates)', '');
  L.push(d.lcCI ? `- holdout net R (AAPL/NVDA/TSLA/AMD/META @ ${d.lcBps}bps): n=${d.lcCI.n} mean ${r3(d.lcCI.mean)} CI [${r3(d.lcCI.lo)}, ${r3(d.lcCI.hi)}] — these names are chosen for the momentum behavior ORB exploits, so this flatters ORB and is not trusted.` : '- (no large-cap holdout trades)', '');
  L.push('## Limitations', '', '- Next-bar-open fill; IEX feed (volume filter dropped; opening-range extrema biased INWARD → flatters ORB, any KEEP needs SIP re-confirm); 5-min granularity (approx intrabar stops); R right-skewed by trend-day winners (hence drop-top-5); ~2016+ window; capacity ignored.');
  return L.join('\n');
}

// CLI: node scripts/orb-score.mjs --instances data/lab/orb-instances.json --prereg data/lab/orb-prereg.json --out docs/lab/orb-RESULTS.md
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const { verifyOrbPrereg } = await import('./orb-prereg.mjs');
    const args = process.argv.slice(2); const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const root = process.cwd();
    const inst = JSON.parse(readFileSync(flag('--instances', 'data/lab/orb-instances.json'), 'utf8'));
    const prereg = JSON.parse(readFileSync(flag('--prereg', 'data/lab/orb-prereg.json'), 'utf8'));
    const v = verifyOrbPrereg(prereg);
    if (!v.ok) { process.stderr.write(`REFUSING to score: prereg hash mismatch (expected ${v.expected}, found ${v.found}).\n`); process.exit(4); }

    const boot = { iterations: prereg.bootstrap.iterations, seed: prereg.bootstrap.seed, blockSessions: prereg.bootstrap.block_sessions };
    const etfBps = prereg.friction_bps.etf.decision, lcBps = prereg.friction_bps.largecap.decision;
    const spy = barMaps(loadOrbSessions(root, BENCHMARK));

    const trainDates = new Set(inst.filter(r => r.split === 'train').map(r => r.date));
    const betas = {};
    for (const tk of [...new Set(inst.map(r => r.ticker))]) {
      if (tk === BENCHMARK) { betas[tk] = 1; continue; }
      const tr = barMaps(loadOrbSessions(root, tk)).ret;
      const aR = [], bR = [];
      for (const [key, rr] of tr) { if (!trainDates.has(key.split('|')[0])) continue; const sr = spy.ret.get(key); if (sr != null) { aR.push(rr); bR.push(sr); } }
      betas[tk] = olsBeta(aR, bR);
    }

    const enrich = (r, bps) => { const swr = spyWindowReturn(spy.px, r.date, r.entryMinutes, r.exitMinutes); return { ...r, netRval: netR(r, bps), mktRelRval: mktRelR(r, bps, betas[r.ticker] ?? 0, swr) }; };
    const etf = inst.filter(r => r.cut === 'etf').map(r => enrich(r, etfBps));
    const lc = inst.filter(r => r.cut === 'largecap').map(r => enrich(r, lcBps));
    const mktSet = new Set(gatedMktrelTickers());
    const holdoutEtf = etf.filter(r => r.split === 'holdout'), trainEtf = etf.filter(r => r.split === 'train');

    const gateNetRows = holdoutEtf.filter(r => Number.isFinite(r.netRval)).map(r => ({ date: r.date, net: r.netRval }));
    const gateMktRows = holdoutEtf.filter(r => mktSet.has(r.ticker) && Number.isFinite(r.mktRelRval)).map(r => ({ date: r.date, net: r.mktRelRval }));
    const gateNet = bootstrapMeanCI(gateNetRows, boot), gateMktrel = bootstrapMeanCI(gateMktRows, boot);
    const trainNetMean = mean(trainEtf.filter(r => Number.isFinite(r.netRval)).map(r => r.netRval)) ?? 0;
    const trainMktrelMean = mean(trainEtf.filter(r => mktSet.has(r.ticker) && Number.isFinite(r.mktRelRval)).map(r => r.mktRelRval)) ?? 0;
    const distinctDates = new Set(holdoutEtf.map(r => r.date)).size;
    const verdict = decideOrb({ gateNet, gateMktrel, trainNetMean, trainMktrelMean, nTrades: gateNetRows.length, distinctDates, powerFloor: prereg.power_floor });

    const dropTop5 = dropTopN(gateNetRows.map(r => r.net), 5);
    const byHour = edgeByHour(holdoutEtf.filter(r => Number.isFinite(r.netRval)).map(r => ({ entryMinutes: r.entryMinutes, r: r.netRval })));
    const lcHold = lc.filter(r => r.split === 'holdout' && Number.isFinite(r.netRval)).map(r => ({ date: r.date, net: r.netRval }));
    const lcCI = lcHold.length ? bootstrapMeanCI(lcHold, boot) : null;
    const splitBoundary = trainEtf.length ? trainEtf.map(r => r.date).sort().slice(-1)[0] : null;

    const md = render({ prereg, etfBps, lcBps, verdict, gateNet, gateMktrel, trainNetMean, trainMktrelMean, distinctDates, dropTop5, byHour, lcCI, splitBoundary });
    const out = flag('--out', join(root, 'docs', 'lab', 'orb-RESULTS.md'));
    mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, md);
    process.stdout.write(`VERDICT: ${verdict.verdict} (${verdict.reason}). Wrote ${out}\n`);
  }
}
