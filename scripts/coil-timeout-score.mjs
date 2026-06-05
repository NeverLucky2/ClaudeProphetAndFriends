import { applyFriction, mean, median, bootstrapMeanCI } from './coil-threshold-metrics.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

export function classifyBranch(exitReason) {
  if (exitReason === 'rsi_mean_cross' || exitReason === 'sma5_cross') return 'bounce';
  if (exitReason === 'time_stop') return 'meander';
  if (exitReason === 'stop') return 'conversion';
  return 'other';
}

// Per-trade friction-net delta over the paired (time_stop@5) set, for one variant T. Friction is
// a flat per-trade bps so it cancels in the delta — applyFriction is still used on both legs so
// the cancellation is explicit and tested. Censored-at-T members are excluded (drives n_delta@T).
export function pairedDeltas(paired, T, { frictionBps = 20 } = {}) {
  const rows = [];
  for (const p of paired) {
    const e = p.perT[String(T)];
    if (!e || e.censored || !Number.isFinite(e.gross) || !Number.isFinite(p.gross5)) continue;
    const net = applyFriction(e.gross, frictionBps) - applyFriction(p.gross5, frictionBps);
    rows.push({ date: p.date, net, branch: classifyBranch(e.exitReason), gross5: p.gross5, grossT: e.gross });
  }
  return rows;
}

// Cap values strictly above the p-th percentile at that percentile value (upside winsorization).
// Percentile index mirrors the metrics module's pctOf convention.
export function winsorizeUpside(values, pct = 90) {
  if (!values.length) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const cap = sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((pct / 100) * sorted.length)))];
  return values.map(v => (v > cap ? cap : v));
}

// Partition paired-delta rows by branch; isolate the stop-conversion count + summed drag.
export function tailDecomp(rows) {
  const d = { n: rows.length, nBounce: 0, nMeander: 0, nConvert: 0, sumBounce: 0, sumMeander: 0, dragSum: 0 };
  for (const r of rows) {
    if (r.branch === 'bounce') { d.nBounce += 1; d.sumBounce += r.net; }
    else if (r.branch === 'meander') { d.nMeander += 1; d.sumMeander += r.net; }
    else if (r.branch === 'conversion') { d.nConvert += 1; d.dragSum += r.net; }
  }
  return d;
}

// Pre-registered 3-part verdict. nDelta = non-censored paired count at the primary T.
export function decideTimeout({ gate1a, gate1b, gate2, nDelta, powerFloorN = 30 }) {
  if ((nDelta ?? 0) < powerFloorN) return { verdict: 'UNDERPOWERED', reason: `n_delta=${nDelta ?? 0} < ${powerFloorN}` };
  if (!(gate1a && gate1a.lo > 0)) return { verdict: 'KEEP', reason: 'no per-trade edge (gate1a CI not > 0)' };
  if (!(gate1b && gate1b.lo > 0)) return { verdict: 'KEEP', reason: 'edge is tail-funded (gate1b winsorized CI not > 0)' };
  if (!gate2) return { verdict: 'KEEP', reason: 'opportunity cost dominates (gate2: portfolio not improved)' };
  return { verdict: 'EXTEND', reason: 'all three gates passed' };
}

// Split a {date,cum} curve at the boundary; report deepest DD per side and an "untested" flag
// when the holdout drawdown is shallower than ratio × the train drawdown.
export function ddPlacement(curve, boundaryDate, ratio) {
  const seg = (pred) => curve.filter(pred);
  const dd = (pts) => { let peak = 0, d = 0, at = null; for (const p of pts) { peak = Math.max(peak, p.cum); const x = p.cum - peak; if (x < d) { d = x; at = p.date; } } return { dd: d, at }; };
  const trainDD = dd(seg(p => p.date < boundaryDate));
  const holdoutDD = dd(seg(p => p.date >= boundaryDate));
  const untested = Math.abs(holdoutDD.dd) < ratio * Math.abs(trainDD.dd);
  return { trainDD, holdoutDD, untested };
}

function pct(x) { return x == null ? 'n/a' : (x * 100).toFixed(2) + '%'; }

