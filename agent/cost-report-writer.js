// cost-report-writer: pure markdown rendering for the daily cost report
// (data/reports/cost_YYYY-MM-DD.md) and the --format markdown CLI output.
// All inputs are aggregateByAgent() output; no I/O lives here.

const DEFAULT_THRESHOLD_PCT = 15;

// daysBefore returns YYYY-MM-DD strings for the N calendar days strictly
// before `today` (today excluded). Newest last.
function daysBefore(today, n) {
  const out = [];
  const d = new Date(`${today}T00:00:00Z`);
  for (let i = n; i >= 1; i--) {
    const c = new Date(d);
    c.setUTCDate(c.getUTCDate() - i);
    out.push(c.toISOString().slice(0, 10));
  }
  return out;
}

function pctDelta(today, basis) {
  if (!basis || basis === 0) return null;
  return Math.round(((today - basis) / basis) * 100);
}

// computePerAgentSummary — for each agent in `agg`, returns
// { agentId, agentName, model, today: {cost, tokens, beatCount},
//   sevenDayAvg: {cost, tokens}, delta: {costPct, tokensPct} }.
// Missing days within the 7-day window count as 0.
export function computePerAgentSummary(agg, today) {
  const window = daysBefore(today, 7);
  const out = [];
  for (const [agentId, info] of Object.entries(agg)) {
    const todayCell = info.dates[today] || { cost: 0, tokens: 0, beatCount: 0 };
    const basisCells = window.map(d => info.dates[d] || { cost: 0, tokens: 0 });
    const basisCost = basisCells.reduce((s, c) => s + c.cost, 0) / 7;
    const basisTokens = basisCells.reduce((s, c) => s + c.tokens, 0) / 7;
    out.push({
      agentId,
      agentName: info.agentName,
      model: info.model,
      today: { cost: todayCell.cost, tokens: todayCell.tokens, beatCount: todayCell.beatCount },
      sevenDayAvg: { cost: basisCost, tokens: basisTokens },
      delta: { costPct: pctDelta(todayCell.cost, basisCost), tokensPct: pctDelta(todayCell.tokens, basisTokens) },
    });
  }
  return out;
}

// computeNotableShifts — finds (agent, phase) cells where today's cost
// has shifted |delta| >= thresholdPct vs 7-day-avg. Returns sorted by
// |delta| descending.
export function computeNotableShifts(agg, today, { thresholdPct = DEFAULT_THRESHOLD_PCT } = {}) {
  const window = daysBefore(today, 7);
  const shifts = [];
  for (const [agentId, info] of Object.entries(agg)) {
    const todayCell = info.dates[today];
    if (!todayCell) continue;
    const allPhases = new Set();
    for (const d of [today, ...window]) {
      const cell = info.dates[d];
      if (cell) for (const p of Object.keys(cell.phases)) allPhases.add(p);
    }
    for (const phase of allPhases) {
      const todayCost = (todayCell.phases[phase] || { cost: 0 }).cost;
      const basis = window.map(d => {
        const c = info.dates[d];
        return c && c.phases[phase] ? c.phases[phase].cost : 0;
      }).reduce((s, x) => s + x, 0) / 7;
      const delta = pctDelta(todayCost, basis);
      if (delta === null) continue;
      if (Math.abs(delta) >= thresholdPct) {
        shifts.push({ agentId, agentName: info.agentName, phase, todayCost, basis, deltaPct: delta });
      }
    }
  }
  shifts.sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
  return shifts;
}

function fmtMoney(n) { return `$${(n || 0).toFixed(2)}`; }
function fmtDelta(p) { return p === null ? '—' : (p >= 0 ? `+${p}%` : `−${Math.abs(p)}%`); }

export function renderDailyReportMarkdown(agg, today, { thresholdPct = DEFAULT_THRESHOLD_PCT } = {}) {
  const summary = computePerAgentSummary(agg, today)
    .sort((a, b) => b.today.cost - a.today.cost);
  const shifts = computeNotableShifts(agg, today, { thresholdPct });

  const totalToday = summary.reduce((s, x) => s + x.today.cost, 0);
  const totalBasis = summary.reduce((s, x) => s + x.sevenDayAvg.cost, 0);
  const totalDelta = pctDelta(totalToday, totalBasis);
  const totalBeats = summary.reduce((s, x) => s + x.today.beatCount, 0);

  let md = `# Daily Cost Report — ${today}\n\n`;
  md += `## Per-agent totals\n\n`;
  md += `| Agent | Today | 7d avg | Δ | Beats |\n`;
  md += `|---|---|---|---|---|\n`;
  for (const s of summary) {
    md += `| ${s.agentName} | ${fmtMoney(s.today.cost)} | ${fmtMoney(s.sevenDayAvg.cost)} | ${fmtDelta(s.delta.costPct)} | ${s.today.beatCount} |\n`;
  }
  md += `| **TOTAL** | ${fmtMoney(totalToday)} | ${fmtMoney(totalBasis)} | ${fmtDelta(totalDelta)} | ${totalBeats} |\n\n`;

  md += `## Notable shifts (|Δ| ≥ ${thresholdPct}% vs 7-day avg)\n\n`;
  if (!shifts.length) {
    md += `No shifts above the ${thresholdPct}% threshold today.\n\n`;
  } else {
    for (const sh of shifts) {
      md += `- ${sh.agentName} ${sh.phase}: ${fmtDelta(sh.deltaPct)} (today ${fmtMoney(sh.todayCost)}, 7d avg ${fmtMoney(sh.basis)})\n`;
    }
    md += `\n`;
  }

  md += `## Per-phase × per-agent breakdown\n\n`;
  md += `| Agent | Phase | Cost | Beats |\n|---|---|---|---|\n`;
  for (const [agentId, info] of Object.entries(agg)) {
    const cell = info.dates[today];
    if (!cell) continue;
    for (const [phase, p] of Object.entries(cell.phases)) {
      md += `| ${info.agentName} | ${phase} | ${fmtMoney(p.cost)} | ${p.beatCount} |\n`;
    }
  }
  md += `\n`;
  return md;
}
