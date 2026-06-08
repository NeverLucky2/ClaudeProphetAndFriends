// scripts/coil-stop-score.mjs
// Stop-tightening scorer: paired marginal deltas + save/whipsaw decomposition + the two-gate
// "cut risk, hold returns" decision rule. Train kill-gate + single frozen holdout read; refuses
// to score on a prereg-hash mismatch.
import { applyFriction, mean, bootstrapMeanCI, cvar } from './coil-threshold-metrics.mjs';
import { winsorizeUpside, ddPlacement } from './coil-timeout-score.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

// Per-trade friction-net paired delta over entries MARGINAL at s (gross or exit changed vs base).
// Friction cancels at no-slip; the slippage arm docks slip on stop legs only (so whipsaws worsen).
export function stopDeltas(marginal, s, { frictionBps = 20, stopSlipBps = 0 } = {}) {
  const key = String(s);
  const slip = stopSlipBps / 10000;
  const rows = [];
  for (const m of marginal) {
    const e = m.perS[key];
    if (!e || !Number.isFinite(e.gross) || !Number.isFinite(m.grossBase)) continue;
    if (e.gross === m.grossBase && e.exitReason === m.baseReason) continue; // not marginal at this s
    const slipS = (stopSlipBps && e.exitReason === 'stop') ? slip : 0;
    const slipB = (stopSlipBps && m.baseReason === 'stop') ? slip : 0;
    const net = (applyFriction(e.gross, frictionBps) - slipS) - (applyFriction(m.grossBase, frictionBps) - slipB);
    rows.push({ date: m.date, net, branch: net > 0 ? 'save' : 'whipsaw', grossBase: m.grossBase, grossS: e.gross });
  }
  return rows;
}

// Partition paired-delta rows into saves (net>0) and whipsaws (net<=0); the headline operator number.
export function saveWhipsawDecomp(rows) {
  const d = { n: rows.length, nSave: 0, nWhipsaw: 0, saveSum: 0, dragSum: 0, net: 0 };
  for (const r of rows) {
    d.net += r.net;
    if (r.net > 0) { d.nSave += 1; d.saveSum += r.net; }
    else { d.nWhipsaw += 1; d.dragSum += r.net; }
  }
  return d;
}

// gross -> friction-net per portfolio candidate; optional stop-slippage on stop exits only.
export function frictionizeCandidates(cands, { bps = 20, stopSlipBps = 0 } = {}) {
  const slip = stopSlipBps / 10000;
  return cands.map(c => ({
    ticker: c.ticker, date: c.date, rsi2: c.rsi2, exitDate: c.exitDate,
    net: applyFriction(c.gross, bps) - ((stopSlipBps && c.exitReason === 'stop') ? slip : 0),
  }));
}

// Pre-registered "cut risk, hold returns" verdict. gateA = risk cut >=10%; gateB = returns held within 10%.
export function decideStop({ gateA, gateB, nMarginal, powerFloorN = 30 }) {
  if ((nMarginal ?? 0) < powerFloorN) return { verdict: 'UNDERPOWERED', reason: `marginal n@0.05=${nMarginal ?? 0} < ${powerFloorN}` };
  if (gateA && gateB) return { verdict: 'TIGHTEN', reason: 'risk cut >=10% AND returns held within 10%' };
  if (!gateA && !gateB) return { verdict: 'KEEP', reason: 'strictly dominated (worse on risk and returns)' };
  if (!gateA) return { verdict: 'KEEP', reason: 'no material risk reduction (maxDD not cut >=10%)' };
  return { verdict: 'KEEP', reason: 'return give-up too large (>10% relative)' };
}

function pct(x) { return x == null ? 'n/a' : (x * 100).toFixed(2) + '%'; }

