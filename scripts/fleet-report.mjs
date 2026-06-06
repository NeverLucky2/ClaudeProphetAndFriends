// scripts/fleet-report.mjs
// Per-lane classification (primary, from full-sample beta + CI) + a descriptive crisis tail note.
// The controller appends renderReport() (data-coupled) separately.

// Primary class from the full-sample beta and its bootstrap CI. ECONOMIC MAGNITUDE governs —
// a statistically-significant but tiny beta (e.g. 0.04) is still ballast, so significance cannot
// promote a trivial beta out of genuine_ballast:
//   - significantly NEGATIVE beta (CI entirely < 0) = hedge-like = genuine ballast
//   - economically negligible |beta| < 0.2 = genuine ballast (regardless of CI)
//   - large positive (beta >= 0.4) AND CI clears 0 = overt long-beta
//   - otherwise (moderate 0.2..0.4, or large-but-insignificant) = mild overlap
export function classifyLane({ fullBeta, betaLo, betaHi }) {
  if (betaHi != null && betaHi < 0) return 'genuine_ballast';
  if (Math.abs(fullBeta) < 0.2) return 'genuine_ballast';
  const ciAbove0 = betaLo != null && betaLo > 0;
  if (ciAbove0 && fullBeta >= 0.4) return 'overt_long_beta';
  return 'mild_overlap';
}

// Descriptive crisis-behavior note (NOT a class). Driven by the crisis-mean bootstrap CI and
// whether rho_crisis sits beyond its rotation band. Honest insufficient-power gate first.
export function tailNote({ crisisMeanLo, crisisMeanHi, rhoCrisis, rhoBandP95, effN, nFloor = 8 }) {
  if (effN == null || effN < nFloor) return 'insufficient_power';
  const coCrash = crisisMeanHi != null && crisisMeanHi < 0;     // whole crisis-mean CI below 0
  const cushions = crisisMeanLo != null && crisisMeanLo > 0;    // whole crisis-mean CI above 0
  const tailCoMove = rhoCrisis != null && rhoBandP95 != null && rhoCrisis > rhoBandP95;
  if (coCrash) return tailCoMove ? 'co_crashes_with_tail_comove' : 'co_crashes';
  if (cushions) return 'cushions';
  return tailCoMove ? 'tail_comove_only' : 'tail_neutral';
}

// ── RESULTS.md renderer (controller-authored; data-coupled) ────────────────────────────────────
const f = (x, d = 3) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
const pc = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : (100 * x).toFixed(d) + '%');

export function renderReport(windows, { preregHash } = {}) {
  const L = [];
  L.push('# Fleet Correlation Diagnostic — RESULTS', '');
  L.push(`**Pre-registration hash (sha256):** \`${preregHash || '—'}\``);
  L.push('**Reconstructed PAPER returns** — co-movement is the signal, absolute levels are not. β levels are **gross, not net-economic** (high-turnover Coil overstates net β most). Benchmark = QQQ (the tech-book proxy).', '');
  L.push('> **Crisis cut is a descriptive lens.** Crisis-conditional **mean return** (bootstrap CI) is the primary ballast read; ρ_crisis / downside β are shown beside a rotation **context band** (p5/p50/p95 of the same stat under no real dependence — how much the crisis selection manufactures), never a binary verdict. Cells with < 8 nonzero crisis weeks are flagged **insufficient_power**. **def-Prophet** is a structural-light **proxy** (QQQ<200DMA → BSM put-spread); it is excluded from the full-sample β table and appears only in the crisis table — no timing-coverage claim.', '');
  for (const w of windows) {
    L.push(`## Window: ${w.name} — ${w.start} → ${w.end} (${w.nWeeks} weeks)`, '');
    L.push('### Full-sample β to QQQ + classification', '');
    L.push('| Lane | n | β (gross) | β 95% CI | ρ | ρ 95% CI | Spearman | class | basis |');
    L.push('|---|--:|--:|:--|--:|:--|--:|:--|:--|');
    for (const l of w.lanes) L.push(`| ${l.name} | ${l.n} | ${f(l.fullBeta)} | [${f(l.betaLo)}, ${f(l.betaHi)}] | ${f(l.corr)} | [${f(l.corrLo)}, ${f(l.corrHi)}] | ${f(l.spearman)} | **${l.class}** | ${l.sparse ? 'active-week' : 'full'} |`);
    L.push('');
    L.push('### Crisis-conditional (QQQ worst-quintile weeks)', '');
    L.push('| Lane | crisis effN | mean ret | mean 95% CI | ρ_crisis | rot band [p5,p95] | downside β | tail note |');
    L.push('|---|--:|--:|:--|--:|:--|--:|:--|');
    for (const c of w.crisisLanes) L.push(`| ${c.name} | ${c.effN} | ${pc(c.mean)} | [${pc(c.meanLo)}, ${pc(c.meanHi)}] | ${f(c.rhoCrisis)} | [${f(c.bandP5)}, ${f(c.bandP95)}] | ${f(c.downsideBeta)} | ${c.note} |`);
    L.push('');
    if (w.pairs && w.pairs.length) {
      L.push('### Edge-lane pairwise weekly correlation (Coil / Turtle / Drift)', '');
      L.push('| Pair | Pearson | Spearman | n |', '|---|--:|--:|--:|');
      for (const p of w.pairs) L.push(`| ${p.pair} | ${f(p.pearson)} | ${f(p.spearman)} | ${p.n} |`);
      L.push('');
    }
    L.push('### Synthesis', '');
    for (const s of w.synthesis) L.push(`- ${s}`);
    L.push('');
  }
  return L.join('\n') + '\n';
}
