// Trade-log ↔ broker reconciliation. Pure matcher + windowing/coverage helpers
// (Tasks 1-2) and injected-dep I/O (Tasks 3-4). Compares what an agent's trade
// log recorded against the broker's actual orders for the day, classifying
// discrepancies. Only TERMINAL broker states drive a verdict — non-terminal
// orders are counted as `unresolved` and never flagged, so an in-flight order
// can never produce a confident-but-wrong banner.

import path from 'node:path';
import nodeFs from 'node:fs/promises';
import { _etDate } from './trades-store.js';

// classifyBrokerStatus buckets a broker order status into 'took' | 'reject' |
// 'unresolved'. done_for_day counts as took only if something filled.
export function classifyBrokerStatus(status, filledQty = 0) {
  const s = String(status || '').toLowerCase();
  if (s === 'filled' || s === 'partially_filled') return 'took';
  if (s === 'done_for_day') return Number(filledQty) > 0 ? 'took' : 'unresolved';
  if (s === 'rejected' || s === 'canceled' || s === 'cancelled' || s === 'expired') return 'reject';
  return 'unresolved'; // new, accepted, pending_new, pending_cancel, pending_replace, …
}

// reconcileTrades groups logged trades and broker orders by (symbol, side) and
// classifies each group. Reports group-level when 1:1 attribution is ambiguous
// (no order id on the log side). Returns { mismatches, counts }.
export function reconcileTrades(loggedTrades, brokerOrders) {
  const logged = Array.isArray(loggedTrades) ? loggedTrades : [];
  const broker = Array.isArray(brokerOrders) ? brokerOrders : [];
  const keyOf = (symbol, side) => `${symbol}|${String(side || '').toLowerCase()}`;
  const groups = new Map();
  const group = (symbol, side) => {
    const k = keyOf(symbol, side);
    if (!groups.has(k)) groups.set(k, { symbol, side: String(side || '').toLowerCase(), logged: [], broker: [] });
    return groups.get(k);
  };
  for (const t of logged) group(t.symbol, t.side).logged.push(t);
  for (const o of broker) group(o.symbol, o.side).broker.push(o);

  const mismatches = [];
  const counts = { phantomSuccess: 0, falseFailure: 0, statusDivergence: 0, unresolved: 0, matched: 0, total: logged.length };

  for (const g of groups.values()) {
    const successLogs = g.logged.filter((t) => t.status === 'success');
    const failedLogs = g.logged.filter((t) => t.status === 'failed');
    let took = 0, reject = 0;
    const tookOrders = [], rejectOrders = [];
    for (const o of g.broker) {
      const c = classifyBrokerStatus(o.status, o.filledQty);
      if (c === 'took') { took++; tookOrders.push(o); }
      else if (c === 'reject') { reject++; rejectOrders.push(o); }
      else counts.unresolved++;
    }

    if (successLogs.length > 0 && took + reject === 0) {
      counts.phantomSuccess += successLogs.length;
      mismatches.push({
        class: 'phantom_success', symbol: g.symbol, side: g.side,
        loggedTrades: successLogs, brokerOrders: g.broker,
        note: `${successLogs.length} logged success, no accepted/rejected broker order`,
      });
    } else {
      if (successLogs.length > took && reject > 0) {
        const n = successLogs.length - took;
        counts.statusDivergence += n;
        mismatches.push({
          class: 'status_divergence', symbol: g.symbol, side: g.side,
          loggedTrades: successLogs, brokerOrders: rejectOrders,
          note: `${successLogs.length} logged success, broker ${took} took + ${reject} rejected → ${n} divergence`,
        });
      }
      if (failedLogs.length > 0 && took > 0) {
        const n = Math.min(failedLogs.length, took);
        counts.falseFailure += n;
        mismatches.push({
          class: 'false_failure', symbol: g.symbol, side: g.side,
          loggedTrades: failedLogs, brokerOrders: tookOrders,
          note: `${failedLogs.length} logged failed, broker has ${took} that took → ${n} false failure`,
        });
      }
    }
  }

  const flagged = mismatches.reduce((a, m) => a + m.loggedTrades.length, 0);
  counts.matched = Math.max(0, logged.length - flagged);
  return { mismatches, counts };
}

// etDayOf returns the America/New_York calendar day (YYYY-MM-DD) for an ISO
// instant, reusing the exact conversion the trade log is bucketed with. Never a
// UTC slice — after-hours orders (up to 20:00 ET) are the next UTC calendar day.
export function etDayOf(iso) {
  return _etDate(new Date(iso));
}

// isReconcilableTrade keeps only order placements that carry a real symbol. v1
// excludes close-type rows (they store a position_id in `symbol`, not a tradable
// symbol) and the '??' placeholder the harness writes when it can't resolve one.
export function isReconcilableTrade(trade) {
  if (!trade || trade.type === 'close') return false;
  const sym = trade.symbol;
  return typeof sym === 'string' && sym.length > 0 && sym !== '??';
}

// normalizeBrokerOrder maps the Go interfaces.Order JSON (PascalCase, no json
// tags) to the lower-camel shape the matcher expects. Lowercase fallbacks guard
// against future json-tag changes.
export function normalizeBrokerOrder(o) {
  return {
    id: o.ID ?? o.id ?? '',
    symbol: o.Symbol ?? o.symbol ?? '',
    side: o.Side ?? o.side ?? '',
    status: o.Status ?? o.status ?? '',
    filledQty: o.FilledQty ?? o.filledQty ?? 0,
    submittedAt: o.SubmittedAt ?? o.submittedAt ?? null,
    strategy: o.Strategy ?? o.strategy ?? '',
  };
}

