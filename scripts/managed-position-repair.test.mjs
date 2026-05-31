import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManagedTimestamp } from './managed-position-repair.mjs';

test('parseManagedTimestamp parses Go-format datetime with 7-digit fractional + offset', () => {
  const ms = parseManagedTimestamp('2026-05-20 14:41:11.1594068-05:00');
  assert.equal(ms, Date.parse('2026-05-20T14:41:11.159-05:00'));
});

test('parseManagedTimestamp orders correctly across dates', () => {
  const a = parseManagedTimestamp('2026-05-20 14:41:11.1594068-05:00');
  const b = parseManagedTimestamp('2026-05-29 08:37:56.1750541-05:00');
  assert.ok(a < b);
});

test('parseManagedTimestamp handles a value with no fractional seconds', () => {
  const ms = parseManagedTimestamp('2026-05-20 14:41:11-05:00');
  assert.equal(ms, Date.parse('2026-05-20T14:41:11-05:00'));
});

test('parseManagedTimestamp returns null on empty/garbage/non-string', () => {
  assert.equal(parseManagedTimestamp(''), null);
  assert.equal(parseManagedTimestamp(null), null);
  assert.equal(parseManagedTimestamp('not a date'), null);
  assert.equal(parseManagedTimestamp(42), null);
});

// ── Task 2: cutoff + eligibility ──────────────────────────────────────────
import {
  cutoffDateToMs, isGraduationEligible, PART_A_DEPLOY_CUTOFF,
} from './managed-position-repair.mjs';

test('PART_A_DEPLOY_CUTOFF default is 2026-05-31', () => {
  assert.equal(PART_A_DEPLOY_CUTOFF, '2026-05-31');
});

test('cutoffDateToMs returns ET midnight (EDT in summer)', () => {
  assert.equal(cutoffDateToMs('2026-05-31'), Date.parse('2026-05-31T00:00:00-04:00'));
});

test('cutoffDateToMs is DST-aware (EST in winter)', () => {
  assert.equal(cutoffDateToMs('2026-01-15'), Date.parse('2026-01-15T00:00:00-05:00'));
});

test('isGraduationEligible: pre-cutoff entry is quarantined', () => {
  const entry = parseManagedTimestamp('2026-05-20 14:41:11.1594068-05:00');
  assert.equal(isGraduationEligible(entry, cutoffDateToMs('2026-05-31')), false);
});

test('isGraduationEligible: entry exactly at cutoff is eligible (inclusive)', () => {
  const cutoff = cutoffDateToMs('2026-05-31');
  assert.equal(isGraduationEligible(cutoff, cutoff), true);
});

test('isGraduationEligible: post-cutoff entry is eligible', () => {
  const entry = parseManagedTimestamp('2026-06-02 10:00:00.0000000-04:00');
  assert.equal(isGraduationEligible(entry, cutoffDateToMs('2026-05-31')), true);
});

test('isGraduationEligible: null createdAt is not eligible', () => {
  assert.equal(isGraduationEligible(null, cutoffDateToMs('2026-05-31')), false);
});

// ── Task 3: deriveExitReason ──────────────────────────────────────────────
import { deriveExitReason, EXIT_MATCH_TOL_PCT } from './managed-position-repair.mjs';

const longBase = { side: 'buy', entryPrice: 100, stopLossPrice: 95, takeProfitPrice: 110 };

test('default tolerance band is 0.25%', () => {
  assert.equal(EXIT_MATCH_TOL_PCT, 0.0025);
});

test('long stop-out: exit at/below stop, stored STOPPED_OUT → stop, not mislabeled', () => {
  const r = deriveExitReason({ ...longBase, exitPrice: 94.9, storedStatus: 'STOPPED_OUT' });
  assert.equal(r.derived, 'stop');
  assert.equal(r.mislabeled, false);
});

test('long target: exit near target, stored CLOSED → target, not mislabeled', () => {
  const r = deriveExitReason({ ...longBase, exitPrice: 109.8, storedStatus: 'CLOSED' });
  assert.equal(r.derived, 'target');
  assert.equal(r.mislabeled, false);
});

