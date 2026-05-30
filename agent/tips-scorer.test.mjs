// agent/tips-scorer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProphetSandboxes, loadProphetActions, underlyingOf, extractRealizedPnl } from './tips-scorer.js';

async function tmpRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scorer-'));
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  await fs.writeFile(path.join(root, 'data', 'agent-config.json'), JSON.stringify({
    sandboxes: {
      sbx_6e4f26af: { accountId: '6e4f26af', agent: { activeAgentId: 'default' } },
      sbx_mean_rev: { accountId: '6e4f26af', agent: { activeAgentId: 'mean-rev' } },
    },
  }));
  return root;
}
async function writeAction(root, accountId, fname, action) {
  const dir = path.join(root, 'data', 'sandboxes', accountId, 'decisive_actions');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, fname), JSON.stringify(action));
}

test('underlyingOf extracts the underlying from OCC symbols and passes plain tickers', () => {
  assert.equal(underlyingOf('AMD260717C00460000'), 'AMD');
  assert.equal(underlyingOf('QQQ260515C00712000'), 'QQQ');
  assert.equal(underlyingOf('NVDA'), 'NVDA');
  assert.equal(underlyingOf('SPY'), 'SPY');
});

test('resolveProphetSandboxes returns the default agent folder + sandbox key', async () => {
  const root = await tmpRoot();
  const sbx = await resolveProphetSandboxes(root);
  assert.equal(sbx.length, 1);
  assert.equal(sbx[0].accountId, '6e4f26af');
  assert.equal(sbx[0].sandboxId, 'sbx_6e4f26af');
});

test('loadProphetActions filters the co-mingled folder by sandbox_id', async () => {
  const root = await tmpRoot();
  await writeAction(root, '6e4f26af', '2026-05-20T19-41-25Z_BUY_UNH.json',
    { timestamp: '2026-05-20T19:41:25Z', sandbox_id: 'sbx_mean_rev', action: 'BUY', symbol: 'UNH', market_data: {} });
  await writeAction(root, '6e4f26af', '2026-05-11T13-41-55Z_BUY_QQQ.json',
    { timestamp: '2026-05-11T13:41:55Z', sandbox_id: 'sbx_6e4f26af', action: 'BUY', symbol: 'QQQ260515C00712000', market_data: { entry_price: 7.6, contracts: 6 } });
  const actions = await loadProphetActions(root);
  assert.equal(actions.length, 1);                 // mean-rev action excluded
  assert.equal(actions[0].symbol, 'QQQ260515C00712000');
});

const md = (market_data, reasoning = '') => ({ action: 'SELL', symbol: 'AMD260717C00460000', reasoning, market_data });

test('extractRealizedPnl prefers friction_adjusted_pl, then raw_pl', () => {
  assert.deepEqual(extractRealizedPnl(md({ friction_adjusted_pl: -800, raw_pl: -795 })),
    { pnl: -800, source: 'friction_adjusted_pl', confidence: 'high' });
  assert.deepEqual(extractRealizedPnl(md({ raw_pl: -795 })),
    { pnl: -795, source: 'raw_pl', confidence: 'high' });
});

test('extractRealizedPnl reads signed free-form dollar fields', () => {
  assert.equal(extractRealizedPnl(md({ option_loss_dollars: -795 })).pnl, -795);
  assert.equal(extractRealizedPnl(md({ option_pnl_dollars: 240 })).pnl, 240);
});

test('extractRealizedPnl normalizes sign for magnitude-style loss/gain fields', () => {
  // a *loss* field stored as a positive magnitude must come out negative
  assert.equal(extractRealizedPnl(md({ loss_dollars: 312 })).pnl, -312);
  assert.equal(extractRealizedPnl(md({ gain_dollars: -50 })).pnl, 50);
});

test('extractRealizedPnl computes from cost basis + current price when contracts known', () => {
  const r = extractRealizedPnl(md({ option_cost_basis: 43.15, option_current_price: 35.2 }), { contracts: 10 });
  assert.ok(Math.abs(r.pnl - ((35.2 - 43.15) * 10 * 100)) < 1e-6); // -7950
  assert.equal(r.source, 'computed_from_prices');
});

