// scripts/overlay-report.mjs
// RESULTS.md renderer for the hedge-overlay study (controller-data-coupled shape, pure string fn).
const f = (x, d = 3) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
const pc = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : (100 * x).toFixed(d) + '%');
const cuc = (c) => (c ? `${pc(c.mean)} [${pc(c.lo)},${pc(c.hi)}] (episodes ${c.episodes})` : '—');

export function renderReport(model) {
  const L = [];
  L.push('# Fleet Hedge-Overlay — RESULTS', '');
  L.push(`**Pre-registration hash (sha256):** \`${model.preregHash || '—'}\``);
  L.push('**Lab-only, reconstructed returns.** Cost = **calm-period (non-crisis) drag**; benefit = crash-conditional **cushion** (paired-difference bootstrap CI) split lumped / rate-shock / growth-scare. Convex candidates (def-Prophet, VIXM) carry a stress grid + the §7 convexity guard. Recommendation read against the **conservative book-funded** drag bound.', '');

  const dw = model.dataWall || {};
  L.push('## Task 0 — Data-wall provenance', '');
  L.push(`- VIXM earliest: \`${dw.vixm || '—'}\` (covers 2016 window: ${dw.vixmCoversWindow ? 'yes' : 'NO'})`);
  L.push(`- Treasury curve earliest: \`${dw.curve || '—'}\` (covers window: ${dw.curveCoversWindow ? 'yes' : 'NO'})`);
  if (dw.suppressed && dw.suppressed.length) L.push(`- **Suppressed eras (dropped-weight > 30%, Merrill target):** ${dw.suppressed.join(', ')}`);
  L.push('');
  if (dw.droppedByYear) {
    L.push('| Year | dropped book weight |', '|---|--:|');
    for (const y of Object.keys(dw.droppedByYear).sort()) L.push(`| ${y} | ${pc(dw.droppedByYear[y])} |`);
    L.push('');
  }

  for (const t of model.targets) {
    L.push(`## Target: ${t.name}`, '');
    L.push('| Candidate | size | calm drag/yr | cushion lumped | rate-shock | growth-scare | efficiency | regime |');
    L.push('|---|--:|--:|:--|:--|:--|--:|:--|');
    for (const r of t.rows) {
      const eff = r.efficiency && r.efficiency.flag === 'free_ballast' ? 'free_ballast' : f(r.efficiency && r.efficiency.value, 2);
      L.push(`| ${r.candidate} | ${r.size} | ${pc(r.calmDrag)} | ${cuc(r.lumped)} | ${cuc(r.rateShock)} | ${cuc(r.growthScare)} | ${eff} | ${r.regimeClass} |`);
    }
    L.push('');
    if (t.stress && t.stress.length) {
      L.push('### Stress-shock payoff (convex candidates, sample-independent)', '');
      L.push('| Candidate | −10% | −20% | −30% |', '|---|--:|--:|--:|');
      for (const s of t.stress) L.push(`| ${s.candidate} | ${f(s.grid['-0.1'] ?? s.grid['-0.10'])} | ${f(s.grid['-0.2'] ?? s.grid['-0.20'])} | ${f(s.grid['-0.3'] ?? s.grid['-0.30'])} |`);
      L.push('');
    }
    L.push('### Recommendation', '');
    L.push(`**Branch ${t.recommendation.branch}** — ${t.recommendation.text}`, '');
  }
  return L.join('\n') + '\n';
}