test('long signal: exit near neither level, stored CLOSED → signal_or_time, not mislabeled', () => {
  const r = deriveExitReason({ ...longBase, exitPrice: 103, storedStatus: 'CLOSED' });
  assert.equal(r.derived, 'signal_or_time');
  assert.equal(r.mislabeled, false);
});

test('COST repair: stored STOPPED_OUT but exit +1.5% above stop → signal_or_time, MISLABELED', () => {
  const r = deriveExitReason({
    side: 'buy', entryPrice: 1004.76, stopLossPrice: 970.06, takeProfitPrice: 1147.38,
    exitPrice: 1019.69, storedStatus: 'STOPPED_OUT',
  });
  assert.equal(r.derived, 'signal_or_time');
  assert.equal(r.mislabeled, true);
});

test('inverse mislabel: stored STOPPED_OUT but priced at target → target, MISLABELED', () => {
  const r = deriveExitReason({ ...longBase, exitPrice: 109.8, storedStatus: 'STOPPED_OUT' });
  assert.equal(r.derived, 'target');
  assert.equal(r.mislabeled, true);
});

test('mislabel: stored CLOSED but priced at stop → stop, MISLABELED', () => {
  const r = deriveExitReason({ ...longBase, exitPrice: 94.9, storedStatus: 'CLOSED' });
  assert.equal(r.derived, 'stop');
  assert.equal(r.mislabeled, true);
});

test('short inversion: side sell, exit at/above stop → stop, not mislabeled', () => {
  const r = deriveExitReason({
    side: 'sell', entryPrice: 100, stopLossPrice: 105, takeProfitPrice: 90,
    exitPrice: 105.1, storedStatus: 'STOPPED_OUT',
  });
  assert.equal(r.derived, 'stop');
  assert.equal(r.mislabeled, false);
});

test('missing stop → indeterminate, not mislabeled', () => {
  const r = deriveExitReason({ side: 'buy', entryPrice: 100, stopLossPrice: 0, takeProfitPrice: 110, exitPrice: 94.9, storedStatus: 'STOPPED_OUT' });
  assert.equal(r.derived, 'indeterminate');
  assert.equal(r.mislabeled, false);
});

test('missing target → indeterminate, not mislabeled', () => {
  const r = deriveExitReason({ side: 'buy', entryPrice: 100, stopLossPrice: 95, takeProfitPrice: 0, exitPrice: 103, storedStatus: 'CLOSED' });
  assert.equal(r.derived, 'indeterminate');
  assert.equal(r.mislabeled, false);
});

test('degenerate overlapping bands → indeterminate', () => {
  const r = deriveExitReason({ side: 'buy', entryPrice: 100, stopLossPrice: 100, takeProfitPrice: 100.1, exitPrice: 100, storedStatus: 'CLOSED' });
  assert.equal(r.derived, 'indeterminate');
});

test('reconciled note → reconciled, never mislabeled even if priced like a stop', () => {
  const r = deriveExitReason({ ...longBase, exitPrice: 94.9, storedStatus: 'STOPPED_OUT', notes: 'x reconciled_closed:broker_flat' });
  assert.equal(r.derived, 'reconciled');
  assert.equal(r.mislabeled, false);
});

test('band edge: exit exactly at stop upper edge counts as stop', () => {
  const r = deriveExitReason({ ...longBase, exitPrice: 95 * 1.0025, storedStatus: 'STOPPED_OUT' });
  assert.equal(r.derived, 'stop');
});

// ── Task 4: buildRepairReport ─────────────────────────────────────────────
import { buildRepairReport } from './managed-position-repair.mjs';