test('extractRealizedPnl falls back to a dollar figure in reasoning (low confidence)', () => {
  const r = extractRealizedPnl(md({}, 'Hard stop. Position reached -19.5% loss (-$795) by 10:15.'));
  assert.equal(r.pnl, -795);
  assert.equal(r.confidence, 'low');
});

test('extractRealizedPnl returns null/none when nothing is resolvable', () => {
  assert.deepEqual(extractRealizedPnl(md({ option_price: 4.2 })),
    { pnl: null, source: 'unresolved', confidence: 'none' });
});

import { loadAgentSurfacedIndex, agentSurfacedFor } from './tips-scorer.js';

async function writeBrief(root, ymd, brief) {
  const dir = path.join(root, 'data', 'reports');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `daily_brief_${ymd}.json`), JSON.stringify(brief));
}

test('loadAgentSurfacedIndex maps tickers to the dates the scans flagged them', async () => {
  const root = await tmpRoot();
  await writeBrief(root, '20260518', {
    date: '2026-05-18',
    analyst_actions: [{ ticker: 'NVDA', date: '2026-05-18T11:52:08+00:00' }],
    ticker_catalysts: [{ ticker: 'MSFT', published: '2026-05-18T16:26:57+00:00' }],
  });
  const idx = await loadAgentSurfacedIndex(root);
  assert.ok(idx.get('NVDA').includes('2026-05-18'));
  assert.ok(idx.get('MSFT').includes('2026-05-18'));
  assert.equal(idx.has('AAPL'), false);
});

test('agentSurfacedFor is true only when a flag date falls inside the window', () => {
  const idx = new Map([['NVDA', ['2026-05-18', '2026-05-26']]]);
  assert.equal(agentSurfacedFor(idx, 'NVDA', '2026-05-18', '2026-05-21'), true);
  assert.equal(agentSurfacedFor(idx, 'NVDA', '2026-05-19', '2026-05-21'), false); // 18 before, 26 after
  assert.equal(agentSurfacedFor(idx, 'AAPL', '2026-05-18', '2026-05-21'), false);
});

import { computeViewA } from './tips-scorer.js';

test('computeViewA scores every active tip: underlying return, SPY benchmark, agentSurfaced split', async () => {
  const root = await tmpRoot();
  // price data: NVDA +10% over the window, SPY +2% -> excess +8%
  const closesBySymbol = new Map([
    ['NVDA', new Map([['2026-05-21', 100], ['2026-05-27', 110]])],
    ['SPY', new Map([['2026-05-21', 500], ['2026-05-27', 510]])],
  ]);
  const tips = [
    { id: 't1', ticker: 'NVDA', source: 'self', phase: 'active', actionableAt: '2026-05-21T14:00:00-04:00', dismissed: false },
    { id: 't2', ticker: 'NVDA', source: 'dad', phase: 'pending_candidate', actionableAt: null, dismissed: false },
  ];
  const surfaced = new Map(); // none surfaced -> human-exclusive
  const out = await computeViewA(tips, {
    windowDays: 3, todayEtDate: '2026-05-29', surfacedIndex: surfaced,
    loadCloses: async (sym) => closesBySymbol.get(sym) || new Map(),
  });
  assert.equal(out.rows.length, 1);              // only the active tip is scored
  const r = out.rows[0];
  assert.ok(Math.abs(r.underlyingReturn - 0.10) < 1e-9);
  assert.ok(Math.abs(r.spyReturn - 0.02) < 1e-9);
  assert.ok(Math.abs(r.excessReturn - 0.08) < 1e-9);
  assert.equal(r.agentSurfaced, false);
  assert.equal(r.status, 'ok');
});

