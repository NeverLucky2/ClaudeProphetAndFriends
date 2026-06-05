// scripts/coil-threshold-score.mjs
// Phase-1 per-bucket descriptive stats + the pre-registered decision logic. The CLI wires
// build instances + portfolio sim into a train kill-gate, a single frozen holdout pass, and
// the verdict; it refuses to score the holdout on a prereg-hash mismatch.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFriction, mean, median, winRate, profitFactor, bootstrapMeanCI, bootstrapDiffCI } from './coil-threshold-metrics.mjs';

const BUCKETS = ['[0,5)', '[5,8)', '[8,10)', '[10,15)'];

export function bucketStats(rows, { frictionBps = 20 } = {}) {
  const out = {};
  for (const b of BUCKETS) {
    const r = rows.filter(x => x.bucket === b && !x.censored && Number.isFinite(x.grossReturn));
    const nets = r.map(x => applyFriction(x.grossReturn, frictionBps));
    out[b] = {
      n: r.length, winRate: winRate(nets), meanNet: mean(nets), medianNet: median(nets),
      profitFactor: profitFactor(nets),
    };
  }
  return out;
}

// Pre-registered verdict. gate1 = CI on marginal-fill net (from bootstrapMeanCI); portfolio*
// = {totalNet, maxDrawdown}. UNDERPOWERED takes precedence when the marginal sample is thin.
export function decide({ gate1, portfolioBase, portfolioT, powerFloorN = 30 }) {
  if (!gate1 || (gate1.n ?? 0) < powerFloorN) {
    return { verdict: 'UNDERPOWERED', reason: `marginal n=${gate1?.n ?? 0} < ${powerFloorN}` };
  }
  const g1 = gate1.lo > 0;
  const g2 = portfolioT.totalNet > portfolioBase.totalNet
    && portfolioT.maxDrawdown >= portfolioBase.maxDrawdown * 1.1; // DD is negative; *1.1 deepens the floor
  if (g1 && g2) return { verdict: 'CONSIDER', reason: 'both gates passed', gate1: g1, gate2: g2 };
  return { verdict: 'KEEP', reason: `gate1=${g1} gate2=${g2}`, gate1: g1, gate2: g2 };
}

// CLI: node scripts/coil-threshold-score.mjs \
//   --instances data/lab/coil-threshold-instances.json --prereg data/lab/coil-threshold-prereg.json \
//   --out docs/lab/coil-rsi-threshold-RESULTS.md
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const { verifyThresholdPrereg } = await import('./coil-threshold-prereg.mjs');
    const { simulatePortfolio, marginalFills } = await import('./coil-threshold-portfolio.mjs');
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const inst = JSON.parse(readFileSync(flag('--instances', 'data/lab/coil-threshold-instances.json'), 'utf8'));
    const prereg = JSON.parse(readFileSync(flag('--prereg', 'data/lab/coil-threshold-prereg.json'), 'utf8'));
    const v = verifyThresholdPrereg(prereg);
    if (!v.ok) { process.stderr.write(`REFUSING to score: prereg hash mismatch (expected ${v.expected}, found ${v.found}).\n`); process.exit(4); }

    const bps = prereg.friction_bps.representative;
    const boot = { iterations: prereg.bootstrap.iterations, seed: prereg.bootstrap.seed, blockSessions: prereg.bootstrap.block_sessions };
    const T = prereg.primary_T;

    // Each instance already carries its simulated trade; build portfolio candidate rows.
    const toCandidates = (rows) => rows.map(r => ({
      ticker: r.ticker, date: r.date, rsi2: r.rsi2,
      exitDate: r.exitDate ?? r.date, net: applyFriction(r.grossReturn, bps),
    }));

    const train = inst.filter(r => r.split === 'train');
    const holdout = inst.filter(r => r.split === 'holdout');

    // --- TRAIN kill-gate (in-sample, free to inspect): shallow buckets vs [0,5) diff-CI ---
    const trainStats = bucketStats(train, { frictionBps: bps });
    const baseTrainNets = train.filter(r => r.bucket === '[0,5)').map(r => ({ date: r.date, net: applyFriction(r.grossReturn, bps) }));
    const killGate = {};
    for (const b of ['[5,8)', '[8,10)', '[10,15)']) {
      const bn = train.filter(r => r.bucket === b).map(r => ({ date: r.date, net: applyFriction(r.grossReturn, bps) }));
      killGate[b] = bn.length ? bootstrapDiffCI(baseTrainNets, bn, boot) : null; // (bucket - baseline)
    }
    const killed = ['[5,8)', '[8,10)', '[10,15)'].every(b => killGate[b] && killGate[b].hi < 0);

    // --- FROZEN HOLDOUT pass (read once): Phase-1 stats + Phase-2 fills + decision ---
    const holdoutStats = bucketStats(holdout, { frictionBps: bps });
    const candBase = toCandidates(holdout);
    const pBase = simulatePortfolio(candBase, { T: 5 });
    const pT = simulatePortfolio(candBase, { T });
    const marg = marginalFills(pBase.fills, pT.fills);            // present at T, absent at 5
    const gate1 = bootstrapMeanCI(marg.map(f => ({ date: f.date, net: f.net })), boot);
    const verdict = killed
      ? { verdict: 'KEEP', reason: 'train kill-gate: shallow buckets all worse than [0,5)' }
      : decide({ gate1, portfolioBase: pBase, portfolioT: pT, powerFloorN: prereg.power_floor_n });

    // Secondary T (exploratory only — never gates the verdict)
    const secondary = {};
    for (const st of prereg.secondary_T) {
      const p = simulatePortfolio(candBase, { T: st });
      secondary[st] = { totalNet: p.totalNet, maxDrawdown: p.maxDrawdown, nTrades: p.nTrades };
    }

    const capUB = (() => {
      const dates = [...new Set(train.concat(holdout).map(r => r.date))];
      const sub5ByDate = {};
      for (const r of train.concat(holdout)) if (r.bucket === '[0,5)') sub5ByDate[r.date] = (sub5ByDate[r.date] || 0) + 1;
      const lt4 = dates.filter(d => (sub5ByDate[d] || 0) < 4).length;
      return { lt4_fraction: dates.length ? lt4 / dates.length : null, note: 'UPPER BOUND — ignores prior-day open slots; realized count is the Phase-2 fill log' };
    })();

    const md = renderResults({ prereg, T, bps, trainStats, holdoutStats, killGate, killed, pBase, pT, marg, gate1, verdict, secondary, capUB });
    const out = flag('--out', 'docs/lab/coil-rsi-threshold-RESULTS.md');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md);
    process.stdout.write(`VERDICT: ${verdict.verdict} (${verdict.reason}). Wrote ${out}\n`);
  }
}

