// scripts/eov-score.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mean, bootstrapMeanCI } from './coil-threshold-metrics.mjs';
import { olsBeta } from './ema-beta.mjs';

export const netSpread = (gross, bps) => gross - 4 * bps / 1e4;
export const netLeg = (gross, bps) => gross - 2 * bps / 1e4;

export function estimateSpreadBeta(trainRows, bps) {
  const a = [], b = [];
  for (const r of trainRows) if (Number.isFinite(r.grossSpread) && Number.isFinite(r.qqqRet)) { a.push(netSpread(r.grossSpread, bps)); b.push(r.qqqRet); }
  return olsBeta(a, b);
}

export function betaNeutralResidSeries(rows, bps, beta) {
  return rows
    .filter(r => Number.isFinite(r.grossSpread) && Number.isFinite(r.qqqRet))
    .map(r => ({ date: r.date, net: netSpread(r.grossSpread, bps) - beta * r.qqqRet }));
}

export const orientRows = (rows, dstar) => rows.map(r => ({ date: r.date, net: Math.sign(dstar) * r.net }));

export function decideEov({ trainGateLo, gateALo, gateBLo, nDatesHoldout, nNameTrades, powerFloor }) {
  if (nDatesHoldout < powerFloor.distinct_dates || nNameTrades < powerFloor.name_trades) {
    return { verdict: 'UNDERPOWERED', reason: `holdout ${nDatesHoldout}d / ${nNameTrades} name-trades < ${powerFloor.distinct_dates}/${powerFloor.name_trades}` };
  }
  if (!(trainGateLo > 0)) return { verdict: 'NO-SIGNAL', reason: 'train oriented CI lo<=0; no in-sample direction to confirm' };
  const gA = gateALo > 0, gB = gateBLo > 0;
  if (gA && gB) return { verdict: 'KEEP-CANDIDATE', reason: 'train signal + gate_a + gate_b all pass' };
  return { verdict: 'REJECT', reason: `gate_a=${gA} gate_b=${gB}` };
}

function r4(x) { return x == null ? 'n/a' : Number(x).toFixed(4); }