test('computeViewA marks a not-yet-closed window pending (still shown — D12 misses at equal prominence)', async () => {
  const root = await tmpRoot();
  const tips = [{ id: 't3', ticker: 'IBM', source: 'self', phase: 'active', actionableAt: '2026-05-28T14:00:00-04:00', dismissed: false }];
  const out = await computeViewA(tips, {
    windowDays: 3, todayEtDate: '2026-05-29', surfacedIndex: new Map(),
    loadCloses: async () => new Map([['2026-05-28', 250]]),
  });
  assert.equal(out.rows[0].status, 'pending');
  assert.equal(out.rows[0].underlyingReturn, null);
});

import { computeViewB } from './tips-scorer.js';

function buy(ts, symbol, contracts) {
  return { timestamp: ts, sandbox_id: 'sbx_6e4f26af', action: 'BUY', symbol, market_data: { entry_price: 7.6, contracts } };
}
function sell(ts, symbol, md, reasoning = '') {
  return { timestamp: ts, sandbox_id: 'sbx_6e4f26af', action: 'SELL', symbol, market_data: md, reasoning };
}

test('computeViewB matches in-window opens to their closes and extracts realized P&L', () => {
  const tips = [{ id: 't1', ticker: 'AMD', source: 'self', phase: 'active', actionableAt: '2026-05-20T14:00:00-04:00', dismissed: false }];
  const actions = [
    buy('2026-05-20T15:00:00Z', 'AMD260717C00460000', 10),
    sell('2026-05-21T14:16:23Z', 'AMD260717C00460000', { option_loss_dollars: -795 }, '-19.5% loss (-$795)'),
  ];
  const out = computeViewB(tips, actions, { windowDays: 3, surfacedIndex: new Map() });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].pnl, -795);
  assert.equal(out.rows[0].pnlConfidence, 'medium');
  assert.equal(out.rows[0].underlying, 'AMD');
  assert.equal(out.coverage.resolved, 1);
  assert.equal(out.coverage.unresolved, 0);
});

test('computeViewB ignores opens entered outside the tip window', () => {
  const tips = [{ id: 't1', ticker: 'AMD', source: 'self', phase: 'active', actionableAt: '2026-05-20T14:00:00-04:00', dismissed: false }];
  const actions = [
    buy('2026-06-15T15:00:00Z', 'AMD260717C00460000', 10), // weeks later, outside window
    sell('2026-06-16T14:16:23Z', 'AMD260717C00460000', { option_loss_dollars: -795 }),
  ];
  const out = computeViewB(tips, actions, { windowDays: 3, surfacedIndex: new Map() });
  assert.equal(out.rows.length, 0);
});

test('computeViewB reports unresolved closes as data-gaps, never as $0', () => {
  const tips = [{ id: 't1', ticker: 'NVDA', source: 'self', phase: 'active', actionableAt: '2026-05-20T14:00:00-04:00', dismissed: false }];
  const actions = [
    buy('2026-05-20T15:00:00Z', 'NVDA260717C00230000', 5),
    sell('2026-05-21T14:16:23Z', 'NVDA260717C00230000', { option_price: 4.2 }), // no resolvable P&L
  ];
  const out = computeViewB(tips, actions, { windowDays: 3, surfacedIndex: new Map() });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].pnl, null);
  assert.equal(out.rows[0].pnlConfidence, 'none');
  assert.equal(out.coverage.resolved, 0);
  assert.equal(out.coverage.unresolved, 1);
});

import { summarizeDistribution, scoreTips } from './tips-scorer.js';

import { matchTippedTrades } from './tips-scorer.js';

