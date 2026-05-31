// Foundation B Component 3 — one-time, read-only historical repair over closed
// managed_positions: quarantine-by-entry-date + exit-reason derivation w/ a
// stored-vs-derived mislabel flag. Display-only; never mutates the DB.
// Spec: docs/superpowers/specs/2026-05-31-foundation-b-component3-historical-repair-design.md

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Parse GORM's stored time.Time form, e.g. "2026-05-20 14:41:11.1594068-05:00".
// Returns epoch ms, or null when unparseable/empty/non-string.
export function parseManagedTimestamp(s) {
  if (typeof s !== 'string' || s.length === 0) return null;
  // space → 'T' (first space only; the offset has none), truncate fractional to 3 digits
  const normalized = s.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

const ET_TZ = 'America/New_York';

// The boundary at which the data-generating process became trustworthy (the
// Part-A-corrected bot going live). Bump to the real rebuild date at deploy.
export const PART_A_DEPLOY_CUTOFF = '2026-05-31';

// Offset (ms) of `timeZone` from UTC at the given instant: (wallclock read in
// the zone, interpreted as UTC) − epochMs.
function zoneOffsetMs(epochMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(epochMs)).map(x => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - epochMs;
}

// 'YYYY-MM-DD' → epoch ms at 00:00 in `timeZone` (default ET), DST-aware.
export function cutoffDateToMs(dateStr, timeZone = ET_TZ) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offset = zoneOffsetMs(utcGuess, timeZone);
  return utcGuess - offset;
}

// A closed position is graduation-eligible iff entered on/after the cutoff.
export function isGraduationEligible(createdAtMs, cutoffMs) {
  return typeof createdAtMs === 'number' && createdAtMs >= cutoffMs;
}

export const EXIT_MATCH_TOL_PCT = 0.0025; // absorbs ≤10s mark staleness + liquid-stop slippage; NOT tuned to COST

// Derive a best-effort exit reason from stored prices and flag stored-vs-derived
// contradictions. Display-only. Returns { derived, mislabeled, basis }.
//   derived ∈ {stop, target, signal_or_time, reconciled, indeterminate}
export function deriveExitReason(p, tol = EXIT_MATCH_TOL_PCT) {
  const { side, stopLossPrice, takeProfitPrice, exitPrice, storedStatus, notes } = p;

  // 1. Reconcile-close: broker-side exit, true reason unknown. Never mislabel.
  if (typeof notes === 'string' && notes.includes('reconciled_closed')) {
    return { derived: 'reconciled', mislabeled: false, basis: 'reconcile_note' };
  }

  // 2. Indeterminate: missing levels or a non-positive exit mark.
  const hasStop = typeof stopLossPrice === 'number' && stopLossPrice > 0;
  const hasTarget = typeof takeProfitPrice === 'number' && takeProfitPrice > 0;
  const hasExit = typeof exitPrice === 'number' && exitPrice > 0;
  if (!hasStop || !hasTarget || !hasExit) {
    return { derived: 'indeterminate', mislabeled: false, basis: 'missing_levels' };
  }

  const isLong = side !== 'sell';
  let stopMatch, targetMatch;
  if (isLong) {
    const stopUpper = stopLossPrice * (1 + tol);
    const targetLower = takeProfitPrice * (1 - tol);
    if (stopUpper >= targetLower) {
      return { derived: 'indeterminate', mislabeled: false, basis: 'degenerate_bands' };
    }
    stopMatch = exitPrice <= stopUpper;
    targetMatch = exitPrice >= targetLower;
  } else {
    const stopLower = stopLossPrice * (1 - tol);
    const targetUpper = takeProfitPrice * (1 + tol);
    if (targetUpper >= stopLower) {
      return { derived: 'indeterminate', mislabeled: false, basis: 'degenerate_bands' };
    }
    stopMatch = exitPrice >= stopLower;
    targetMatch = exitPrice <= targetUpper;
  }

  // 3. Price-vs-level. Stop takes precedence (bands proven disjoint above).
  let derived;
  if (stopMatch) derived = 'stop';
  else if (targetMatch) derived = 'target';
  else derived = 'signal_or_time';

  const mislabeled =
    (storedStatus === 'STOPPED_OUT' && derived !== 'stop') ||
    (storedStatus === 'CLOSED' && derived === 'stop');

  return { derived, mislabeled, basis: 'price_vs_level' };
}

// Aggregate per-strategy eligibility + the mislabel/indeterminate lists. Pure.
export function buildRepairReport(positions, cutoffMs, cutoffMeta = {}) {
  const perStrategy = {};
  const mislabeled = [];
  const indeterminate = [];

  for (const p of positions) {
    const strat = p.agentStrategy || '(untagged)';
    perStrategy[strat] ??= { eligible: 0, quarantined: 0 };
    if (isGraduationEligible(parseManagedTimestamp(p.createdAt), cutoffMs)) {
      perStrategy[strat].eligible += 1;
    } else {
      perStrategy[strat].quarantined += 1;
    }

    const { derived, mislabeled: isMis, basis } = deriveExitReason(p);
    if (isMis) {
      mislabeled.push({
        symbol: p.symbol, strategy: strat, storedStatus: p.storedStatus, derived,
        entry: p.entryPrice, stop: p.stopLossPrice, target: p.takeProfitPrice,
        exit: p.exitPrice, notes: p.notes,
      });
    }
    if (derived === 'indeterminate') {
      indeterminate.push({ symbol: p.symbol, strategy: strat, reason: basis });
    }
  }

  return {
    cutoff: { date: cutoffMeta.date ?? null, source: cutoffMeta.source ?? 'DEFAULT' },
    perStrategy, mislabeled, indeterminate,
  };
}