test('buildRepairReport buckets eligibility, mislabels, and indeterminates', () => {
  const cutoffMs = cutoffDateToMs('2026-05-31');
  const positions = [
    // pre-cutoff, mislabeled (COST-like): quarantined + mislabeled
    { symbol: 'COST', agentStrategy: 'mean-rev-rsi2', side: 'buy', entryPrice: 1004.76,
      stopLossPrice: 970.06, takeProfitPrice: 1147.38, exitPrice: 1019.69,
      storedStatus: 'STOPPED_OUT', createdAt: '2026-05-26 14:46:00.1464526-05:00' },
    // post-cutoff, clean stop: eligible, not mislabeled
    { symbol: 'AAPL', agentStrategy: 'mean-rev-rsi2', side: 'buy', entryPrice: 100,
      stopLossPrice: 95, takeProfitPrice: 110, exitPrice: 94.9,
      storedStatus: 'STOPPED_OUT', createdAt: '2026-06-02 10:00:00.0000000-04:00' },
    // pre-cutoff, missing target: quarantined + indeterminate
    { symbol: 'XYZ', agentStrategy: 'trend', side: 'buy', entryPrice: 50,
      stopLossPrice: 45, takeProfitPrice: 0, exitPrice: 52,
      storedStatus: 'CLOSED', createdAt: '2026-05-01 09:00:00.0000000-04:00' },
  ];
  const report = buildRepairReport(positions, cutoffMs, { date: '2026-05-31', source: 'DEFAULT' });

  assert.equal(report.cutoff.date, '2026-05-31');
  assert.equal(report.cutoff.source, 'DEFAULT');
  assert.deepEqual(report.perStrategy['mean-rev-rsi2'], { eligible: 1, quarantined: 1 });
  assert.deepEqual(report.perStrategy['trend'], { eligible: 0, quarantined: 1 });
  assert.equal(report.mislabeled.length, 1);
  assert.equal(report.mislabeled[0].symbol, 'COST');
  assert.equal(report.mislabeled[0].derived, 'signal_or_time');
  assert.equal(report.indeterminate.length, 1);
  assert.equal(report.indeterminate[0].symbol, 'XYZ');
  assert.equal(report.indeterminate[0].reason, 'missing_levels');
});

test('buildRepairReport defaults cutoff meta when omitted', () => {
  const report = buildRepairReport([], cutoffDateToMs('2026-05-31'));
  assert.equal(report.cutoff.source, 'DEFAULT');
  assert.deepEqual(report.perStrategy, {});
});