// CLI
{
  const argv1 = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1) {
    const { verifyEovPrereg } = await import('./eov-prereg.mjs');
    const args = process.argv.slice(2); const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
    const root = process.cwd();
    const bundle = JSON.parse(readFileSync(flag('--instances', 'data/lab/eov-instances.json'), 'utf8'));
    const prereg = JSON.parse(readFileSync(flag('--prereg', 'data/lab/eov-prereg.json'), 'utf8'));
    const v = verifyEovPrereg(prereg);
    if (!v.ok) { process.stderr.write(`REFUSING to score: prereg hash mismatch (expected ${v.expected}, found ${v.found}).\n`); process.exit(4); }

    const bps = prereg.friction_bps.equity.decision;
    const boot = { iterations: prereg.bootstrap.iterations, seed: prereg.bootstrap.seed, blockSessions: prereg.bootstrap.block_sessions };
    const H = 3;
    const sp = bundle.spread[H];
    const trainSp = sp.filter(r => r.split === 'train'), holdSp = sp.filter(r => r.split === 'holdout');

    // Stage 1: beta on train, d*, train oriented CI
    const betaSpread = estimateSpreadBeta(trainSp, bps);
    const trainResid = betaNeutralResidSeries(trainSp, bps, betaSpread);
    const dstar = Math.sign(mean(trainResid.map(r => r.net)) ?? 0) || 1;
    const trainGate = bootstrapMeanCI(orientRows(trainResid, dstar), boot);

    // Stage 2: Gate A (holdout oriented spread_resid)
    const holdResid = betaNeutralResidSeries(holdSp, bps, betaSpread);
    const gateA = bootstrapMeanCI(orientRows(holdResid, dstar), boot);

    // Gate B: held leg per-name beta-adjusted alpha on holdout
    const heldLeg = dstar > 0 ? 'top' : 'bottom';
    const trainDates = new Set(bundle.meta.validDates.slice(0, bundle.meta.trainN));
    const qByDate = new Map(bundle.nameDailyRet.QQQ.map(x => [x.date, x.ret]));
    const betaByName = {};
    for (const tk of prereg.universe) {
      const aR = [], bR = [];
      for (const x of (bundle.nameDailyRet[tk] || [])) { if (!trainDates.has(x.date)) continue; const q = qByDate.get(x.date); if (q != null) { aR.push(x.ret); bR.push(q); } }
      betaByName[tk] = olsBeta(aR, bR);
    }
    const legRows = bundle.legs[H].filter(r => r.leg === heldLeg && r.split === 'holdout' && Number.isFinite(r.grossRet) && Number.isFinite(r.qqqRet))
      .map(r => ({ date: r.date, net: netLeg(r.grossRet, bps) - (betaByName[r.ticker] ?? 0) * r.qqqRet }));
    const gateB = bootstrapMeanCI(legRows, boot);

    // Robustness: spread_resid sign at h=1,5
    const robustness = {};
    for (const h of [1, 5]) {
      const rows = betaNeutralResidSeries(bundle.spread[h].filter(r => r.split === 'holdout'), bps, betaSpread);
      robustness[h] = Math.sign(mean(rows.map(r => r.net)) ?? 0);
    }

    const nDatesHoldout = new Set(holdSp.map(r => r.date)).size;
    const verdict = decideEov({ trainGateLo: trainGate.lo, gateALo: gateA.lo, gateBLo: gateB.lo, nDatesHoldout, nNameTrades: legRows.length, powerFloor: prereg.power_floor });

    const dir = dstar > 0 ? 'MOMENTUM (long high-EOV)' : 'REVERSAL (long low-EOV)';
    const L = [];
    L.push('# Reduced-EOV Backtest — Results', '');
    L.push(`**Verdict: ${verdict.verdict}** — ${verdict.reason}`, '');
    L.push(`Half-signal **proxy** (call-volume intensity only; no open-interest half). Prereg hash \`${prereg.artifact_hash}\`. Friction ${bps}bps. Direction fixed on train: **${dir}** (d*=${dstar}). Expected: REJECT.`, '');
    L.push('## Confirmatory cell (long-short, h=3, beta-neutral)', '', '| stage | n | mean | CI lo | CI hi |', '|---|---|---|---|---|');
    L.push(`| train oriented spread_resid | ${trainGate.n} | ${r4(trainGate.mean)} | ${r4(trainGate.lo)} | ${r4(trainGate.hi)} |`);
    L.push(`| Gate A holdout oriented spread_resid | ${gateA.n} | ${r4(gateA.mean)} | ${r4(gateA.lo)} | ${r4(gateA.hi)} |`);
    L.push(`| Gate B holdout held-leg alpha (${heldLeg}) | ${gateB.n} | ${r4(gateB.mean)} | ${r4(gateB.lo)} | ${r4(gateB.hi)} |`);
    L.push('', `- spread-vs-QQQ train beta: ${r4(betaSpread)}; holdout distinct dates: ${nDatesHoldout}; held-leg name-trades: ${legRows.length}`);
    L.push(`- robustness sign (want = d*=${dstar}): h1=${robustness[1]}, h5=${robustness[5]}`, '');
    L.push('## Limitations', '', ...prereg.limitations.map(s => `- ${s}`));
    L.push('', '_Lab-only. A KEEP-CANDIDATE authorizes only forward paper-collection confirmation, never deployment._');
    const out = flag('--out', join(root, 'docs', 'lab', 'eov-RESULTS.md'));
    mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, L.join('\n'));
    process.stdout.write(`VERDICT: ${verdict.verdict} (${verdict.reason}). Wrote ${out}\n`);
  }
}