// Read closed managed positions from one sandbox DB, read-only. The wide
// interface is deliberate: Component 2 reuses this exact shape so it never
// re-touches this landed module. This is the closed-trade (realized) leg only —
// the daily mark-to-market series comes from Component 1's DBSegmentPnL rows.
export function readClosedManagedPositions(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      `SELECT position_id, symbol, side, agent_strategy, entry_price,
              stop_loss_price, take_profit_price, current_price,
              unrealized_pl, unrealized_plpc, remaining_qty, quantity,
              allocation_dollars, entry_order_id, status, notes,
              created_at, closed_at
       FROM managed_positions
       WHERE status IN ('CLOSED', 'STOPPED_OUT')`
    ).all();
    return rows.map(r => ({
      positionId: r.position_id,
      symbol: r.symbol,
      side: r.side,
      agentStrategy: r.agent_strategy,
      entryPrice: r.entry_price,
      stopLossPrice: r.stop_loss_price,
      takeProfitPrice: r.take_profit_price,
      exitPrice: r.current_price,        // last monitor mark (not the fill); see spec §2.3
      realizedPnlPct: r.unrealized_plpc, // per-share %, consistent with exitPrice
      realizedPnl: r.unrealized_pl,      // dollars; partial-blended — provided, not classified on
      quantity: r.quantity,
      remainingQty: r.remaining_qty,
      allocationDollars: r.allocation_dollars,
      entryOrderId: r.entry_order_id,
      storedStatus: r.status,
      notes: r.notes,
      createdAt: r.created_at,
      closedAt: r.closed_at,
    }));
  } finally {
    db.close();
  }
}

// Render the one-time operator report as markdown. Pure.
export function renderMarkdownReport(report) {
  const lines = [];
  lines.push('# Managed-position repair report (display-only)');
  lines.push('');
  lines.push(`**Cutoff:** ${report.cutoff.date} (${report.cutoff.source})`);
  lines.push('');
  lines.push('## Quarantine by strategy');
  lines.push('');
  lines.push('| strategy | eligible | quarantined |');
  lines.push('| --- | ---: | ---: |');
  for (const [strat, c] of Object.entries(report.perStrategy).sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`| ${strat} | ${c.eligible} | ${c.quarantined} |`);
  }
  lines.push('');
  lines.push(`## Mislabeled exits (stored vs derived) — ${report.mislabeled.length}`);
  lines.push('');
  if (report.mislabeled.length === 0) {
    lines.push('_none_');
  } else {
    lines.push('| symbol | strategy | stored | derived | entry | stop | target | exit |');
    lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | ---: |');
    for (const m of report.mislabeled) {
      lines.push(`| ${m.symbol} | ${m.strategy} | ${m.storedStatus} | ${m.derived} | ${m.entry} | ${m.stop} | ${m.target} | ${m.exit} |`);
    }
  }
  lines.push('');
  lines.push(`## Indeterminate (excluded from mislabel flagging) — ${report.indeterminate.length}`);
  lines.push('');
  if (report.indeterminate.length === 0) {
    lines.push('_none_');
  } else {
    lines.push('| symbol | strategy | reason |');
    lines.push('| --- | --- | --- |');
    for (const it of report.indeterminate) {
      lines.push(`| ${it.symbol} | ${it.strategy} | ${it.reason} |`);
    }
  }
  return lines.join('\n');
}

// Resolve per-sandbox DB paths from data/agent-config.json. Optionally scope to
// one agent by activeAgentId. Skips sandboxes whose DB file is absent.
export function resolveSandboxDbPaths(projectRoot, agentId) {
  const cfgPath = join(projectRoot, 'data', 'agent-config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const sandboxes = cfg.sandboxes ?? {};
  const out = [];
  for (const sb of Object.values(sandboxes)) {
    if (!sb || typeof sb.accountId !== 'string') continue;
    if (agentId && sb.agent?.activeAgentId !== agentId) continue;
    const dbPath = join(projectRoot, 'data', 'sandboxes', sb.accountId, 'prophet_trader.db');
    if (existsSync(dbPath)) out.push(dbPath);
  }
  return out;
}

// CLI entry — only when invoked directly, never on import (matches apply-friction.mjs).
{
  const argv1abs = process.argv[1] ? resolve(process.argv[1]) : '';
  if (fileURLToPath(import.meta.url) === argv1abs) {
    const args = process.argv.slice(2);
    const agentIdx = args.indexOf('--agent');
    const cutoffIdx = args.indexOf('--cutoff');
    const agentId = agentIdx !== -1 ? args[agentIdx + 1] : undefined;
    const cutoffDate = cutoffIdx !== -1 ? args[cutoffIdx + 1] : PART_A_DEPLOY_CUTOFF;
    const source = cutoffIdx !== -1 ? 'OVERRIDE' : 'DEFAULT';
    if (source === 'OVERRIDE') {
      process.stderr.write(
        `WARNING: quarantine cutoff overridden to ${cutoffDate} (default ${PART_A_DEPLOY_CUTOFF}). ` +
        `Boundary moved — confirm this is intentional before trusting the eligible/quarantined split.\n`,
      );
    }
    const cutoffMs = cutoffDateToMs(cutoffDate);
    const projectRoot = process.cwd();
    const positions = [];
    for (const dbPath of resolveSandboxDbPaths(projectRoot, agentId)) {
      try {
        positions.push(...readClosedManagedPositions(dbPath));
      } catch (err) {
        process.stderr.write(`skip ${dbPath}: ${err.message}\n`);
      }
    }
    const report = buildRepairReport(positions, cutoffMs, { date: cutoffDate, source });
    process.stdout.write(renderMarkdownReport(report) + '\n');
  }
}
