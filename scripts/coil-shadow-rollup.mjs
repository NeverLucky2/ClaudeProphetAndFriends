import { assignGroups } from './lib/coil-shadow-groups.mjs';
import { fitWithinClustered, computeVerdict, futilityGate } from './lib/coil-shadow-stats.mjs';
import { makeFsIo } from './lib/coil-shadow-io.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }

// runRollup loads closed episodes, fits the pre-registered regression, and emits
// either the terminal verdict or the futility gate (never a KEEP at the gate).
export async function runRollup({ io, stage = 'terminal' }) {
  const all = await io.readEpisodes();
  const closed = all.filter((e) => e.status === 'closed' && (e.tag === 'fire_early' || e.tag === 'declined'));
  const { A, M } = assignGroups(closed);

  const rows = closed.map((e) => ({ ret: e.ret, fireEarly: e.tag === 'fire_early' ? 1 : 0,
    rsi2: e.rsi2AtEntry, sma5Gap: e.sma5GapAtEntry, sma200Gap: e.sma200GapAtEntry,
    day: e.openDate, name: e.name }));

  const fit = fitWithinClustered(rows);
  const aVsM = mean(A.map((e) => e.ret)) - mean(M.map((e) => e.ret)); // robustness read
  const aVsMStr = Number.isNaN(aVsM) ? 'n/a (no A or M episodes)' : `${(aVsM * 100).toFixed(3)}%`;

  const lines = [
    `# Coil Shadow Eval — ${stage} rollup`,
    ``,
    `N (closed A∪B): ${rows.length}   N_A: ${A.length}   clusters(names): ${fit.nClusters}   identifying days: ${fit.nIdentifyingDays}`,
    `beta (fire_early): ${(fit.beta * 100).toFixed(3)}%   clustered SE: ${(fit.se * 100).toFixed(3)}%   (naive SE: ${(fit.naiveSe * 100).toFixed(3)}%)`,
    `one-sided 90% CI: [${(fit.ciLower * 100).toFixed(3)}%, ${(fit.ciUpper * 100).toFixed(3)}%]`,
    `regression columns kept: ${fit.keptCols}/7 (fire_early + 4 RSI buckets + 2 gaps; empty/constant controls dropped)`,
    `robustness A-vs-M mean-return gap: ${aVsMStr}`,
  ];

  if (stage === 'futility') {
    const gate = futilityGate(fit);
    lines.push(``, `Futility gate: ${gate === 'early-reject' ? 'EARLY-REJECT (worthwhile edge already ruled out)' : 'CONTINUE'}`);
    return { gate, beta: fit.beta, ciLower: fit.ciLower, ciUpper: fit.ciUpper, nA: A.length,
      nIdentifyingDays: fit.nIdentifyingDays, aVsM, report: lines.join('\n') };
  }
  const verdict = computeVerdict(fit);
  const disagree = A.length && M.length && Math.sign(aVsM) !== Math.sign(fit.beta);
  lines.push(``, `VERDICT: ${verdict}`);
  if (verdict === 'KEEP' && disagree) lines.push(`⚠ A-vs-M disagrees in sign — run the nonlinear RSI diagnostic before filing KEEP (pre-registered).`);
  return { verdict, beta: fit.beta, ciLower: fit.ciLower, ciUpper: fit.ciUpper, nA: A.length,
    nIdentifyingDays: fit.nIdentifyingDays, aVsM, report: lines.join('\n') };
}

async function main() {
  const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const io = makeFsIo(path.join(PROJECT_ROOT, 'data', 'coil-shadow'));
  const stage = process.argv.includes('--futility') ? 'futility' : 'terminal';
  const r = await runRollup({ io, stage });
  console.log(r.report);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`coil-shadow-rollup failed: ${e.message}`); process.exit(1); });
}
