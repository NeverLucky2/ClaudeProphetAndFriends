// Coil/Turtle reasoning digest. Pure parsers/builders/renderer (Task 3) +
// injected-dep I/O (Task 4). Consumes ONLY the Go-computed Explain lines from
// /api/v1/turtle/status and /api/v1/meanrev/candidates — never re-derives a
// verdict, so a digest line can never contradict the agent.

import path from 'node:path';
import nodeFs from 'node:fs/promises';
import { COIL_STRATEGY_IDS } from './coil-strategy-ids.js';

// parseTurtleReasoning normalizes /api/v1/turtle/status → array of
// { ticker, line, qualified, taken, blockedBy }. Soft-empty on any missing shape.
export function parseTurtleReasoning(status) {
  const list = status && status.last_run && Array.isArray(status.last_run.reasoning)
    ? status.last_run.reasoning : [];
  return list.map((r) => ({
    ticker: String(r.ticker || ''),
    line: String(r.line || ''),
    qualified: !!r.setup_qualified,
    taken: !!r.taken,
    blockedBy: String(r.blocked_by || ''),
  }));
}

// parseCoilReasoning normalizes /api/v1/meanrev/candidates → entry-side items.
// Every candidate is an entry signal (the endpoint filters non-qualifiers).
export function parseCoilReasoning(resp) {
  const list = resp && Array.isArray(resp.candidates) ? resp.candidates : [];
  return list.map((c) => ({
    ticker: String(c.ticker || ''),
    line: String(c.explanation || ''),
    qualified: true,
    taken: true,
    blockedBy: '',
  }));
}

// buildAgentDigest groups normalized items. Turtle splits entered / qualified-
// but-declined / passed; Coil (kind 'coil') puts every candidate under entered.
export function buildAgentDigest(agentName, kind, items) {
  const all = Array.isArray(items) ? items : [];
  if (kind === 'coil') {
    return { agentName, kind, entered: all.slice(), declined: [], passed: [], all };
  }
  return {
    agentName, kind, all,
    entered: all.filter((i) => i.taken),
    declined: all.filter((i) => i.qualified && !i.taken),
    passed: all.filter((i) => !i.qualified && !i.taken),
  };
}

function section(title, items) {
  if (!items.length) return [];
  return [`### ${title} (${items.length})`, ...items.map((i) => `- ${i.line}`), ''];
}

// renderMarkdown turns a digest { date, agents:[buildAgentDigest...] } into a
// human-readable report. Empty sections are omitted (silent when nothing to say).
export function renderMarkdown(digest) {
  const lines = [`# Reasoning Digest — ${digest.date}`, ''];
  for (const a of digest.agents || []) {
    lines.push(`## ${a.agentName} (${a.kind})`, '');
    if (a.kind === 'coil') {
      lines.push(...section('Candidates', a.entered));
    } else {
      lines.push(...section('Entered', a.entered));
      lines.push(...section('Qualified but declined', a.declined));
      lines.push(...section('Passed', a.passed));
    }
    if (a.entered.length + a.declined.length + a.passed.length === 0) {
      lines.push('No evaluations.', '');
    }
  }
  return lines.join('\n') + '\n';
}

const STRATEGY_KIND = {
  'trend': 'turtle',
  ...Object.fromEntries(COIL_STRATEGY_IDS.map(id => [id, 'coil'])),
};

// runReasoningDigestForSandbox pulls the right Go endpoint for the agent's
// strategy, builds the per-agent digest, and writes
// data/reasoning-digest/<sandboxId>/<date>.{json,md}. Soft-fail: returns null
// (no report) on unknown strategy or any axios error, so the surface stays silent.
export async function runReasoningDigestForSandbox({
  goAxios, sandboxId, strategy, agentName, isoDate, projectRoot, fsImpl = nodeFs,
}) {
  const kind = STRATEGY_KIND[strategy];
  if (!kind) return null;

  let items;
  try {
    if (kind === 'turtle') {
      const resp = await goAxios.get('/api/v1/turtle/status', { timeout: 5000 });
      items = parseTurtleReasoning(resp && resp.data);
    } else {
      const resp = await goAxios.get('/api/v1/meanrev/candidates', { timeout: 5000 });
      items = parseCoilReasoning(resp && resp.data);
    }
  } catch {
    return null; // bot unreachable — soft-fail to silent
  }

  const agent = buildAgentDigest(agentName || sandboxId, kind, items);
  const report = { date: isoDate, sandboxId, agentName, strategy, generatedAt: new Date().toISOString(), agents: [agent] };

  const dir = path.join(projectRoot, 'data', 'reasoning-digest', sandboxId);
  await fsImpl.mkdir(dir, { recursive: true });
  await fsImpl.writeFile(path.join(dir, `${isoDate}.json`), JSON.stringify(report, null, 2), 'utf-8');
  await fsImpl.writeFile(path.join(dir, `${isoDate}.md`), renderMarkdown(report), 'utf-8');
  return report;
}

// readReasoningDigestSummary reads one sandbox's report or aggregates across all
// sandbox dirs for the date. Missing/unparseable reports contribute nothing.
export async function readReasoningDigestSummary(projectRoot, { date, sandboxId } = {}, { fs = nodeFs } = {}) {
  const root = path.join(projectRoot, 'data', 'reasoning-digest');
  let sandboxIds;
  if (sandboxId) {
    sandboxIds = [sandboxId];
  } else {
    try { sandboxIds = await fs.readdir(root); }
    catch { return { date, items: [] }; }
  }
  const items = [];
  for (const sid of sandboxIds) {
    let raw;
    try { raw = await fs.readFile(path.join(root, sid, `${date}.json`), 'utf-8'); }
    catch { continue; }
    try { items.push(JSON.parse(raw)); } catch { continue; }
  }
  return { date, items };
}