function renderResults(d) {
  const L = [];
  L.push('# Coil Exit-Timeout Backtest — Results', '');
  L.push(`**Verdict: ${d.verdict.verdict}** — ${d.verdict.reason}`, '');
  L.push(`Primary maxHold=${d.T}; friction ${d.bps}bps; prereg hash \`${d.prereg.artifact_hash}\`. Expected: KEEP.`, '');
  L.push('## Paired marginal edge (holdout, primary T=7)', '');
  L.push(`- n_paired=${d.nPaired}, n_delta@7=${d.gate1a.n}`);
  L.push(`- Δ mean ${pct(d.gate1a.mean)}, CI [${pct(d.gate1a.lo)}, ${pct(d.gate1a.hi)}] (gate1a ${d.gate1a.lo > 0})`);
  L.push(`- winsorized-upside Δ CI [${pct(d.gate1b.lo)}, ${pct(d.gate1b.hi)}] (gate1b ${d.gate1b.lo > 0})`, '');
  L.push('### Tail decomposition (the operator number)', '');
  L.push(`- bounce: n=${d.tail.nBounce}, sum ${pct(d.tail.sumBounce)}`);
  L.push(`- meander: n=${d.tail.nMeander}, sum ${pct(d.tail.sumMeander)}`);
  L.push(`- **stop-conversion: n=${d.tail.nConvert}, drag ${pct(d.tail.dragSum)}**`, '');
  L.push('## Phase-2 portfolio (holdout)', '');
  L.push(`- maxHold=5: net ${pct(d.p5.totalNet)}, maxDD ${pct(d.p5.maxDrawdown)}, trades ${d.p5.nTrades}`);
  L.push(`- maxHold=7: net ${pct(d.p7.totalNet)}, maxDD ${pct(d.p7.maxDrawdown)}, trades ${d.p7.nTrades} (gate2 ${d.gate2})`);
  L.push(`- blocked-by-extension (filled@5, lost@7): ${d.blocked.count}` + (d.blocked.count ? ` — mean counterfactual net ${pct(mean(d.blocked.signals.map(s => s.net)))}` : ''), '');
  L.push('## Drawdown-episode placement (condition 2 audit)', '');
  L.push(`- split boundary ${d.boundaryDate}`);
  L.push(`- baseline deepest DD — train ${pct(d.dd.trainDD.dd)} @${d.dd.trainDD.at}; holdout ${pct(d.dd.holdoutDD.dd)} @${d.dd.holdoutDD.at}`);
  L.push(`- condition (2) ${d.dd.untested ? '**UNTESTED** (holdout comparatively calm — a borderline EXTEND is unconfirmed)' : 'exercised by a holdout drawdown'}`, '');
  L.push('### Secondary maxHold (exploratory only — never gates; no post-hoc promotion)', '');
  for (const T of Object.keys(d.secondary)) { const s = d.secondary[T]; L.push(`- maxHold=${T}: Δ CI [${pct(s.lo)}, ${pct(s.hi)}], portfolio net ${pct(s.net)}, n_convert ${s.nConvert}`); }
  L.push('', '## Limitations', '', '- Survivorship (today\'s universe) biases TOWARD extend — a borderline EXTEND is not actionable without point-in-time membership. Daily-close fills. Regime sizing held normal. Earnings = forward 5-trading-bar FMP filter. KEEP@7 does not mean extension never helps at a longer horizon (pre-register a fresh study to test that).');
  return L.join('\n');
}