function pct(x) { return x == null ? 'n/a' : (x * 100).toFixed(2) + '%'; }
function renderResults(d) {
  const L = [];
  L.push('# Coil RSI-Threshold Backtest — Results', '');
  L.push(`**Verdict: ${d.verdict.verdict}** — ${d.verdict.reason}`, '');
  L.push(`Primary T=${d.T}; friction ${d.bps}bps (representative); prereg hash \`${d.prereg.artifact_hash}\`. Expected: KEEP.`, '');
  L.push('## Per-bucket net edge (holdout)', '', '| bucket | n | win | meanNet | PF |', '|---|---|---|---|---|');
  for (const b of ['[0,5)', '[5,8)', '[8,10)', '[10,15)']) {
    const s = d.holdoutStats[b]; L.push(`| ${b} | ${s.n} | ${pct(s.winRate)} | ${pct(s.meanNet)} | ${s.profitFactor == null ? 'n/a' : s.profitFactor.toFixed(2)} |`);
  }
  L.push('', '## Train kill-gate (shallow − [0,5) diff-CI)', '');
  for (const b of ['[5,8)', '[8,10)', '[10,15)']) { const g = d.killGate[b]; L.push(`- ${b}: ${g ? `mean ${pct(g.mean)} CI [${pct(g.lo)}, ${pct(g.hi)}]` : 'n/a'}`); }
  L.push(`- killed: ${d.killed}`, '');
  L.push('## Phase-2 portfolio (holdout)', '', `- T=5 baseline: net ${pct(d.pBase.totalNet)}, maxDD ${pct(d.pBase.maxDrawdown)}, trades ${d.pBase.nTrades}`);
  L.push(`- T=${d.T}: net ${pct(d.pT.totalNet)}, maxDD ${pct(d.pT.maxDrawdown)}, trades ${d.pT.nTrades}`);
  L.push(`- marginal fills (T=${d.T} vs 5): n=${d.marg.length}, net CI [${pct(d.gate1.lo)}, ${pct(d.gate1.hi)}] (mean ${pct(d.gate1.mean)})`, '');
  L.push('### Secondary thresholds (exploratory only — not decision-gating)', '');
  for (const st of Object.keys(d.secondary)) { const s = d.secondary[st]; L.push(`- T=${st}: net ${pct(s.totalNet)}, maxDD ${pct(s.maxDrawdown)}, trades ${s.nTrades}`); }
  L.push('', `## Cap-binding (Phase-1 UPPER BOUND)`, '', `- fraction of dates with <4 sub-5 names: ${pct(d.capUB.lt4_fraction)} — ${d.capUB.note}`, '');
  L.push('## Limitations', '', '- Survivorship (today\'s universe; conservative re: false CONSIDER). Daily-close fills. Regime sizing held normal. Earnings = forward 5-trading-bar FMP filter.');
  return L.join('\n');
}
