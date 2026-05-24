// scripts/hindsight-scorecard.mjs
// Aggregates the hindsight-review findings ledger over a trailing window and
// renders the five-state cloning verdict (spec §7).
// Spec: docs/superpowers/specs/2026-05-24-hindsight-review-design.md

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { resolveSandboxesForAgent } from './apply-friction.mjs';

const BUCKETS = ['coverage_gap', 'timing_gap', 'discipline_gap', 'rules_silent', 'unforeseeable'];

export function aggregateLedger(records) {
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  const recurrence = {};
  let disciplineCostUsd = 0;
  let catalystUnverifiedUsd = 0;
  let actionedSurvived = 0;

  for (const rec of records) {
    for (const m of rec.movers_ranked ?? []) {
      // Only known buckets are real findings — an unknown/garbage bucket value
      // must not count toward bucket totals OR recurrence (a schema-drift bucket
      // recurring would otherwise inflate maxRecurrence and trip the verdict gate).
      if (!(m.bucket in buckets)) continue;
      buckets[m.bucket] += 1;
      const key = `${m.symbol}:${m.bucket}`;
      recurrence[key] = (recurrence[key] ?? 0) + 1;
      if (m.bucket === 'discipline_gap') {
        const cost = Number(m.foregone_pl_usd) || 0;
        disciplineCostUsd += cost;
        if (m.catalyst === 'none-found') catalystUnverifiedUsd += cost;
        if (m.routed_outcome === 'survived-holdout') actionedSurvived += 1;
      }
    }
  }
  const maxRecurrence = Object.values(recurrence).reduce((a, b) => Math.max(a, b), 0);
  // The verdict's recurrence qualifier (spec §7) screens one-off *costly* findings,
  // so it keys off discipline-gap recurrence specifically — a recurring coverage/
  // timing gap (no cost) must not qualify the cost-based provisional KEEP.
  const maxDisciplineRecurrence = Object.entries(recurrence)
    .filter(([k]) => k.endsWith(':discipline_gap'))
    .reduce((mx, [, n]) => Math.max(mx, n), 0);
  return {
    sessions: records.length,
    buckets,
    recurrence,
    maxRecurrence,
    maxDisciplineRecurrence,
    disciplineCostUsd: +disciplineCostUsd.toFixed(2),
    catalystUnverifiedUsd: +catalystUnverifiedUsd.toFixed(2),
    actionedSurvived,
  };
}

export const DEFAULT_THRESHOLDS = {
  minSessions: 15,
  minDisciplineFindings: 8,
  costPctThreshold: 0.25,
  recurrenceThreshold: 3,
  unverifiedShareThreshold: 0.5,
};

export function computeVerdict({ agg, realizedPlPeriod, thresholds = DEFAULT_THRESHOLDS, reviewEnabled = true }) {
  const t = thresholds;
  const disciplineFindings = agg.buckets?.discipline_gap ?? 0;
  const costPathAvailable = Number(realizedPlPeriod) > 0;
  const costExceeds = costPathAvailable && agg.disciplineCostUsd > t.costPctThreshold * realizedPlPeriod;
  // Recurrence qualifier is over discipline gaps only (the cost-bearing findings).
  const maxDisciplineRecurrence = agg.maxDisciplineRecurrence ?? 0;
  const hasRecurring = maxDisciplineRecurrence >= t.recurrenceThreshold;
  const unverifiedShare = agg.disciplineCostUsd > 0 ? agg.catalystUnverifiedUsd / agg.disciplineCostUsd : 0;

  const conditions = {
    sessions: agg.sessions,
    disciplineFindings,
    costPathAvailable,
    costExceeds,
    maxDisciplineRecurrence,
    hasRecurring,
    unverifiedShare: +unverifiedShare.toFixed(3),
    actionedSurvived: agg.actionedSurvived,
  };

  let verdict;
  if (agg.sessions < t.minSessions || disciplineFindings < t.minDisciplineFindings) {
    verdict = 'INSUFFICIENT_DATA';
  } else if (agg.actionedSurvived >= 1) {
    verdict = 'KEEP_STRONG';
  } else if (costExceeds && hasRecurring) {
    verdict = (reviewEnabled && unverifiedShare >= t.unverifiedShareThreshold) ? 'REVIEW' : 'KEEP_PROVISIONAL';
  } else {
    verdict = 'RETIRE';
  }
  return { verdict, conditions };
}

export function realizedPlFromActivity(logs, from, to) {
  let sum = 0;
  for (const log of logs) {
    if (log?.date >= from && log?.date <= to) sum += Number(log?.summary?.total_pnl) || 0;
  }
  return +sum.toFixed(2);
}

export function loadLedgerWindow(ledgerDir, from, to) {
  let files;
  try { files = readdirSync(ledgerDir); } catch { return []; }
  const out = [];
  for (const f of files) {
    const m = /^hindsight_(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
    if (!m) continue;
    if (m[1] < from || m[1] > to) continue;
    try {
      const rec = JSON.parse(readFileSync(join(ledgerDir, f), 'utf8'));
      // A file that parses but lacks a usable date string is malformed; drop it
      // rather than sort it to an arbitrary position.
      if (rec && typeof rec.date === 'string') out.push(rec);
    } catch { /* skip corrupt */ }
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

export function realizedPlForAgent({ projectRoot, agentConfigPath, agentId, from, to }) {
  // Soft-fail to 0 (the verdict treats <=0 as "metric dark", which is correct here).
  let dirs = [];
  try { dirs = resolveSandboxesForAgent(agentConfigPath, agentId); } catch { return 0; }
  let total = 0;
  for (const dir of dirs) {
    const logDir = join(projectRoot, 'data', 'sandboxes', dir, 'activity_logs');
    let files = [];
    try { files = readdirSync(logDir); } catch { continue; }
    const logs = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try { logs.push(JSON.parse(readFileSync(join(logDir, f), 'utf8'))); } catch { /* skip */ }
    }
    total += realizedPlFromActivity(logs, from, to);
  }
  return +total.toFixed(2);
}

{
  const __filename = fileURLToPath(import.meta.url);
  const argv1abs = process.argv[1] ? resolvePath(process.argv[1]) : '';
  if (__filename === argv1abs) {
    const args = process.argv.slice(2);
    const argFlag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
    const weeks = Number(argFlag('--weeks') ?? 4);
    if (!Number.isFinite(weeks) || weeks <= 0) {
      process.stderr.write('hindsight-scorecard: --weeks must be a positive number\n');
      process.exit(2);
    }
    const reviewEnabled = !args.includes('--no-review');
    const projectRoot = process.cwd();
    const ledgerDir = join(projectRoot, 'data', 'reports', 'hindsight');
    const to = argFlag('--to') ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      process.stderr.write('hindsight-scorecard: --to must be YYYY-MM-DD\n');
      process.exit(2);
    }
    const fromD = new Date(`${to}T00:00:00Z`);
    fromD.setUTCDate(fromD.getUTCDate() - weeks * 7);
    const from = fromD.toISOString().slice(0, 10);

    const records = loadLedgerWindow(ledgerDir, from, to);
    const agg = aggregateLedger(records);
    const realizedPlPeriod = realizedPlForAgent({
      projectRoot, agentConfigPath: join(projectRoot, 'data', 'agent-config.json'),
      agentId: 'default', from, to,
    });
    const { verdict, conditions } = computeVerdict({ agg, realizedPlPeriod, reviewEnabled });
    process.stdout.write(JSON.stringify({ window: { from, to }, realizedPlPeriod, agg, verdict, conditions }, null, 2) + '\n');
  }
}