// assessCoverage detects a truncated fetch: if the returned list hit the server
// limit AND its oldest order was submitted after the ET-day start, the window
// did not reach back far enough to cover the whole day. Returns { covered }.
export function assessCoverage(rawOrders, dayStartIso, limit = 500) {
  const list = Array.isArray(rawOrders) ? rawOrders : [];
  if (list.length < limit) return { covered: true };
  const dayStartMs = new Date(dayStartIso).getTime();
  let oldestMs = Infinity;
  for (const o of list) {
    const ms = new Date(o.submittedAt ?? o.SubmittedAt ?? 0).getTime();
    if (Number.isFinite(ms) && ms < oldestMs) oldestMs = ms;
  }
  return { covered: oldestMs <= dayStartMs };
}

// Stated on every report and the banner so a clean result is not misread as
// "my positions match the broker." v1 checks opens, not closes/positions.
export const SCOPE_NOTE = 'Covers order placements (opens/adds). Does NOT verify closes/exits or live position state — a logged-success close that did not execute will not be caught here.';

function mismatchCountOf(counts) {
  return (counts?.phantomSuccess || 0) + (counts?.falseFailure || 0) + (counts?.statusDivergence || 0);
}

function reportDir(projectRoot, sandboxId) {
  return path.join(projectRoot, 'data', 'reconciliation', sandboxId);
}

// writeReconciliationReport writes <sandboxId>/<date>.json (machine) and .md
// (human). fs is injected for tests; defaults to node:fs/promises.
export async function writeReconciliationReport(projectRoot, report, { fs = nodeFs } = {}) {
  const dir = reportDir(projectRoot, report.sandboxId);
  await fs.mkdir(dir, { recursive: true });
  const mismatchCount = mismatchCountOf(report.counts);
  const json = { ...report, mismatchCount, scope: SCOPE_NOTE, generatedAt: report.generatedAt || new Date().toISOString() };
  await fs.writeFile(path.join(dir, `${report.date}.json`), JSON.stringify(json, null, 2), 'utf-8');
  await fs.writeFile(path.join(dir, `${report.date}.md`), renderReportMarkdown(json), 'utf-8');
  return json;
}

function renderReportMarkdown(r) {
  const lines = [
    `# Reconciliation — ${r.agentName || r.sandboxId} — ${r.date}`,
    '',
    `Strategy: \`${r.strategy}\` · Mismatches: **${r.mismatchCount}** · Unresolved: ${r.counts.unresolved} · Matched: ${r.counts.matched}`,
    '',
    `> ${SCOPE_NOTE}`,
    '',
  ];
  if (r.mismatches.length === 0) {
    lines.push('No mismatches.');
  } else {
    for (const m of r.mismatches) {
      lines.push(`- **${m.class}** ${m.symbol} ${m.side} — ${m.note}`);
    }
  }
  return lines.join('\n') + '\n';
}

// runReconciliationForSandbox fetches the day's broker orders, applies the
// coverage guard, filters to this sandbox's strategy + ET day, reads the day's
// logged order-placements, reconciles, and writes a report. Soft-fail: returns
// null (no report) on fetch error or incomplete coverage, so the banner stays
// silent rather than wrong. All side-effecting deps are injected for testing.
export async function runReconciliationForSandbox({
  goAxios, sandboxId, strategy, agentName, isoDate, dayStartIso,
  projectRoot, readTradesFn, fsImpl = nodeFs, limit = 500,
}) {
  let raw;
  try {
    const resp = await goAxios.get('/api/v1/orders?status=all', { timeout: 5000 });
    raw = Array.isArray(resp?.data) ? resp.data : [];
  } catch {
    return null; // bot unreachable — soft-fail to silent
  }
  const norm = raw.map(normalizeBrokerOrder);
  if (!assessCoverage(norm, dayStartIso, limit).covered) return null;

  const dayOrders = norm.filter((o) => o.strategy === strategy && o.submittedAt && etDayOf(o.submittedAt) === isoDate);

  let logged = [];
  try {
    const { trades } = await readTradesFn(projectRoot, { from: isoDate, to: isoDate, sandboxId });
    logged = (trades || []).filter(isReconcilableTrade);
  } catch {
    return null;
  }

  const result = reconcileTrades(logged, dayOrders);
  const report = { date: isoDate, sandboxId, agentName, strategy, generatedAt: new Date().toISOString(), ...result };
  await writeReconciliationReport(projectRoot, report, { fs: fsImpl });
  return report;
}

// readReconciliationSummary reads one sandbox's report (sandboxId given) or
// aggregates across all sandbox dirs for the date. Missing/unparseable reports
// contribute nothing (silent-when-clean). Returns { date, mismatchCount, items }.
export async function readReconciliationSummary(projectRoot, { date, sandboxId } = {}, { fs = nodeFs } = {}) {
  const root = path.join(projectRoot, 'data', 'reconciliation');
  let sandboxIds;
  if (sandboxId) {
    sandboxIds = [sandboxId];
  } else {
    try { sandboxIds = await fs.readdir(root); }
    catch { return { date, mismatchCount: 0, items: [] }; }
  }
  let mismatchCount = 0;
  const items = [];
  for (const sid of sandboxIds) {
    let raw;
    try { raw = await fs.readFile(path.join(root, sid, `${date}.json`), 'utf-8'); }
    catch { continue; }
    let r;
    try { r = JSON.parse(raw); } catch { continue; }
    mismatchCount += r.mismatchCount || 0;
    for (const m of (r.mismatches || [])) {
      items.push({ sandboxId: sid, agentName: r.agentName, ...m });
    }
  }
  return { date, mismatchCount, items };
}