function renderResults(d) {
  const L = [];
  L.push('# Coil Stop-Tightening Backtest — Results', '');
  const ddTag = (d.verdict.verdict === 'TIGHTEN' && d.dd.untested) ? ' — **UNCONFIRMED (gate A untested: no material holdout drawdown)**' : '';
  L.push(`**Verdict: ${d.verdict.verdict}** — ${d.verdict.reason}${ddTag}`, '');
  L.push(`Primary stop=−5% vs baseline −7%; friction ${d.bps}bps; prereg hash \`${d.prereg.artifact_hash}\`. Expected: KEEP.`, '');
  L.push('## Marginal set — save vs whipsaw (holdout, primary −5%)', '');
  L.push(`- marginal n@0.05 = ${d.decomp.n}`);
  L.push(`- **saves: n=${d.decomp.nSave}, sum ${pct(d.decomp.saveSum)}**`);
  L.push(`- **whipsaws: n=${d.decomp.nWhipsaw}, drag ${pct(d.decomp.dragSum)}**`);
  L.push(`- net marginal Δ ${pct(d.decomp.net)}; bootstrap CI [${pct(d.deltaCI.lo)}, ${pct(d.deltaCI.hi)}]`);
  L.push(`- winsorized-upside net Δ CI [${pct(d.deltaCIw.lo)}, ${pct(d.deltaCIw.hi)}] (saves capped at p${d.prereg.winsorize_pct})`, '');
  L.push('## Portfolio gates (holdout)', '');
  L.push(`- baseline −7%: net ${pct(d.p07.totalNet)}, maxDD ${pct(d.p07.maxDrawdown)}, CVaR5% ${pct(d.cvar07)}, trades ${d.p07.nTrades}`);
  L.push(`- tightened −5%: net ${pct(d.p05.totalNet)}, maxDD ${pct(d.p05.maxDrawdown)}, CVaR5% ${pct(d.cvar05)}, trades ${d.p05.nTrades}`);
  L.push(`- **gate A (risk):** |maxDD| ${pct(Math.abs(d.p05.maxDrawdown))} vs floor ${pct(d.floorA * Math.abs(d.p07.maxDrawdown))} → ${d.gateA}`);
  L.push(`- **gate B (returns):** net ${pct(d.p05.totalNet)} vs floor ${pct(d.floorB * d.p07.totalNet)} → ${d.gateB}`);
  if (d.returnsBaselineNonPositive) L.push('- ⚠️ baseline holdout net ≤ 0 — gate B ratio is unreliable; treat returns as inconclusive');
  L.push(`- admitted-by-tightening (filled@−5%, not@−7%): ${d.admitted.count}` + (d.admitted.count ? ` — mean counterfactual net ${pct(mean(d.admitted.signals.map(s => s.net)))}` : ''), '');
  L.push('## Stop-slippage sensitivity (fill at stop −10bps; primary verdict reads at 20bps)', '');
  L.push(`- tightened −5% under slip: net ${pct(d.p05slip.totalNet)}, maxDD ${pct(d.p05slip.maxDrawdown)} → gate A ${d.gateAslip}, gate B ${d.gateBslip}`);
  L.push(`- ${d.slipFragile ? '⚠️ a borderline TIGHTEN does NOT survive the slip arm (fragile/unconfirmed)' : 'verdict stable under the slip arm'}`, '');
  L.push('## Drawdown-episode placement (gate A audit)', '');
  L.push(`- split boundary ${d.boundaryDate}`);
  L.push(`- baseline deepest DD — train ${pct(d.dd.trainDD.dd)} @${d.dd.trainDD.at}; holdout ${pct(d.dd.holdoutDD.dd)} @${d.dd.holdoutDD.at}`);
  L.push(`- gate A ${d.dd.untested ? '**UNTESTED** (holdout comparatively calm — a TIGHTEN is unconfirmed)' : 'exercised by a holdout drawdown'}`, '');
  L.push('### Secondary stops (exploratory only — never gate; no post-hoc promotion)', '');
  for (const s of Object.keys(d.secondary)) { const x = d.secondary[s]; L.push(`- stop=−${(s * 100).toFixed(0)}%: marginal net Δ ${pct(x.net)}, portfolio net ${pct(x.pNet)}, maxDD ${pct(x.maxDD)}, whipsaws ${x.nWhipsaw}`); }
  L.push('', '## Limitations', '');
  L.push('- **Survivorship biases TOWARD KEEP** (removes the disaster names a tight stop would rescue), but Coil\'s existing −7% already bounds per-name loss, so the residual is small and a KEEP stays credible; a borderline TIGHTEN carries the caveat.');
  L.push('- Gate A is only meaningful if the holdout contains real stress — see the drawdown-episode placement above; an untested gate A makes any TIGHTEN unconfirmed.');
  L.push('- Daily-low stop touch + gap-through fills; regime sizing held normal; earnings = forward 5-trading-bar FMP filter. KEEP@−5% does not prove no tighter level ever helps — pre-register a fresh study with that level as primary.');
  return L.join('\n');
}