// CLI: node scripts/coil-timeout-score.mjs --instances data/lab/coil-timeout-instances.json \
//   --prereg data/lab/coil-timeout-prereg.json --out docs/lab/coil-exit-timeout-RESULTS.md
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const { verifyTimeoutPrereg } = await import('./coil-timeout-prereg.mjs');
    const { simulateTimeoutPortfolio, blockedByExtension } = await import('./coil-timeout-portfolio.mjs');
    const args = process.argv.slice(2);
    const flag = (n, dft) => { const i = args.indexOf(n); return i === -1 ? dft : args[i + 1]; };
    const inst = JSON.parse(readFileSync(flag('--instances', 'data/lab/coil-timeout-instances.json'), 'utf8'));
    const prereg = JSON.parse(readFileSync(flag('--prereg', 'data/lab/coil-timeout-prereg.json'), 'utf8'));
    const v = verifyTimeoutPrereg(prereg);
    if (!v.ok) { process.stderr.write(`REFUSING to score: prereg hash mismatch (expected ${v.expected}, found ${v.found}).\n`); process.exit(4); }

    const bps = prereg.friction_bps.representative;
    const boot = { iterations: prereg.bootstrap.iterations, seed: prereg.bootstrap.seed, blockSessions: prereg.bootstrap.block_sessions };
    const T = prereg.primary_maxHold;
    const paired = inst.paired || [];
    const pairedHoldout = paired.filter(r => r.split === 'holdout');
    const pairedTrain = paired.filter(r => r.split === 'train');

    // TRAIN kill-gate (in-sample): if the primary-T paired Δ CI is clearly < 0, KEEP.
    const trainRows = pairedDeltas(pairedTrain, T, { frictionBps: bps });
    const trainCI = bootstrapMeanCI(trainRows.map(r => ({ date: r.date, net: r.net })), boot);
    const killed = trainRows.length > 0 && trainCI.hi < 0;

    // FROZEN HOLDOUT (read once): paired edge + winsorized edge + tail decomposition.
    const rows = pairedDeltas(pairedHoldout, T, { frictionBps: bps });
    const gate1a = bootstrapMeanCI(rows.map(r => ({ date: r.date, net: r.net })), boot);
    const capped = winsorizeUpside(rows.map(r => r.net), prereg.winsorize_pct);
    const gate1b = bootstrapMeanCI(rows.map((r, i) => ({ date: r.date, net: capped[i] })), boot);
    const tail = tailDecomp(rows);

    // Phase-2 portfolio on holdout candidates per variant.
    const candOf = (T2, split) => (inst.portfolio[T2] || []).filter(c => c.split === split)
      .map(c => ({ ticker: c.ticker, date: c.date, rsi2: c.rsi2, exitDate: c.exitDate, net: applyFriction(c.gross, bps) }));
    const p5 = simulateTimeoutPortfolio(candOf(5, 'holdout'));
    const p7 = simulateTimeoutPortfolio(candOf(T, 'holdout'));
    const gate2 = p7.totalNet > p5.totalNet && p7.maxDrawdown >= p5.maxDrawdown * 1.1; // DD negative; *1.1 deepens floor
    const blocked = blockedByExtension(p5, p7);

    // Condition-2 audit: deepest baseline DD train vs holdout (run baseline over the FULL series).
    const pBaseAll = simulateTimeoutPortfolio([...candOf(5, 'train'), ...candOf(5, 'holdout')]);
    const dd = ddPlacement(pBaseAll.curve, inst.boundaryDate, prereg.decision_rule.dd_untested_ratio);

    const verdict = killed
      ? { verdict: 'KEEP', reason: 'train kill-gate: primary-T paired Δ clearly < 0 in-sample' }
      : decideTimeout({ gate1a, gate1b, gate2, nDelta: gate1a.n, powerFloorN: prereg.power_floor_n });

    // Secondary maxHold (exploratory only).
    const secondary = {};
    for (const T2 of prereg.secondary_maxHold) {
      const r2 = pairedDeltas(pairedHoldout, T2, { frictionBps: bps });
      const ci2 = bootstrapMeanCI(r2.map(r => ({ date: r.date, net: r.net })), boot);
      const pp = simulateTimeoutPortfolio(candOf(T2, 'holdout'));
      secondary[T2] = { lo: ci2.lo, hi: ci2.hi, net: pp.totalNet, nConvert: tailDecomp(r2).nConvert };
    }

    const md = renderResults({ prereg, T, bps, nPaired: pairedHoldout.length, gate1a, gate1b, tail, p5, p7, gate2, blocked, dd, boundaryDate: inst.boundaryDate, secondary, verdict });
    const out = flag('--out', 'docs/lab/coil-exit-timeout-RESULTS.md');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md);
    process.stdout.write(`VERDICT: ${verdict.verdict} (${verdict.reason}). Wrote ${out}\n`);
  }
}