test('matchTippedTrades flags buys on an active tip underlying within the window', () => {
  const tips = [{ id: 't1', ticker: 'AMD', source: 'self', phase: 'active', actionableAt: '2026-05-20T14:00:00-04:00', dismissed: false }];
  const trades = [
    { sandboxId: 'sbx_6e4f26af', tool: 'place_options_order', symbol: 'AMD260717C00460000', side: 'buy', timestamp: '2026-05-20T15:00:00Z' },
    { sandboxId: 'sbx_6e4f26af', tool: 'place_options_order', symbol: 'AMD260717C00460000', side: 'sell', timestamp: '2026-05-21T15:00:00Z' },
    { sandboxId: 'sbx_6e4f26af', tool: 'place_options_order', symbol: 'NVDA260717C00230000', side: 'buy', timestamp: '2026-05-20T15:00:00Z' },
    { sandboxId: 'sbx_6e4f26af', tool: 'place_options_order', symbol: 'AMD260717C00460000', side: 'buy', timestamp: '2026-07-01T15:00:00Z' },
  ];
  const out = matchTippedTrades(tips, trades, { windowDays: 3 });
  assert.equal(out.length, 1);
  assert.equal(out[0].symbol, 'AMD260717C00460000');
  assert.equal(out[0].source, 'self');
  assert.equal(out[0].timestamp, '2026-05-20T15:00:00Z');
});

test('summarizeDistribution flags small samples and demotes profit factor (D11)', () => {
  const s = summarizeDistribution([-795, 240, 120], { minSample: 20 });
  assert.equal(s.n, 3);
  assert.equal(s.smallSample, true);            // below threshold
  assert.equal(s.median, 120);
  assert.equal(s.profitFactorSuppressed, true); // demoted at small n
  assert.ok(Math.abs(s.sum - (-795 + 240 + 120)) < 1e-9);
});

test('summarizeDistribution exposes profit factor only at/above threshold', () => {
  const data = Array.from({ length: 20 }, (_, i) => (i % 2 ? 100 : -50));
  const s = summarizeDistribution(data, { minSample: 20 });
  assert.equal(s.smallSample, false);
  assert.equal(s.profitFactorSuppressed, false);
  assert.ok(Math.abs(s.profitFactor - (1000 / 500)) < 1e-9);
});

test('scoreTips assembles A/B/C + perSource and never emits a single headline score', async () => {
  const root = await tmpRoot();
  await fs.mkdir(path.join(root, 'data', 'tips'), { recursive: true });
  await fs.writeFile(path.join(root, 'data', 'tips', 'tips.json'), JSON.stringify([
    { id: 't1', ticker: 'NVDA', source: 'self', phase: 'active', actionableAt: '2026-05-21T14:00:00-04:00', dismissed: false, thesis: 'x' },
  ]));
  const out = await scoreTips(root, {
    windowDays: 3, minSample: 20, todayEtDate: '2026-05-29',
    loadCloses: async (sym) => new Map([['2026-05-21', sym === 'SPY' ? 500 : 100], ['2026-05-27', sym === 'SPY' ? 510 : 110]]),
  });
  assert.ok(out.viewA && out.viewB && out.viewC && out.perSource && out.meta);
  assert.equal('headlineScore' in out.meta, false); // ledger, not leaderboard
  assert.equal(out.viewA.rows[0].ticker, 'NVDA');
  assert.ok(out.meta.windowDays === 3);
});

test('computeViewB attributes a shared in-window trade to the earliest tip (spec §9)', () => {
  // Two tips on AMD with overlapping windows; the later-listed tip is EARLIER in time.
  const tips = [
    { id: 'late',  ticker: 'AMD', source: 'dad',  phase: 'active', actionableAt: '2026-05-20T14:00:00-04:00', dismissed: false },
    { id: 'early', ticker: 'AMD', source: 'self', phase: 'active', actionableAt: '2026-05-19T14:00:00-04:00', dismissed: false },
  ];
  const actions = [
    { timestamp: '2026-05-20T15:00:00Z', sandbox_id: 'sbx_6e4f26af', action: 'BUY',  symbol: 'AMD260717C00460000', market_data: { entry_price: 7.6, contracts: 10 } },
    { timestamp: '2026-05-21T14:16:23Z', sandbox_id: 'sbx_6e4f26af', action: 'SELL', symbol: 'AMD260717C00460000', market_data: { option_loss_dollars: -795 } },
  ];
  const out = computeViewB(tips, actions, { windowDays: 3, surfacedIndex: new Map() });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].tipId, 'early');   // earliest actionableAt wins
  assert.equal(out.rows[0].source, 'self');
});