// CLI: node scripts/coil-stop-score.mjs --instances data/lab/coil-stop-instances.json \
//   --prereg data/lab/coil-stop-prereg.json --out docs/lab/coil-stop-tighten-RESULTS.md
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const { verifyStopPrereg } = await import('./coil-stop-prereg.mjs');
    const { simulateStopPortfolio, admittedByTightening } = await import('./coil-stop-portfolio.mjs');
    const args = process.argv.slice(2);
    const flag = (n, dft) => { const i = args.indexOf(n); return i === -1 ? dft : args[i + 1]; };
    const inst = JSON.parse(readFileSync(flag('--instances', 'data/lab/coil-stop-instances.json'), 'utf8'));
    const prereg = JSON.parse(readFileSync(flag('--prereg', 'data/lab/coil-stop-prereg.json'), 'utf8'));
    const v = verifyStopPrereg(prereg);
    if (!v.ok) { process.stderr.write(`REFUSING to score: prereg hash mismatch (expected ${v.expected}, found ${v.found}).\n`); process.exit(4); }

    const bps = prereg.friction_bps.representative;
    const slipBps = prereg.stop_slippage_bps;
    const boot = { iterations: prereg.bootstrap.iterations, seed: prereg.bootstrap.seed, blockSessions: prereg.bootstrap.block_sessions };
    const S = prereg.primary_stop_pct;            // 0.05
    const BASE = prereg.baseline_stop_pct;        // 0.07
    const floorA = prereg.decision_rule.dd_reduction_floor;       // 0.90
    const floorB = prereg.decision_rule.return_retention_floor;   // 0.90
    const marginal = inst.marginal || [];
    const mHold = marginal.filter(r => r.split === 'holdout');
    const mTrain = marginal.filter(r => r.split === 'train');

    const candOf = (s, split, slip = 0) => frictionizeCandidates(
      (inst.portfolio[String(s)] || []).filter(c => c.split === split), { bps, stopSlipBps: slip });

    // TRAIN kill-gate (in-sample): KEEP early if BOTH gates already fail in-sample.
    const t05 = simulateStopPortfolio(candOf(S, 'train'));
    const t07 = simulateStopPortfolio(candOf(BASE, 'train'));
    const trainGateA = Math.abs(t05.maxDrawdown) <= floorA * Math.abs(t07.maxDrawdown);
    const trainGateB = t05.totalNet >= floorB * t07.totalNet;
    const killed = (mTrain.length > 0) && !trainGateA && !trainGateB;

    // FROZEN HOLDOUT (read once).
    const rows = stopDeltas(mHold, S, { frictionBps: bps });
    const decomp = saveWhipsawDecomp(rows);
    const deltaCI = bootstrapMeanCI(rows.map(r => ({ date: r.date, net: r.net })), boot);
    const capped = winsorizeUpside(rows.map(r => r.net), prereg.winsorize_pct);
    const deltaCIw = bootstrapMeanCI(rows.map((r, i) => ({ date: r.date, net: capped[i] })), boot);

    const p05 = simulateStopPortfolio(candOf(S, 'holdout'));
    const p07 = simulateStopPortfolio(candOf(BASE, 'holdout'));
    const cvar05 = cvar(p05.fills.map(f => f.net), 0.05);
    const cvar07 = cvar(p07.fills.map(f => f.net), 0.05);
    const gateA = Math.abs(p05.maxDrawdown) <= floorA * Math.abs(p07.maxDrawdown);
    const gateB = p05.totalNet >= floorB * p07.totalNet;
    const returnsBaselineNonPositive = p07.totalNet <= 0;
    const admitted = admittedByTightening(p07, p05);

    // Stop-slippage arm.
    const p05slip = simulateStopPortfolio(candOf(S, 'holdout', slipBps));
    const gateAslip = Math.abs(p05slip.maxDrawdown) <= floorA * Math.abs(p07.maxDrawdown);
    const gateBslip = p05slip.totalNet >= floorB * p07.totalNet;

    // Gate-A audit: baseline deepest DD train vs holdout over the FULL series.
    const dd = ddPlacement(
      simulateStopPortfolio([...candOf(BASE, 'train'), ...candOf(BASE, 'holdout')]).curve,
      inst.boundaryDate, prereg.decision_rule.dd_untested_ratio);

    const verdict = killed
      ? { verdict: 'KEEP', reason: 'train kill-gate: both gates already fail in-sample' }
      : decideStop({ gateA, gateB, nMarginal: decomp.n, powerFloorN: prereg.power_floor_n });
    const slipFragile = verdict.verdict === 'TIGHTEN' && !(gateAslip && gateBslip);

    // Secondary stops (exploratory).
    const secondary = {};
    for (const s2 of prereg.secondary_stop_pct) {
      const r2 = stopDeltas(mHold, s2, { frictionBps: bps });
      const pp = simulateStopPortfolio(candOf(s2, 'holdout'));
      const d2 = saveWhipsawDecomp(r2);
      secondary[s2] = { net: d2.net, pNet: pp.totalNet, maxDD: pp.maxDrawdown, nWhipsaw: d2.nWhipsaw };
    }

    const md = renderResults({
      prereg, bps, boundaryDate: inst.boundaryDate, verdict,
      decomp, deltaCI, deltaCIw, p05, p07, cvar05, cvar07, gateA, gateB, floorA, floorB,
      returnsBaselineNonPositive, admitted, p05slip, gateAslip, gateBslip, slipFragile, dd, secondary,
    });
    const out = flag('--out', 'docs/lab/coil-stop-tighten-RESULTS.md');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md);
    process.stdout.write(`VERDICT: ${verdict.verdict} (${verdict.reason})${slipFragile ? ' [slip-fragile]' : ''}. Wrote ${out}\n`);
  }
}
