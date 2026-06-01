import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFrictionAction } from './trade-ledger.mjs';

export const TEST_CFG = {
  version: 'test',
  stocks: { per_share_slippage_usd: 0.01, regulatory_fee_per_share: 0.0001, commission_per_share: 0, stop_gap_through_pct: 0.003 },
  single_leg_options: { assumed_spread_pct_of_mid: 0.05, spread_crossing_pct_open: 0.5, spread_crossing_pct_close: 0.5, spread_crossing_pct_close_when_losing: 0.75, commission_per_contract: 0.65, regulatory_fee_per_contract: 0.01 },
  iron_condor: { assumed_spread_pct_of_credit: 0.1, spread_crossing_pct_close: 0.5, spread_crossing_pct_close_when_losing: 0.75, commission_per_contract: 0.65, regulatory_fee_per_contract: 0.01, leg_count: 4 },
};

const longStop = { symbol: 'AAPL', side: 'buy', entryPrice: 100, stopLossPrice: 95, takeProfitPrice: 110, exitPrice: 94.9, realizedPnl: -510, realizedPnlPct: -5.1, quantity: 100, storedStatus: 'STOPPED_OUT', notes: 'x' };
const longSignal = { symbol: 'MSFT', side: 'buy', entryPrice: 100, stopLossPrice: 95, takeProfitPrice: 110, exitPrice: 103, realizedPnl: 300, realizedPnlPct: 3, quantity: 100, storedStatus: 'CLOSED', notes: 'took profit early' };

test('toFrictionAction maps fields into apply-friction action shape', () => {
  const a = toFrictionAction(longSignal, 'mean-rev-rsi2');
  assert.equal(a.symbol, 'MSFT');
  assert.deepEqual(a.market_data, { entry_price: 100, exit_price: 103, size: 100, unrealized_pl: 300, unrealized_pct: 3 });
});

test('toFrictionAction sets reasoning="stopped out" iff derived exit is a stop', () => {
  assert.equal(toFrictionAction(longStop, 'mean-rev-rsi2').reasoning, 'stopped out');
  assert.equal(toFrictionAction(longSignal, 'mean-rev-rsi2').reasoning, 'took profit early');
});

// ── Task 2: buildStressConfig ─────────────────────────────────────────────
import { buildStressConfig } from './trade-ledger.mjs';

test('buildStressConfig doubles uncertain frictions, leaves deterministic fees', () => {
  const stress = buildStressConfig(TEST_CFG);
  // uncertain → doubled
  assert.equal(stress.stocks.per_share_slippage_usd, 0.02);
  assert.equal(stress.stocks.stop_gap_through_pct, 0.006);
  assert.equal(stress.single_leg_options.assumed_spread_pct_of_mid, 0.10);
  // deterministic fees → unchanged
  assert.equal(stress.stocks.regulatory_fee_per_share, 0.0001);
  assert.equal(stress.single_leg_options.commission_per_contract, 0.65);
  // baseline not mutated
  assert.equal(TEST_CFG.stocks.per_share_slippage_usd, 0.01);
  assert.match(stress.version, /stress2x/);
});

