// scripts/coil-opt-score.mjs
// Pure decision helpers for the Coil options-overlay feasibility model + the data-coupled
// sweep/RESULTS CLI (appended below the guard; reads the Coil tape + daily bar-cache).
import { mean } from './coil-threshold-metrics.mjs';

export function tailRiskRatio(pnls) {
  if (!pnls.length) return null;
  const s = [...pnls].sort((a, b) => a - b);
  const k = Math.max(1, Math.floor(s.length * 0.1));
  const worst = mean(s.slice(0, k));
  return worst >= 0 ? Infinity : mean(pnls) / Math.abs(worst);
}
export function decideCallKill(bestCellMean) {
  return { killed: bestCellMean <= 0, bestCellMean };
}
export function decidePutGate({ bandCIlos, spikeOn, tailRatio, stockTailRatio }) {
  const bandOk = bandCIlos.length > 0 && bandCIlos.every(lo => lo > 0);
  const pass = bandOk && spikeOn && tailRatio > stockTailRatio;
  return { pass, bandOk, spikeOn, beatsStock: tailRatio > stockTailRatio };
}

function median(xs) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

// CLI: node scripts/coil-opt-score.mjs --root <repo-with-data> --tape <instances.json> --out <md>
{
  const argv1 = process.argv[1] ? (await import('node:path')).resolve(process.argv[1]) : '';
  const here = (await import('node:url')).fileURLToPath(import.meta.url);
  if (here === argv1) {
    const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { winRate, bootstrapMeanCI } = await import('./coil-threshold-metrics.mjs');
    const { loadBars } = await import('./coil-eventstudy-bars.mjs');
    const { trailingRealizedVol } = await import('./coil-opt-rv.mjs');
    const { callPnl, putPnlMirror, putPnlHoldToExpiry, exitIV } = await import('./coil-opt-overlay.mjs');
    const { bsPrice } = await import('./coil-opt-bsm.mjs');

    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const root = flag('--root', process.cwd());
    const tapePath = flag('--tape', join(root, 'data', 'lab', 'coil-threshold-instances.json'));
    const out = flag('--out', join(process.cwd(), 'docs', 'lab', 'coil-options-overlay-RESULTS.md'));
    const R = 0.04;

    const tape = JSON.parse(readFileSync(tapePath, 'utf8'))
      .filter(t => t.bucket === '[0,5)' && !t.censored && Number.isFinite(t.entry) && Number.isFinite(t.exit));

    // Per-trade enrichment (cell-independent): trailing RV at entry + expiry underlying per DTE.
    const DTES = [7, 14, 30];
    const barsByTicker = new Map();
    const getBars = (tk) => { if (!barsByTicker.has(tk)) barsByTicker.set(tk, loadBars(root, tk)); return barsByTicker.get(tk); };
    const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

    const enriched = [];
    let dropped = 0;
    for (const t of tape) {
      const bars = getBars(t.ticker);
      const ei = bars.findIndex(b => b.date === t.date);
      if (ei < 20) { dropped += 1; continue; }
      const closes = bars.map(b => b.close);
      const rv = { 5: trailingRealizedVol(closes, ei, 5), 20: trailingRealizedVol(closes, ei, 20) };
      if (rv[5] == null || rv[20] == null) { dropped += 1; continue; }
      const sExp = {};
      for (const dte of DTES) {
        const target = addDays(t.date, dte);
        let j = ei; while (j + 1 < bars.length && bars[j + 1].date <= target) j += 1;
        sExp[dte] = bars[j].close;
      }
      enriched.push({ date: t.date, ticker: t.ticker, S0: t.entry, S1: t.exit, daysHeld: t.daysHeld, grossReturn: t.grossReturn, rv, sExp });
    }

    const boot = { iterations: 10000, seed: 1234, blockSessions: 15 };
    const WINDOWS = [5, 20], PREMS = [0.8, 1.0, 1.2, 1.5], CRUSH = [0, 0.2, 0.4], SPIKE = [0, 0.3, 0.6], SPREADS = [0.05, 0.10];
    const stockMean = mean(enriched.map(e => e.grossReturn));
    const stockTailRatio = tailRiskRatio(enriched.map(e => e.grossReturn));
    const central = { w: 5, p: 1.2, s: 0.10, dte: 14 };

    // --- Call sweep. Return-on-premium is right-skewed + denominator-gamed (cheap-IV cells), so
    //     the KILL is on PER-NOTIONAL $-return vs simply holding the stock: a leveraged overlay
    //     must beat the underlying. Return-on-premium is reported only as flagged context. ---
    const callPerNotional = (e, w, p, cr, sp, s, dte) => {
      const iv = e.rv[w] * p;
      const entry = bsPrice('call', e.S0, e.S0, dte / 365, R, iv);
      if (entry <= 0) return null;
      const Tx = (dte - e.daysHeld) / 365;
      const exit = Tx > 0 ? bsPrice('call', e.S1, e.S0, Tx, R, exitIV(iv, e.S0, e.S1, cr, sp)) : Math.max(0, e.S1 - e.S0);
      return (exit * (1 - s / 2) - entry * (1 + s / 2)) / e.S0;   // $-P&L per $ underlying notional
    };
    let bestNotional = -Infinity, bestNotionalCell = null, bestPrem = -Infinity, bestPremCell = null;
    for (const w of WINDOWS) for (const p of PREMS) for (const cr of CRUSH) for (const sp of SPIKE) for (const s of SPREADS) for (const dte of DTES) {
      const pn = [], pr = [];
      for (const e of enriched) {
        const n = callPerNotional(e, w, p, cr, sp, s, dte); if (n != null) pn.push(n);
        const v = callPnl({ S0: e.S0, S1: e.S1, daysHeld: e.daysHeld, ivEntry: e.rv[w] * p, dte, r: R, crush: cr, spike: sp, spreadPct: s }); if (Number.isFinite(v)) pr.push(v);
      }
      const mn = mean(pn), mp = mean(pr);
      if (mn != null && mn > bestNotional) { bestNotional = mn; bestNotionalCell = { w, p, cr, sp, s, dte }; }
      if (mp != null && mp > bestPrem) { bestPrem = mp; bestPremCell = { w, p, cr, sp, s, dte }; }
    }
    // KILLED iff the best per-notional cell still fails to beat just holding the stock.
    const callKill = decideCallKill(bestNotional - stockMean);
    const callCentralPrem = enriched.map(e => callPnl({ S0: e.S0, S1: e.S1, daysHeld: e.daysHeld, ivEntry: e.rv[central.w] * central.p, dte: central.dte, r: R, crush: 0.2, spike: 0.3, spreadPct: central.s })).filter(Number.isFinite);
    const callCentralNotional = enriched.map(e => callPerNotional(e, central.w, central.p, 0.2, 0.3, central.s, central.dte)).filter(x => x != null);

    // --- Put gate: hold-to-expiry over a BAND (crush/spike don't affect hold-to-expiry; its tail
    //     is the assignment intrinsic). Band varies the params that DO bite. ---
    const holdRows = ({ w, p, s, dte }) => enriched.map(e => ({ date: e.date, net: putPnlHoldToExpiry({ S0: e.S0, S_exp: e.sExp[dte], ivEntry: e.rv[w] * p, dte, r: R, spreadPct: s }) }));
    const band = [central, { w: 20, p: 1.2, s: 0.10, dte: 14 }, { w: 5, p: 0.8, s: 0.10, dte: 14 }, { w: 5, p: 1.5, s: 0.10, dte: 14 }, { w: 5, p: 1.2, s: 0.10, dte: 30 }];
    const bandCIs = band.map(c => ({ cell: c, ci: bootstrapMeanCI(holdRows(c), boot) }));
    const centralHoldPnls = holdRows(central).map(r => r.net);
    const holdTailRatio = tailRiskRatio(centralHoldPnls);
    const putGate = decidePutGate({ bandCIlos: bandCIs.map(b => b.ci.lo), spikeOn: true, tailRatio: holdTailRatio, stockTailRatio });

    // --- Mirror-exit corroboration: central vs loser-spike-stress ---
    const mirrorRows = (spike) => enriched.map(e => ({ date: e.date, net: putPnlMirror({ S0: e.S0, S1: e.S1, daysHeld: e.daysHeld, ivEntry: e.rv[central.w] * central.p, dte: central.dte, r: R, crush: 0.2, spike, spreadPct: central.s }) }));
    const mirrorCentral = bootstrapMeanCI(mirrorRows(0.3), boot);
    const mirrorSpikeStress = bootstrapMeanCI(mirrorRows(0.6), boot);

    const worstDecile = (xs) => { const s = [...xs].sort((a, b) => a - b); return mean(s.slice(0, Math.max(1, Math.floor(s.length * 0.1)))); };

    const md = render({
      n: enriched.length, dropped, callKill, bestNotional, bestNotionalCell, bestPrem, bestPremCell,
      callCentralNotionalMean: mean(callCentralNotional), callCentralPremMean: mean(callCentralPrem),
      callCentralPremMedian: median(callCentralPrem), callCentralWin: winRate(callCentralPrem),
      putGate, band: bandCIs, central,
      holdCentralMean: mean(centralHoldPnls), holdCentralWin: winRate(centralHoldPnls),
      holdTailRatio, stockTailRatio, holdWorstDecile: worstDecile(centralHoldPnls),
      stockMean, mirrorCentral, mirrorSpikeStress,
    });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md);
    process.stdout.write(`CALL: ${callKill.killed ? 'KILLED (best per-notional ≤ stock)' : 'NOT killed'} (best per-notional ${pct(bestNotional)} vs stock ${pct(stockMean)}). PUT: ${putGate.pass ? 'gate PASS' : 'gate FAIL'}. n=${enriched.length}. Wrote ${out}\n`);
  }
}

