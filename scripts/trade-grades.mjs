// Per-trade thesis-vs-outcome grading. Deterministic core (Task 1) + assembly/IO
// (Task 2). Reuses managed-position-repair + apply-friction + trade-ledger — never
// re-derives. The LLM `trade-grader` skill enriches Prophet cards afterward.

import {
  readClosedManagedPositions, deriveExitReason, resolveSandboxDbPaths, parseManagedTimestamp,
} from './managed-position-repair.mjs';
import { toFrictionAction } from './trade-ledger.mjs';
import { applyFriction, loadFrictionConfig } from './apply-friction.mjs';
import { COIL_STRATEGY_IDS } from '../agent/coil-strategy-ids.js';
import path from 'node:path';
import nodeFs from 'node:fs/promises';

// buildOutcomeCard — pure. `frictionPnl` is the friction-adjusted dollar P&L
// (computed by the caller via toFrictionAction+applyFriction). exitReason and
// holdMinutes are derived from the stored position.
export function buildOutcomeCard(position, agent, frictionPnl) {
  const exitReason = deriveExitReason(position).derived;
  const openMs = parseManagedTimestamp(position.createdAt);
  const closeMs = parseManagedTimestamp(position.closedAt);
  const holdMinutes = (Number.isFinite(openMs) && Number.isFinite(closeMs))
    ? Math.round((closeMs - openMs) / 60000) : null;
  return {
    agent,
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice: position.exitPrice,
    holdMinutes,
    frictionPnl: Number.isFinite(frictionPnl) ? frictionPnl : position.realizedPnl,
    frictionPnlPct: position.realizedPnlPct,
    exitReason,
  };
}

// Map an exit reason to the signal-level thesis verdict (all five states).
const PLAYED_OUT_BY_REASON = {
  target: 'played',
  stop: 'broke',
  signal_or_time: 'inconclusive',
  reconciled: 'inconclusive',
  indeterminate: 'inconclusive',
};

// gradeMechanical — pure. exitReason + P&L sign → {thesisPlayedOut, quadrant, lesson}.
export function gradeMechanical(card) {
  const played = PLAYED_OUT_BY_REASON[card.exitReason] || 'inconclusive';
  const green = Number(card.frictionPnl) >= 0;
  let quadrant, lesson;
  if (played === 'played') {
    quadrant = green ? 'earned_win' : 'unlucky';
    lesson = green ? 'Thesis hit its target and paid — repeatable.'
                   : 'Target logic was right but the trade still lost — process over outcome; keep it.';
  } else if (played === 'broke') {
    quadrant = green ? 'lucky' : 'clean_miss';
    lesson = green ? 'Stopped out yet green — luck, not skill; do not reinforce.'
                   : 'Thesis broke and it cost money — the clean miss to learn from.';
  } else { // inconclusive
    quadrant = green ? 'inconclusive_win' : 'inconclusive_loss';
    lesson = card.exitReason === 'reconciled'
      ? 'Closed by reconciliation, not a strategy decision — no read on the thesis.'
      : 'Exited on time/signal before the thesis resolved — no clean read on process.';
  }
  return { thesisPlayedOut: played, quadrant, lesson };
}

// hasProphetCloses — the cost-gate. Counts cards from the Prophet (`default`) agent.
export function hasProphetCloses(cards) {
  return (cards || []).filter((c) => c.agentId === 'default').length;
}

// gatherProphetTheses — pure. decisive_actions whose symbol matches the card's symbol.
export function gatherProphetTheses(card, decisiveActions) {
  const sym = String(card.symbol || '').toUpperCase();
  return (decisiveActions || []).filter((a) => String(a.symbol || '').toUpperCase() === sym);
}

function quadrantLabel(q) {
  return ({
    earned_win: 'Earned win', lucky: 'Lucky', unlucky: 'Unlucky', clean_miss: 'Clean miss',
    partial_win: 'Partial (green)', partial_loss: 'Partial (red)',
    inconclusive_win: 'Inconclusive (green)', inconclusive_loss: 'Inconclusive (red)',
  })[q] || q;
}