// ── Task 3: readOpenManagedPositions ──────────────────────────────────────
import { readOpenManagedPositions } from './trade-ledger.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('readOpenManagedPositions returns ACTIVE+PARTIAL only, mapped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-'));
  const dbPath = join(dir, 'prophet_trader.db');
  try {
    const seed = new DatabaseSync(dbPath);
    seed.exec(`CREATE TABLE managed_positions (
      position_id TEXT, symbol TEXT, side TEXT, agent_strategy TEXT, quantity REAL,
      entry_price REAL, stop_loss_price REAL, take_profit_price REAL, status TEXT,
      current_price REAL, unrealized_pl REAL, unrealized_plpc REAL, remaining_qty REAL,
      notes TEXT, created_at datetime, closed_at datetime )`);
    const ins = seed.prepare(`INSERT INTO managed_positions
      (position_id,symbol,side,agent_strategy,quantity,entry_price,status,current_price,unrealized_pl,unrealized_plpc,remaining_qty,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    ins.run('o1','WMT','buy','mean-rev-rsi2',10,118.47,'ACTIVE',120,15.3,1.29,10,'2026-06-02 10:00:00.0-04:00');
    ins.run('o2','DE','buy','mean-rev-rsi2',5,529,'PARTIAL',540,55,2.0,3,'2026-06-02 10:00:00.0-04:00');
    ins.run('o3','COST','buy','mean-rev-rsi2',1,1004,'CLOSED',1019,59,1.4,1,'2026-05-26 14:46:00.0-05:00');
    seed.close();

    const rows = readOpenManagedPositions(dbPath);
    assert.equal(rows.length, 2);
    const wmt = rows.find(r => r.symbol === 'WMT');
    assert.equal(wmt.unrealizedPl, 15.3);
    assert.equal(wmt.quantity, 10);
    assert.equal(wmt.agentStrategy, 'mean-rev-rsi2');
    assert.equal(wmt.createdAt, '2026-06-02 10:00:00.0-04:00');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Task 4: friction-adjusted P&L + metrics ───────────────────────────────
import { frictionAdjustedPnl, metricsFromPnls } from './trade-ledger.mjs';

test('frictionAdjustedPnl subtracts the apply-friction haircut from realized P&L', () => {
  const stopPos = { symbol: 'AAPL', side: 'buy', entryPrice: 100, stopLossPrice: 95, takeProfitPrice: 110, exitPrice: 94.9, realizedPnl: -510, realizedPnlPct: -5.1, quantity: 100, storedStatus: 'STOPPED_OUT' };
  const adj = frictionAdjustedPnl(stopPos, 'mean-rev-rsi2', TEST_CFG);
  assert.ok(adj < -510, `expected haircut to worsen P&L, got ${adj}`);
});

test('metricsFromPnls computes win rate, profit factor, expectancy', () => {
  const m = metricsFromPnls([100, 200, -50, -50]);
  assert.equal(m.count, 4);
  assert.equal(m.winners, 2);
  assert.equal(m.losers, 2);
  assert.equal(m.winRate, 0.5);
  assert.equal(m.profitFactor, 3); // 300 / 100
  assert.equal(m.expectancy, 50);  // 200/4
});

test('metricsFromPnls profit factor is null (not Infinity) with zero losses', () => {
  const m = metricsFromPnls([100, 50, 10]);
  assert.equal(m.profitFactor, null);
  assert.equal(m.losers, 0);
});

test('metricsFromPnls empty array is well-defined', () => {
  const m = metricsFromPnls([]);
  assert.equal(m.count, 0);
  assert.equal(m.winRate, 0);
  assert.equal(m.profitFactor, null);
  assert.equal(m.expectancy, 0);
});

// ── Task 5: bootstrapExpectancyCI ─────────────────────────────────────────
import { bootstrapExpectancyCI } from './trade-ledger.mjs';

test('bootstrapExpectancyCI is deterministic for a fixed seed', () => {
  const a = bootstrapExpectancyCI([10, -5, 20, -3, 8], { seed: 42 });
  const b = bootstrapExpectancyCI([10, -5, 20, -3, 8], { seed: 42 });
  assert.deepEqual(a, b);
  assert.ok(a.lo < a.mean && a.mean < a.hi);
  assert.equal(a.n, 5);
});

test('bootstrapExpectancyCI widens with smaller n', () => {
  const small = bootstrapExpectancyCI([5, -5, 6, -4], { seed: 1 });
  const big = bootstrapExpectancyCI(Array.from({ length: 80 }, (_, i) => (i % 2 ? 6 : -4)), { seed: 1 });
  assert.ok((small.hi - small.lo) > (big.hi - big.lo));
});

test('bootstrapExpectancyCI empty array → nulls', () => {
  assert.deepEqual(bootstrapExpectancyCI([]), { mean: null, lo: null, hi: null, n: 0 });
});

// ── Task 6: markedEquityExpectancy ────────────────────────────────────────
import { markedEquityExpectancy } from './trade-ledger.mjs';

test('markedEquityExpectancy blends eligible closed friction-adj realized + eligible open marks (entry-friction subtracted)', () => {
  // entry-side stock friction = (0.01 + 0.0001 + 0) * 10 = 0.101 → open contributes 15.3 - 0.101
  const r = markedEquityExpectancy([100, -20], [{ symbol: 'WMT', quantity: 10, unrealizedPl: 15.3 }], TEST_CFG);
  const expectedTotal = 100 + (-20) + (15.3 - 0.101);
  assert.equal(r.count, 3);
  assert.ok(Math.abs(r.value - expectedTotal) < 1e-9);
  assert.ok(Math.abs(r.perTrade - expectedTotal / 3) < 1e-9);
});

test('markedEquityExpectancy with no positions → null perTrade', () => {
  const r = markedEquityExpectancy([], [], TEST_CFG);
  assert.equal(r.count, 0);
  assert.equal(r.perTrade, null);
});

// ── Task 7: buildAgentLedger ──────────────────────────────────────────────
import { buildAgentLedger } from './trade-ledger.mjs';
import { cutoffDateToMs } from './managed-position-repair.mjs';

const CUTOFF = cutoffDateToMs('2026-05-31');
function closedPos(symbol, createdAt, realizedPnl, realizedPnlPct, exitPrice, storedStatus) {
  return { symbol, side: 'buy', entryPrice: 100, stopLossPrice: 95, takeProfitPrice: 110,
    exitPrice, realizedPnl, realizedPnlPct, quantity: 100, storedStatus, notes: '', createdAt };
}

test('buildAgentLedger partitions eligible vs quarantined and fills both blocks', () => {
  const closed = [
    closedPos('AAA', '2026-05-20 14:00:00.0-05:00', 300, 3, 103, 'CLOSED'),   // quarantined
    closedPos('BBB', '2026-06-02 10:00:00.0-04:00', 300, 3, 103, 'CLOSED'),  // eligible win
    closedPos('CCC', '2026-06-03 10:00:00.0-04:00', -210, -2.1, 97.9, 'CLOSED'), // eligible loss
  ];
  const open = [{ symbol: 'OPN', quantity: 10, unrealizedPl: 50, agentStrategy: 'mean-rev-rsi2', createdAt: '2026-06-04 10:00:00.0-04:00' }];
  const led = buildAgentLedger(closed, open, CUTOFF, 'mean-rev-rsi2', TEST_CFG, buildStressConfig(TEST_CFG));

  assert.equal(led.eligible.count, 2);
  assert.equal(led.quarantined.count, 1);
  assert.equal(led.allClosed.count, 3);
  assert.ok(led.eligibleExpectancy2x <= led.eligible.expectancy);
  assert.equal(led.edgeCI.n, 2);
  assert.ok('lo' in led.edgeCI && 'hi' in led.edgeCI);
  assert.equal(led.markedEquity.count, 3);
});

test("buildAgentLedger eligible block empty when all trades pre-cutoff (today's reality)", () => {
  const closed = [closedPos('AAA', '2026-05-20 14:00:00.0-05:00', 300, 3, 103, 'CLOSED')];
  const led = buildAgentLedger(closed, [], CUTOFF, 'mean-rev-rsi2', TEST_CFG, buildStressConfig(TEST_CFG));
  assert.equal(led.eligible.count, 0);
  assert.equal(led.quarantined.count, 1);
  assert.equal(led.edgeCI.n, 0);
});

// ── Task 8: report + renderer ─────────────────────────────────────────────
import { renderLedgerMarkdown } from './trade-ledger.mjs';

test('renderLedgerMarkdown shows per-agent eligible/all-closed + edge CI', () => {
  const report = { agents: { 'mean-rev-rsi2': {
    agentStrategy: 'mean-rev-rsi2',
    eligible: { count: 2, winRate: 0.5, profitFactor: 3, expectancy: 45 },
    eligibleExpectancy2x: 40,
    edgeCI: { mean: 40, lo: -10, hi: 90, n: 2 },
    quarantined: { count: 1 },
    allClosed: { count: 3, winRate: 0.67, profitFactor: 2.1, expectancy: 60 },
    markedEquity: { count: 3, value: 120, perTrade: 40 },
  } } };
  const md = renderLedgerMarkdown(report);
  assert.match(md, /mean-rev-rsi2/);
  assert.match(md, /eligible/i);
  assert.match(md, /edge CI/i);
  assert.match(md, /-10.*90/); // CI bounds rendered
});