function pct(x) { return x == null ? 'n/a' : (x * 100).toFixed(2) + '%'; }
function rr(x) { return x == null ? 'n/a' : (Number.isFinite(x) ? x.toFixed(3) : '∞'); }
function render(d) {
  const L = [];
  L.push('# Coil Options-Overlay — Feasibility Model Results', '');
  const callVerdict = d.callKill.killed
    ? 'KILLED (even best cell ≤ stock)'
    : (d.callCentralNotionalMean < d.stockMean
      ? `not cheap-killed, but central cell underperforms the stock (per-notional ${pct(d.callCentralNotionalMean)} < ${pct(d.stockMean)})`
      : 'NOT killed — investigate');
  L.push(`**CALL: ${callVerdict}** · **PUT: ${d.putGate.pass ? 'gate PASS (worth real options data)' : 'gate FAIL'}**`, '');
  L.push(`MODEL, not a backtest — assumption-driven (entry IV = trailing-RV proxy; state-dependent exit IV; BS-European, no American early assignment; no skew). Decides "is real options data worth buying," NOT "trade this." n=${d.n} Coil [0,5) trades (${d.dropped} dropped). **Coil stock edge: mean ${pct(d.stockMean)}/trade, tail-risk ratio ${rr(d.stockTailRatio)}** — the bar any overlay must beat.`, '');
  L.push('## Long calls (mirror Coil stock exit)', '');
  L.push(`- **KILL test = best PER-NOTIONAL cell vs the stock.** A leveraged overlay must beat simply holding the name. Best per-notional cell = ${pct(d.bestNotional)} (${JSON.stringify(d.bestNotionalCell)}) vs stock ${pct(d.stockMean)} → KILLED iff ≤ stock → **${d.callKill.killed ? 'KILLED' : 'survives — investigate'}**.`);
  L.push(`- central cell per-notional: ${pct(d.callCentralNotionalMean)} (vs stock ${pct(d.stockMean)}); win ${pct(d.callCentralWin)}.`);
  L.push(`- *return-on-premium (NOT a decision basis — right-skewed + cheap-IV-denominator gamed):* central mean ${pct(d.callCentralPremMean)}, **median ${pct(d.callCentralPremMedian)}** (the typical trade), best-cell mean ${pct(d.bestPrem)} at ${JSON.stringify(d.bestPremCell)} (the cheapest-premium corner — an artifact, not edge).`, '');
  L.push('## Short put — hold to expiry (natural CSP; return on collateral)', '');
  L.push(`- central cell: mean ${pct(d.holdCentralMean)}, win ${pct(d.holdCentralWin)}, worst-decile ${pct(d.holdWorstDecile)}, **tail-risk ratio ${rr(d.holdTailRatio)} (vs stock ${rr(d.stockTailRatio)})**.`);
  L.push('- band (CI lo must be >0 in ALL for a pass):');
  for (const b of d.band) L.push(`  - ${JSON.stringify(b.cell)}: mean ${pct(b.ci.mean)} CI [${pct(b.ci.lo)}, ${pct(b.ci.hi)}]`);
  L.push(`- **gate:** band-all-CI>0 = ${d.putGate.bandOk}; tail-ratio beats stock = ${d.putGate.beatsStock}; tail modeled = ${d.putGate.spikeOn} → **${d.putGate.pass ? 'PASS' : 'FAIL'}**.`, '');
  L.push('## Short put — mirror exit corroboration (where the loser vol-spike bites)', '');
  L.push(`- central (spike 30%): mean ${pct(d.mirrorCentral.mean)} CI [${pct(d.mirrorCentral.lo)}, ${pct(d.mirrorCentral.hi)}]`);
  L.push(`- loser-spike STRESS (spike 60%): mean ${pct(d.mirrorSpikeStress.mean)} CI [${pct(d.mirrorSpikeStress.lo)}, ${pct(d.mirrorSpikeStress.hi)}]`, '');
  L.push('## Honest ceiling & limitations', '');
  L.push('- BS-European cannot model American **early assignment** (clusters on the deep-ITM losers) nor skew/term-structure — all err ROSY on the short-put tail. A put pass = **"buy real options chains to test the assignment tail,"** never "trade it." The model reliably KILLS calls; it only gates the data-spend for puts.');
  L.push('- Long-call return-on-premium is intentionally NOT the decision metric: it is right-skewed (a few big winners) and inflated where entry IV is understated (cheap premium → huge %); the per-notional-vs-stock test is the sound one.');
  L.push('- Entry IV is an RV proxy (5-day primary, spike-aware); loser-spike magnitude is a guess; r=0.04 flat (immaterial). ATM only (strike is the next axis if puts survive). Off the fleet ballast thesis regardless (leveraged/short-vol overlay on a long-biased edge).');
  return L.join('\n');
}
