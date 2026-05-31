// scripts/stage1-score.mjs
// Stage 1 scorer: HR + one-sided binomial (Bonferroni alpha/k) + date-block bootstrap
// + verdict gate (spec §6). CLI refuses to score the holdout without a verified artifact.

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binomialUpperTailP } from './binomial-stats.mjs';
import { dateBlockBootstrapHR } from './stage1-bootstrap.mjs';
import { verifyPrereg } from './stage1-prereg.mjs';

export function scoreSplit(firings, artifact, { HR0Final }) {
  const n = firings.length;
  const hits = firings.reduce((s, f) => s + (f.hit ? 1 : 0), 0);
  const HR = n ? hits / n : 0;
  const requiredN = artifact.power.required_independent_n_per_split;
  const k = artifact.variants.k ?? 1;
  const alphaEff = artifact.power.alpha / k;
  const binomialP = binomialUpperTailP(hits, n, HR0Final);
  const boot = dateBlockBootstrapHR(firings, {
    blockSessions: artifact.bootstrap.block_sessions,
    iterations: artifact.bootstrap.iterations,
    seed: artifact.bootstrap.seed,
    percentile: 5,
  });

  let verdict;
  if (n < requiredN) {
    verdict = 'UNDERPOWERED';
  } else if (binomialP < alphaEff && boot.percentileHR !== null && boot.percentileHR > HR0Final) {
    verdict = 'PASS';
  } else {
    verdict = 'FAIL';
  }

  return {
    n, hits, HR: +HR.toFixed(6),
    HR0_final: HR0Final, required_n: requiredN,
    alpha_effective: alphaEff, k,
    binomial_p: binomialP,
    bootstrap_p5: boot.percentileHR,
    verdict,
    notes: verdict === 'UNDERPOWERED'
      ? `achievable n ${n} < required ${requiredN} — STOP, do not relax the bar`
      : artifact.bootstrap.residual_note,
  };
}

// CLI: cat firings.json | node scripts/stage1-score.mjs --artifact <path> --split holdout --hr0-final 0.55
{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const flag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
    const artifactPath = flag('--artifact');
    const split = flag('--split') ?? 'holdout';
    const hr0Final = Number(flag('--hr0-final'));
    if (!artifactPath || !Number.isFinite(hr0Final)) {
      process.stderr.write('Usage: cat firings.json | node scripts/stage1-score.mjs --artifact <path> --split <train|holdout> --hr0-final <num>\n');
      process.exit(2);
    }
    let artifact;
    try { artifact = JSON.parse(readFileSync(artifactPath, 'utf8')); }
    catch (err) { process.stderr.write(`cannot read artifact: ${err.message}\n`); process.exit(3); }

    const v = verifyPrereg(artifact);
    if (split === 'holdout' && !v.ok) {
      process.stderr.write(`REFUSING to score holdout: prereg hash mismatch (expected ${v.expected}, found ${v.found}). The artifact was altered after registration.\n`);
      process.exit(4);
    }
    let stdin = '';
    process.stdin.on('data', c => { stdin += c; });
    process.stdin.on('end', () => {
      let all;
      try { all = JSON.parse(stdin); } catch (err) { process.stderr.write(`stdin not JSON: ${err.message}\n`); process.exit(2); }
      const firings = all.filter(f => (f.split ?? split) === split);
      const result = scoreSplit(firings, artifact, { HR0Final: hr0Final });
      process.stdout.write(JSON.stringify({ split, ...result }, null, 2) + '\n');
    });
  }
}
