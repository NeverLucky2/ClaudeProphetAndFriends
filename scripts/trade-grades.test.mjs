import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOutcomeCard, gradeMechanical, hasProphetCloses,
  gatherProphetTheses, renderMarkdown, writeTradeGradesReport, readTradeGradesSummary,
  runForSandbox, AGENTS,
} from './trade-grades.mjs';
import { COIL_STRATEGY_IDS, COIL_PAPER_STRATEGY_ID, COIL_LIVE_STRATEGY_ID } from '../agent/coil-strategy-ids.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Shared-account managed_positions schema (mirrors managed-position-repair.test.mjs's
// real-schema subset) — used to seed a temp db with rows from more than one agent's
// agent_strategy, the scenario runForSandbox's strategyIds filter exists for.
function seedManagedPositionsDb(dbPath, rows) {
  const seed = new DatabaseSync(dbPath);
  seed.exec(`CREATE TABLE managed_positions (
    position_id TEXT, symbol TEXT, side TEXT, agent_strategy TEXT,
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
  for (const r of rows) {
    ins.run(r.positionId, r.symbol, 'buy', r.agentStrategy, 1, r.entryPrice, r.positionId, r.entryPrice,
      r.entryPrice * 0.9, r.entryPrice * 1.1, r.status ?? 'CLOSED', r.exitPrice, r.pnl ?? 0, r.pnlPct ?? 0,
      0, '', r.createdAt, r.closedAt);
  }
  seed.close();
}

const basePos = {
  symbol: 'AAPL', side: 'buy', agentStrategy: 'v2-options',
  entryPrice: 10, exitPrice: 12, stopLossPrice: 8, takeProfitPrice: 12,
  realizedPnl: 200, realizedPnlPct: 0.2, quantity: 1, storedStatus: 'CLOSED',
  notes: '', createdAt: '2026-05-20 14:00:00.000-05:00', closedAt: '2026-05-20 15:30:00.000-05:00',
};

test('buildOutcomeCard composes card with derived exit reason and hold time', () => {
  const card = buildOutcomeCard(basePos, 'Prophet', 180);
  assert.equal(card.agent, 'Prophet');
  assert.equal(card.symbol, 'AAPL');
  assert.equal(card.exitReason, 'target');     // exit==target band
  assert.equal(card.frictionPnl, 180);
  assert.equal(card.holdMinutes, 90);
});

test('gradeMechanical maps all five exit-reason states', () => {
  const mk = (exitReason, pnl) => gradeMechanical({ exitReason, frictionPnl: pnl });
  assert.equal(mk('target', 180).thesisPlayedOut, 'played');
  assert.equal(mk('target', 180).quadrant, 'earned_win');
  assert.equal(mk('stop', -50).thesisPlayedOut, 'broke');
  assert.equal(mk('stop', -50).quadrant, 'clean_miss');
  assert.equal(mk('stop', 30).quadrant, 'lucky');       // broke but green
  assert.equal(mk('target', -10).quadrant, 'unlucky');  // played but red
  assert.equal(mk('signal_or_time', 40).thesisPlayedOut, 'inconclusive');
  assert.equal(mk('signal_or_time', 40).quadrant, 'inconclusive_win');
  assert.equal(mk('reconciled', -5).thesisPlayedOut, 'inconclusive');
  assert.equal(mk('reconciled', -5).quadrant, 'inconclusive_loss');
  assert.match(mk('reconciled', -5).lesson, /reconciliation/i);
  assert.equal(mk('indeterminate', 0).thesisPlayedOut, 'inconclusive');
});

test('hasProphetCloses counts only the Prophet (default) cards', () => {
  const cards = [
    { agent: 'Prophet', agentId: 'default' },
    { agent: 'Turtle', agentId: 'trend' },
  ];
  assert.equal(hasProphetCloses(cards), 1);
  assert.equal(hasProphetCloses([{ agent: 'Turtle', agentId: 'trend' }]), 0);
});

test('gatherProphetTheses scopes decisive actions to the card symbol', () => {
  const actions = [
    { action: 'buy', symbol: 'AAPL', reasoning: 'earnings catalyst Friday' },
    { action: 'buy', symbol: 'TSLA', reasoning: 'unrelated' },
    { action: 'close', symbol: 'AAPL', reasoning: 'took profit' },
  ];
  const got = gatherProphetTheses({ symbol: 'AAPL' }, actions);
  assert.equal(got.length, 2);
  assert.deepEqual(got.map((a) => a.action), ['buy', 'close']);
});

test('renderMarkdown shows the quadrant per trade, silent when empty', () => {
  const report = { date: '2026-06-03', sandboxId: 's', agentName: 'Prophet', grades: [
    { agent: 'Prophet', symbol: 'AAPL', exitReason: 'target', thesisPlayedOut: 'played',
      quadrant: 'earned_win', frictionPnl: 180, lesson: 'L' },
  ] };
  const md = renderMarkdown(report);
  assert.match(md, /# Trade Grades — 2026-06-03/);
  assert.match(md, /AAPL/);
  assert.match(md, /earned_win/);
});

test("AGENTS: Coil's sandbox-resolution key is its activeAgentId ('mean-rev'), not a strategyId", () => {
  // resolveSandboxDbPaths matches on activeAgentId, not agent_strategy. Coil's
  // strategyIds ('mean-rev-rsi2' / '-live') are NOT activeAgentIds — using one as
  // agentId here silently resolves ZERO sandboxes (verified against the real
  // data/agent-config.json), which is why paper Coil never graded at all before
  // this fix, not just live.
  const coil = AGENTS.find((a) => a.agentName === 'Coil');
  assert.ok(coil, 'AGENTS has no Coil entry');
  assert.equal(coil.agentId, 'mean-rev');
  assert.deepEqual(coil.strategyIds, COIL_STRATEGY_IDS);
});

test('runForSandbox with strategyIds scopes a shared-account db to just the given agent_strategy rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-filter-'));
  const dbPath = join(dir, 'prophet_trader.db');
  try {
    const closedAt = '2026-06-03 15:50:00.0000000-04:00';
    const createdAt = '2026-06-03 09:30:00.0000000-04:00';
    seedManagedPositionsDb(dbPath, [
      { positionId: 'p1', symbol: 'AAPL', agentStrategy: 'v2-options', entryPrice: 100, exitPrice: 110, createdAt, closedAt },
      { positionId: 'p2', symbol: 'WMT', agentStrategy: COIL_PAPER_STRATEGY_ID, entryPrice: 118.47, exitPrice: 122, createdAt, closedAt },
      { positionId: 'p3', symbol: 'COST', agentStrategy: COIL_LIVE_STRATEGY_ID, entryPrice: 1004.76, exitPrice: 1019.69, status: 'STOPPED_OUT', createdAt, closedAt },
    ]);

    const fs = { mkdir: async () => {}, writeFile: async () => {} };
    const report = await runForSandbox({
      projectRoot: '/proj', sandboxId: 'sbx-test', dbPath, sandboxDir: '/proj/data/sandboxes/sbx-test',
      agentId: 'mean-rev', agentName: 'Coil', date: '2026-06-03', frictionCfg: null,
      strategyIds: COIL_STRATEGY_IDS, fs,
    });

    assert.ok(report, 'expected a report — Coil-strategy rows exist for the date');
    assert.equal(report.grades.length, 2, 'both paper and live Coil rows should be graded, and only those two');
    assert.deepEqual(report.grades.map((g) => g.symbol).sort(), ['COST', 'WMT']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runForSandbox without strategyIds keeps the prior unfiltered behavior (backward compatible)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-nofilter-'));
  const dbPath = join(dir, 'prophet_trader.db');
  try {
    const closedAt = '2026-06-03 15:50:00.0000000-04:00';
    const createdAt = '2026-06-03 09:30:00.0000000-04:00';
    seedManagedPositionsDb(dbPath, [
      { positionId: 'p1', symbol: 'AAPL', agentStrategy: 'v2-options', entryPrice: 100, exitPrice: 110, createdAt, closedAt },
      { positionId: 'p2', symbol: 'WMT', agentStrategy: COIL_PAPER_STRATEGY_ID, entryPrice: 118.47, exitPrice: 122, createdAt, closedAt },
    ]);

    const fs = { mkdir: async () => {}, writeFile: async () => {} };
    const report = await runForSandbox({
      projectRoot: '/proj', sandboxId: 'sbx-test2', dbPath, sandboxDir: '/proj/data/sandboxes/sbx-test2',
      agentId: 'default', agentName: 'Prophet', date: '2026-06-03', frictionCfg: null, fs,
    });
    assert.equal(report.grades.length, 2, 'no strategyIds passed ⇒ unfiltered, exactly as before this parameter existed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeTradeGradesReport + readTradeGradesSummary round-trip', async () => {
  const files = new Map();
  const norm = (p) => p.replaceAll('\\', '/');
  const fs = {
    mkdir: async () => {},
    writeFile: async (p, d) => files.set(norm(p), d),
    readFile: async (p) => { const k = norm(p); if (!files.has(k)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(k); },
    readdir: async () => ['sbx_a'],
  };
  const report = { date: '2026-06-03', sandboxId: 'sbx_a', agentName: 'Prophet', grades: [] };
  await writeTradeGradesReport('/proj', report, { fs });
  const summary = await readTradeGradesSummary('/proj', { date: '2026-06-03' }, { fs });
  assert.equal(summary.items.length, 1);
  assert.equal(summary.items[0].sandboxId, 'sbx_a');
});