// renderMarkdown — pure. One line per graded trade, grouped by agent. Empty → stub.
export function renderMarkdown(report) {
  const lines = [`# Trade Grades — ${report.date}`, ''];
  const grades = report.grades || [];
  if (!grades.length) return lines.concat(['No closed trades graded.', '']).join('\n') + '\n';
  const byAgent = new Map();
  for (const g of grades) { if (!byAgent.has(g.agent)) byAgent.set(g.agent, []); byAgent.get(g.agent).push(g); }
  for (const [agent, gs] of byAgent) {
    lines.push(`## ${agent}`, '');
    for (const g of gs) {
      const pnl = Number(g.frictionPnl) >= 0 ? `+$${Number(g.frictionPnl).toFixed(0)}` : `-$${Math.abs(Number(g.frictionPnl)).toFixed(0)}`;
      lines.push(`- **${g.symbol}** ${quadrantLabel(g.quadrant)} \`${g.quadrant}\` (${g.exitReason}, ${pnl}) — ${g.lesson}`);
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

// writeTradeGradesReport — injected-fs I/O → data/trade-grades/<sandbox>/<date>.{json,md}.
export async function writeTradeGradesReport(projectRoot, report, { fs = nodeFs } = {}) {
  const dir = path.join(projectRoot, 'data', 'trade-grades', report.sandboxId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${report.date}.json`), JSON.stringify(report, null, 2), 'utf-8');
  await fs.writeFile(path.join(dir, `${report.date}.md`), renderMarkdown(report), 'utf-8');
  return report;
}

// readTradeGradesSummary — aggregate reports across sandbox dirs for a date. Silent on missing.
export async function readTradeGradesSummary(projectRoot, { date, sandboxId } = {}, { fs = nodeFs } = {}) {
  const root = path.join(projectRoot, 'data', 'trade-grades');
  let ids;
  if (sandboxId) ids = [sandboxId];
  else { try { ids = await fs.readdir(root); } catch { return { date, items: [] }; } }
  const items = [];
  for (const sid of ids) {
    let raw;
    try { raw = await fs.readFile(path.join(root, sid, `${date}.json`), 'utf-8'); } catch { continue; }
    try { items.push(JSON.parse(raw)); } catch { continue; }
  }
  return { date, items };
}

// readDecisiveActions — read a sandbox's decisive_actions/*.json (best-effort).
async function readDecisiveActions(sandboxDir, { fs = nodeFs } = {}) {
  const dir = path.join(sandboxDir, 'decisive_actions');
  let names; try { names = await fs.readdir(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try { out.push(JSON.parse(await fs.readFile(path.join(dir, n), 'utf-8'))); } catch { /* skip */ }
  }
  return out;
}

const ET_DAY = (s) => { const ms = parseManagedTimestamp(s); return Number.isFinite(ms)
  ? new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : null; };

// runForSandbox — build cards + deterministic report for one sandbox+agent and the given
// ET date. frictionCfg is loaded once by the caller (null ⇒ fall back to stored realizedPnl).
export async function runForSandbox({ projectRoot, sandboxId, dbPath, sandboxDir, agentId, agentName, date, frictionCfg, strategyIds, fs = nodeFs }) {
  let positions; try { positions = readClosedManagedPositions(dbPath); } catch { return null; }
  let closedToday = positions.filter((p) => ET_DAY(p.closedAt) === date);
  // strategyIds scopes a shared-account db (Prophet/Turtle/Coil/etc. can all tag
  // rows via agent_strategy in the SAME managed_positions table when they share
  // an Alpaca account) down to just this agent's own rows. Pass it when one
  // logical agent trades under more than one agent_strategy value (Coil: paper
  // 'mean-rev-rsi2' + live 'mean-rev-rsi2-live') so both are included and
  // nothing else is. Omit it (undefined) for single-id agents — unchanged,
  // unfiltered behavior, exactly as before this parameter existed.
  if (strategyIds) closedToday = closedToday.filter((p) => strategyIds.includes(p.agentStrategy));
  if (!closedToday.length) return null;
  const decisive = agentId === 'default' ? await readDecisiveActions(sandboxDir, { fs }) : [];
  const grades = closedToday.map((p) => {
    const out = frictionCfg ? applyFriction(toFrictionAction(p, agentId), agentId, frictionCfg) : null;
    const fpnl = out?.action?.market_data?.friction_adjusted_pl;
    const card = buildOutcomeCard(p, agentName, fpnl);
    const det = gradeMechanical(card);
    const g = { ...card, ...det, agentId };
    if (agentId === 'default') g.candidateTheses = gatherProphetTheses(card, decisive);
    return g;
  });
  const report = { date, sandboxId, agentName, agentId, generatedAt: new Date().toISOString(), grades };
  await writeTradeGradesReport(projectRoot, report, { fs });
  const dir = path.join(projectRoot, 'data', 'trade-grades', sandboxId);
  await fs.writeFile(path.join(dir, `${date}.cards.json`), JSON.stringify(report, null, 2), 'utf-8');
  return report;
}

// AGENTS keys sandbox resolution by activeAgentId (resolveSandboxDbPaths matches on
// it), NOT by strategyId — 'mean-rev-rsi2' (the strategyId) is never an activeAgentId
// and previously resolved ZERO sandboxes here, silently dropping paper Coil grading
// entirely (not just live). Coil's activeAgentId is 'mean-rev', shared by both the
// paper and live sandboxes (docs/superpowers/specs/2026-07-13-coil-live-funding-design.md),
// so 'mean-rev' resolves both DBs; strategyIds then scopes each DB's rows down to
// Coil's own agent_strategy values via runForSandbox's filter above. Exported so
// agent/coil-strategy-registration.test.mjs can assert COIL_LIVE_STRATEGY_ID is
// present here and never silently dropped.
export const AGENTS = [
  { agentId: 'default', agentName: 'Prophet' },
  { agentId: 'trend', agentName: 'Turtle' },
  { agentId: 'mean-rev', agentName: 'Coil', strategyIds: COIL_STRATEGY_IDS },
];

// CLI: node scripts/trade-grades.mjs --date=YYYY-MM-DD  (defaults to today ET)
if (process.argv[1] && process.argv[1].endsWith('trade-grades.mjs')) {
  const dateArg = (process.argv.find((a) => a.startsWith('--date=')) || '').split('=')[1];
  const date = dateArg || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const projectRoot = process.cwd();
  let frictionCfg = null;
  try { frictionCfg = loadFrictionConfig(path.join(projectRoot, 'config', 'friction.json')); } catch { /* fall back to stored pnl */ }
  const all = [];
  for (const a of AGENTS) {
    let dbPaths; try { dbPaths = resolveSandboxDbPaths(projectRoot, a.agentId); } catch { dbPaths = []; }
    for (const dbPath of dbPaths) {
      const sandboxDir = path.dirname(dbPath);
      const sandboxId = path.basename(sandboxDir);
      const r = await runForSandbox({ projectRoot, sandboxId, dbPath, sandboxDir, agentId: a.agentId, agentName: a.agentName, date, frictionCfg, strategyIds: a.strategyIds });
      if (r) all.push(...r.grades);
    }
  }
  process.stdout.write(`PROPHET_CLOSES=${hasProphetCloses(all)}\n`);
}
