import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOutcomeCard, gradeMechanical, hasProphetCloses,
  gatherProphetTheses, renderMarkdown, writeTradeGradesReport, readTradeGradesSummary,
} from './trade-grades.mjs';

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