// ── Task 5: readClosedManagedPositions (integration, real schema) ──────────
import { readClosedManagedPositions } from './managed-position-repair.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('readClosedManagedPositions maps real schema + filters to closed-trade rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mpr-'));
  const dbPath = join(dir, 'prophet_trader.db');
  try {
    const seed = new DatabaseSync(dbPath);
    // Minimal real-schema subset (snake_case, datetime stored as Go-format text).
    seed.exec(`CREATE TABLE managed_positions (
      position_id TEXT, symbol TEXT, side TEXT, strategy TEXT, agent_strategy TEXT,
      quantity REAL, entry_price REAL, entry_order_id TEXT, allocation_dollars REAL,
      stop_loss_price REAL, take_profit_price REAL,
      status TEXT, current_price REAL, unrealized_pl REAL, unrealized_plpc REAL,
      remaining_qty REAL, notes TEXT, created_at datetime, closed_at datetime
    )`);
    const ins = seed.prepare(`INSERT INTO managed_positions
      (position_id,symbol,side,agent_strategy,quantity,entry_price,entry_order_id,allocation_dollars,
       stop_loss_price,take_profit_price,status,current_price,unrealized_pl,unrealized_plpc,
       remaining_qty,notes,created_at,closed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    ins.run('p1','COST','buy','mean-rev-rsi2',1,1004.76,'o1',1004.76,970.06,1147.38,
      'STOPPED_OUT',1019.69,59.72,1.4859,1,'Entry: rsi2',
      '2026-05-26 14:46:00.1464526-05:00','2026-05-29 08:37:56.1750541-05:00');
    ins.run('p2','WMT','buy','mean-rev-rsi2',1,118.47,'o2',118.47,110.18,130.32,
      'ACTIVE',118.47,0,0,1,'Entry: rsi2','2026-05-26 14:45:49.508606-05:00',null);
    ins.run('p3','FOO','buy','mean-rev-rsi2',1,10,'o3',10,9,12,
      'FAILED',0,0,0,1,'','2026-05-26 14:45:49.508606-05:00',null);
    seed.close();

    const rows = readClosedManagedPositions(dbPath);
    assert.equal(rows.length, 1); // only the CLOSED/STOPPED_OUT row; ACTIVE + FAILED excluded
    const r = rows[0];
    assert.equal(r.symbol, 'COST');
    assert.equal(r.storedStatus, 'STOPPED_OUT');
    assert.equal(r.exitPrice, 1019.69);          // current_price → exitPrice
    assert.equal(r.realizedPnlPct, 1.4859);       // unrealized_plpc → realizedPnlPct
    assert.equal(r.stopLossPrice, 970.06);
    assert.equal(r.takeProfitPrice, 1147.38);
    assert.equal(r.agentStrategy, 'mean-rev-rsi2');
    assert.equal(r.createdAt, '2026-05-26 14:46:00.1464526-05:00');
    assert.equal(r.entryOrderId, 'o1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Task 6: renderMarkdownReport ──────────────────────────────────────────
import { renderMarkdownReport } from './managed-position-repair.mjs';

test('renderMarkdownReport stamps the cutoff source and lists a mislabel', () => {
  const report = {
    cutoff: { date: '2026-05-31', source: 'DEFAULT' },
    perStrategy: { 'mean-rev-rsi2': { eligible: 0, quarantined: 2 } },
    mislabeled: [{ symbol: 'COST', strategy: 'mean-rev-rsi2', storedStatus: 'STOPPED_OUT',
      derived: 'signal_or_time', entry: 1004.76, stop: 970.06, target: 1147.38, exit: 1019.69 }],
    indeterminate: [],
  };
  const md = renderMarkdownReport(report);
  assert.match(md, /Cutoff:\*\* 2026-05-31 \(DEFAULT\)/);
  assert.match(md, /mean-rev-rsi2 \| 0 \| 2/);
  assert.match(md, /COST .* STOPPED_OUT .* signal_or_time/);
  assert.match(md, /Indeterminate.*0/);
});

test('renderMarkdownReport shows OVERRIDE and "none" when empty', () => {
  const md = renderMarkdownReport({
    cutoff: { date: '2026-04-23', source: 'OVERRIDE' },
    perStrategy: {}, mislabeled: [], indeterminate: [],
  });
  assert.match(md, /\(OVERRIDE\)/);
  assert.match(md, /_none_/);
});

// ── Task 7: resolveSandboxDbPaths ─────────────────────────────────────────
import { resolveSandboxDbPaths } from './managed-position-repair.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

test('resolveSandboxDbPaths returns existing DBs, optionally filtered by agent', () => {
  const root = mkdtempSync(join(tmpdir(), 'mpr-root-'));
  try {
    mkdirSync(join(root, 'data', 'sandboxes', 'acctA'), { recursive: true });
    mkdirSync(join(root, 'data', 'sandboxes', 'acctB'), { recursive: true });
    // acctA has a db file, acctB does not (should be skipped)
    writeFileSync(join(root, 'data', 'sandboxes', 'acctA', 'prophet_trader.db'), '');
    writeFileSync(join(root, 'data', 'agent-config.json'), JSON.stringify({
      sandboxes: {
        s1: { accountId: 'acctA', agent: { activeAgentId: 'default' } },
        s2: { accountId: 'acctB', agent: { activeAgentId: 'turtle-trend' } },
      },
    }));

    const all = resolveSandboxDbPaths(root);
    assert.deepEqual(all, [join(root, 'data', 'sandboxes', 'acctA', 'prophet_trader.db')]);

    const filtered = resolveSandboxDbPaths(root, 'turtle-trend');
    assert.deepEqual(filtered, []); // acctB matches agent but has no db file
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
