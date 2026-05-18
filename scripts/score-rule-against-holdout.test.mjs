import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';

import { buildVerdict, scoreMaxPositionSizePct, scoreStopAtPct, scoreMaxConcurrentPositions, scoreNoReentryWithinHours, scoreDteBounds } from './score-rule-against-holdout.mjs';

test('buildVerdict: trades_affected = 0 -> INCONCLUSIVE', () => {
  const v = buildVerdict({
    predicate: 'stop_at_pct', params: { stop: -0.10 },
    holdout_size: 15, trades_affected: 0, net_pl_delta_usd: 0,
    blocked_winners: 0, blocked_losers: 0, details: [],
  });
  assert.equal(v.verdict, 'INCONCLUSIVE');
});

test('buildVerdict: 1 trade affected, small delta -> INCONCLUSIVE', () => {
  const v = buildVerdict({
    predicate: 'stop_at_pct', params: { stop: -0.10 },
    holdout_size: 15, trades_affected: 1, net_pl_delta_usd: 50,
    blocked_winners: 0, blocked_losers: 1, details: [],
  });
  assert.equal(v.verdict, 'INCONCLUSIVE');
});

test('buildVerdict: 1 trade, large absolute delta -> APPROVED', () => {
  const v = buildVerdict({
    predicate: 'stop_at_pct', params: { stop: -0.10 },
    holdout_size: 15, trades_affected: 1, net_pl_delta_usd: 250,
    blocked_winners: 0, blocked_losers: 1, details: [],
  });
  assert.equal(v.verdict, 'APPROVED-BY-HOLDOUT');
});

test('buildVerdict: 4 trades, small delta -> APPROVED (passes trade-count gate)', () => {
  const v = buildVerdict({
    predicate: 'stop_at_pct', params: { stop: -0.10 },
    holdout_size: 15, trades_affected: 4, net_pl_delta_usd: 80,
    blocked_winners: 1, blocked_losers: 3, details: [],
  });
  assert.equal(v.verdict, 'APPROVED-BY-HOLDOUT');
});

test('buildVerdict: gate cleared with negative delta -> REJECTED', () => {
  const v = buildVerdict({
    predicate: 'stop_at_pct', params: { stop: -0.10 },
    holdout_size: 15, trades_affected: 4, net_pl_delta_usd: -300,
    blocked_winners: 2, blocked_losers: 2, details: [],
  });
  assert.equal(v.verdict, 'REJECTED-BY-HOLDOUT');
});

test('buildVerdict: envelope always carries review_type "mechanical"', () => {
  const v = buildVerdict({
    predicate: 'max_position_size_pct', params: { limit: 0.15 },
    holdout_size: 15, trades_affected: 0, net_pl_delta_usd: 0,
    blocked_winners: 0, blocked_losers: 0, details: [],
  });
  assert.equal(v.review_type, 'mechanical');
});

test('buildVerdict: limitation_notes propagated when provided', () => {
  const v = buildVerdict({
    predicate: 'stop_at_pct', params: { stop: -0.10 },
    holdout_size: 15, trades_affected: 2, net_pl_delta_usd: 150,
    blocked_winners: 0, blocked_losers: 2, details: [],
    limitation_notes: ['cannot see intra-trade trough'],
  });
  assert.deepEqual(v.limitation_notes, ['cannot see intra-trade trough']);
});

test('scoreMaxPositionSizePct: no holdout trades -> INCONCLUSIVE', () => {
  const v = scoreMaxPositionSizePct([], { limit: 0.15 });
  assert.equal(v.verdict, 'INCONCLUSIVE');
  assert.equal(v.trades_affected, 0);
});

test('scoreMaxPositionSizePct: trade within limit -> not flagged', () => {
  const trades = [{
    symbol: 'SPY',
    market_data: { entry_price: 500, size: 30, portfolio_value: 100000, friction_adjusted_pl: 200 },
  }]; // size/value = 0.15 exactly = not over.
  const v = scoreMaxPositionSizePct(trades, { limit: 0.15 });
  assert.equal(v.trades_affected, 0);
});

test('scoreMaxPositionSizePct: oversized winning trade -> flagged, delta is negative of pl', () => {
  const trades = [{
    symbol: 'SPY',
    market_data: { entry_price: 500, size: 50, portfolio_value: 100000, friction_adjusted_pl: 800 },
  }]; // 0.25 > 0.15.
  const v = scoreMaxPositionSizePct(trades, { limit: 0.15 });
  assert.equal(v.trades_affected, 1);
  assert.equal(v.net_pl_delta_usd, -800); // would have prevented an $800 winner
  assert.equal(v.blocked_winners, 1);
});

test('scoreMaxPositionSizePct: oversized losing trade -> flagged, delta is positive', () => {
  const trades = [{
    symbol: 'SPY',
    market_data: { entry_price: 500, size: 50, portfolio_value: 100000, friction_adjusted_pl: -500 },
  }];
  const v = scoreMaxPositionSizePct(trades, { limit: 0.15 });
  assert.equal(v.trades_affected, 1);
  assert.equal(v.net_pl_delta_usd, 500); // would have prevented a $500 loss
  assert.equal(v.blocked_losers, 1);
});

test('scoreMaxPositionSizePct: mixed -> net delta is sum', () => {
  const trades = [
    { symbol: 'A', market_data: { entry_price: 500, size: 50, portfolio_value: 100000, friction_adjusted_pl: 800 } },
    { symbol: 'B', market_data: { entry_price: 500, size: 50, portfolio_value: 100000, friction_adjusted_pl: -500 } },
  ];
  const v = scoreMaxPositionSizePct(trades, { limit: 0.15 });
  assert.equal(v.trades_affected, 2);
  assert.equal(v.net_pl_delta_usd, -300);
});

test('scoreStopAtPct: includes limitation_notes always', () => {
  const v = scoreStopAtPct([], { stop: -0.10 });
  assert.ok(v.limitation_notes.length > 0);
  assert.match(v.limitation_notes[0], /intra-trade trough/);
});

test('scoreStopAtPct: trade that closed at -5% with stop -10% -> not flagged', () => {
  const trades = [{
    symbol: 'SPY',
    market_data: { entry_price: 100, size: 100, friction_adjusted_pl: -500, unrealized_pct: -5 },
  }];
  const v = scoreStopAtPct(trades, { stop: -0.10 });
  assert.equal(v.trades_affected, 0);
});

test('scoreStopAtPct: trade that closed at -15% with stop -10% -> flagged, positive delta (rule cuts earlier)', () => {
  // entry_value = 100 × 100 = 10000. Stop at -10% → -1000 exit. Actual pl = -1500.
  // Delta = -1000 - (-1500) = +500 (rule would save $500).
  const trades = [{
    symbol: 'SPY',
    market_data: { entry_price: 100, size: 100, friction_adjusted_pl: -1500, unrealized_pct: -15 },
  }];
  const v = scoreStopAtPct(trades, { stop: -0.10 });
  assert.equal(v.trades_affected, 1);
  assert.equal(v.net_pl_delta_usd, 500);
});

test('scoreMaxConcurrentPositions: never exceeds limit -> 0 affected', () => {
  const trades = [
    { action: 'BUY', symbol: 'A', timestamp: '2026-05-01T10:00:00Z', market_data: { friction_adjusted_pl: 100 } },
    { action: 'SELL', symbol: 'A', timestamp: '2026-05-01T11:00:00Z', market_data: { friction_adjusted_pl: 100 } },
    { action: 'BUY', symbol: 'B', timestamp: '2026-05-01T12:00:00Z', market_data: { friction_adjusted_pl: 50 } },
  ];
  const v = scoreMaxConcurrentPositions(trades, { limit: 3 });
  assert.equal(v.trades_affected, 0);
});

test('scoreMaxConcurrentPositions: exceeds limit -> flagged', () => {
  // Limit 2. Three BUYs in a row without SELLs.
  const trades = [
    { action: 'BUY', symbol: 'A', timestamp: '2026-05-01T10:00:00Z', market_data: { friction_adjusted_pl: 100 } },
    { action: 'BUY', symbol: 'B', timestamp: '2026-05-01T11:00:00Z', market_data: { friction_adjusted_pl: 50 } },
    { action: 'BUY', symbol: 'C', timestamp: '2026-05-01T12:00:00Z', market_data: { friction_adjusted_pl: -200 } },
  ];
  const v = scoreMaxConcurrentPositions(trades, { limit: 2 });
  assert.equal(v.trades_affected, 1); // only the 3rd BUY pushes count to 3 (>2)
  assert.equal(v.net_pl_delta_usd, 200); // -1 × (-200), preventing the loser saves $200
});

test('scoreNoReentryWithinHours: no reentries -> 0 affected', () => {
  const trades = [
    { action: 'BUY', symbol: 'A', timestamp: '2026-05-01T10:00:00Z', market_data: { friction_adjusted_pl: 50 } },
    { action: 'SELL', symbol: 'A', timestamp: '2026-05-01T11:00:00Z', market_data: { friction_adjusted_pl: 50 } },
    { action: 'BUY', symbol: 'B', timestamp: '2026-05-01T12:30:00Z', market_data: { friction_adjusted_pl: 100 } },
  ];
  const v = scoreNoReentryWithinHours(trades, { hours: 2 });
  assert.equal(v.trades_affected, 0);
});

test('scoreNoReentryWithinHours: reentry within window -> flagged', () => {
  // SELL at 11:00, BUY at 12:30 → 1.5h gap, under 2h window.
  const trades = [
    { action: 'BUY', symbol: 'A', timestamp: '2026-05-01T10:00:00Z', market_data: { friction_adjusted_pl: 50 } },
    { action: 'SELL', symbol: 'A', timestamp: '2026-05-01T11:00:00Z', market_data: { friction_adjusted_pl: 50 } },
    { action: 'BUY', symbol: 'A', timestamp: '2026-05-01T12:30:00Z', market_data: { friction_adjusted_pl: -75 } },
  ];
  const v = scoreNoReentryWithinHours(trades, { hours: 2 });
  assert.equal(v.trades_affected, 1);
  assert.equal(v.net_pl_delta_usd, 75); // prevents a $75 loss
});

test('scoreNoReentryWithinHours: reentry past window -> not flagged', () => {
  const trades = [
    { action: 'SELL', symbol: 'A', timestamp: '2026-05-01T11:00:00Z', market_data: { friction_adjusted_pl: 50 } },
    { action: 'BUY', symbol: 'A', timestamp: '2026-05-01T14:00:00Z', market_data: { friction_adjusted_pl: -75 } },
  ];
  const v = scoreNoReentryWithinHours(trades, { hours: 2 });
  assert.equal(v.trades_affected, 0);
});

test('scoreDteBounds: non-option trade ignored', () => {
  const trades = [{ action: 'BUY', symbol: 'SPY', timestamp: '2026-05-01T10:00:00Z', market_data: { friction_adjusted_pl: 100 } }];
  const v = scoreDteBounds(trades, { min: 50, max: 120 });
  assert.equal(v.trades_affected, 0);
});

test('scoreDteBounds: option DTE within bounds -> not flagged', () => {
  // Entry 2026-05-01, exp 260801 (Aug 1) = ~92 days.
  const trades = [{
    action: 'BUY', symbol: 'SPY260801C00400000', timestamp: '2026-05-01T10:00:00Z',
    market_data: { friction_adjusted_pl: 100 },
  }];
  const v = scoreDteBounds(trades, { min: 50, max: 120 });
  assert.equal(v.trades_affected, 0);
});

test('scoreDteBounds: option DTE under min -> flagged', () => {
  // Entry 2026-05-01, exp 260510 = 9 days.
  const trades = [{
    action: 'BUY', symbol: 'SPY260510C00400000', timestamp: '2026-05-01T10:00:00Z',
    market_data: { friction_adjusted_pl: -200 },
  }];
  const v = scoreDteBounds(trades, { min: 50, max: 120 });
  assert.equal(v.trades_affected, 1);
  assert.equal(v.net_pl_delta_usd, 200); // prevents a $200 loss
});

test('scoreDteBounds: option DTE over max -> flagged', () => {
  // Entry 2026-05-01, exp 270501 = 365 days.
  const trades = [{
    action: 'BUY', symbol: 'SPY270501C00400000', timestamp: '2026-05-01T10:00:00Z',
    market_data: { friction_adjusted_pl: 50 },
  }];
  const v = scoreDteBounds(trades, { min: 50, max: 120 });
  assert.equal(v.trades_affected, 1);
});

import { dispatchPredicate, SUPPORTED_PREDICATES } from './score-rule-against-holdout.mjs';

test('dispatchPredicate: max_position_size_pct routes correctly', () => {
  const v = dispatchPredicate('max_position_size_pct', { limit: 0.15 }, []);
  assert.equal(v.predicate, 'max_position_size_pct');
});

test('dispatchPredicate: unknown name throws with supported list', () => {
  assert.throws(
    () => dispatchPredicate('nonexistent', {}, []),
    /unknown predicate.*max_position_size_pct/,
  );
});

test('SUPPORTED_PREDICATES contains the 5 starter predicates', () => {
  assert.deepEqual(SUPPORTED_PREDICATES.sort(), [
    'dte_bounds',
    'max_concurrent_positions',
    'max_position_size_pct',
    'no_reentry_within_hours',
    'stop_at_pct',
  ]);
});

import { etDateFromTimestamp, lookupRegime, joinRegimeToTrades, computeRegimeAnnotations } from './score-rule-against-holdout.mjs';

test('etDateFromTimestamp: Friday 17:00 ET in DST -> Friday', () => {
  // 2026-05-15T21:00:00Z = Friday 17:00 ET (DST is on)
  assert.equal(etDateFromTimestamp('2026-05-15T21:00:00.000Z'), '2026-05-15');
});

test('etDateFromTimestamp: Friday 21:00 ET in DST (next UTC day) -> Friday', () => {
  // 2026-05-16T01:00:00Z = Friday 21:00 ET DST
  assert.equal(etDateFromTimestamp('2026-05-16T01:00:00.000Z'), '2026-05-15');
});

test('etDateFromTimestamp: malformed timestamp -> null', () => {
  assert.equal(etDateFromTimestamp('not-a-date'), null);
});

test('lookupRegime: direct hit', () => {
  const labels = { '2026-05-14': 'chop', '2026-05-15': 'bull-trend' };
  assert.equal(lookupRegime('2026-05-15', labels), 'bull-trend');
});

test('lookupRegime: walks back across weekend to last trading day', () => {
  const labels = { '2026-05-15': 'bull-trend' }; // Friday
  // 2026-05-17 = Sunday; should walk back to Friday
  assert.equal(lookupRegime('2026-05-17', labels), 'bull-trend');
});

test('lookupRegime: walk-back limited to 5 calendar days', () => {
  const labels = { '2026-05-10': 'bull-trend' };
  // 2026-05-20 is 10 days later -> exceeds 5-day cap -> unknown
  assert.equal(lookupRegime('2026-05-20', labels), null);
});

test('joinRegimeToTrades: tags each trade with regime field', () => {
  const labels = { '2026-05-15': 'bull-trend', '2026-05-14': 'chop' };
  const trades = [
    { symbol: 'A', timestamp: '2026-05-15T15:00:00Z', market_data: {} },
    { symbol: 'B', timestamp: '2026-05-14T19:00:00Z', market_data: {} },
    { symbol: 'C', timestamp: '2026-04-01T15:00:00Z', market_data: {} }, // unknown
  ];
  const out = joinRegimeToTrades(trades, labels);
  assert.equal(out[0].regime, 'bull-trend');
  assert.equal(out[1].regime, 'chop');
  assert.equal(out[2].regime, 'unknown');
});

test('computeRegimeAnnotations: trades_affected < 5 -> regime_warning_skipped', () => {
  const affected = [
    { regime: 'bull-trend' }, { regime: 'bull-trend' }, { regime: 'bull-trend' },
  ];
  const result = computeRegimeAnnotations(affected, { 'bull-trend': 0.5, chop: 0.4, 'bear-trend': 0.1 });
  assert.equal(result.regime_warning_skipped, 'insufficient_sample (need >= 5 affected trades; have 3)');
  assert.equal(result.regime_warning, undefined);
});

test('computeRegimeAnnotations: >= 5 affected, over-index >= 25pp -> regime_warning', () => {
  const affected = [
    { regime: 'bull-trend' }, { regime: 'bull-trend' }, { regime: 'bull-trend' },
    { regime: 'bull-trend' }, { regime: 'bull-trend' }, { regime: 'bull-trend' },
  ];
  // adapt set is 60% bull, 30% chop, 10% bear; affected is 100% bull -> 40pp over-index
  const result = computeRegimeAnnotations(affected, { 'bull-trend': 0.6, chop: 0.3, 'bear-trend': 0.1 });
  assert.match(result.regime_warning, /100% bull-trend/);
  assert.match(result.regime_warning, /60%/);
  assert.match(result.regime_warning, /40pp/);
  assert.equal(result.regime_warning_skipped, undefined);
});

test('computeRegimeAnnotations: >= 5 affected, no over-index -> neither field present', () => {
  const affected = [
    { regime: 'bull-trend' }, { regime: 'bull-trend' }, { regime: 'bull-trend' },
    { regime: 'bull-trend' }, { regime: 'chop' }, { regime: 'chop' },
  ];
  // adapt is 60% bull, 30% chop, 10% bear; affected is 67% bull, 33% chop -> +7pp/+3pp, no warning
  const result = computeRegimeAnnotations(affected, { 'bull-trend': 0.6, chop: 0.3, 'bear-trend': 0.1 });
  assert.equal(result.regime_warning, undefined);
  assert.equal(result.regime_warning_skipped, undefined);
});

test('computeRegimeAnnotations: unknown regime trades excluded from both sides', () => {
  const affected = [
    { regime: 'bull-trend' }, { regime: 'bull-trend' }, { regime: 'bull-trend' },
    { regime: 'bull-trend' }, { regime: 'bull-trend' }, { regime: 'unknown' },
  ];
  // Excluding unknown: 5 bull, denominator 5. adapt-set excluded? No -- we just use the provided baseline.
  const result = computeRegimeAnnotations(affected, { 'bull-trend': 0.5, chop: 0.5 });
  // Affected: 100% bull (excluding unknown). adapt: 50% bull -> +50pp.
  assert.match(result.regime_warning, /50pp/);
});

test('computeRegimeAnnotations: 0 affected -> no warning either way', () => {
  const result = computeRegimeAnnotations([], { 'bull-trend': 0.6 });
  assert.equal(result.regime_warning, undefined);
  assert.equal(result.regime_warning_skipped, undefined);
});

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

test('CLI: --regime-history + --adapt-set-distribution produce regime_warning when over-indexed', async () => {
  // Build a 6-trade hold-out where all 6 exceed the position-size limit AND all happen on bull-trend days.
  const trades = [];
  for (let i = 0; i < 6; i += 1) {
    trades.push({
      action: 'BUY',
      symbol: 'X', timestamp: `2026-05-1${i}T15:00:00Z`,
      market_data: { entry_price: 100, size: 100, portfolio_value: 50000, friction_adjusted_pl: -50 },
    });
  }
  const _here = dirname(fileURLToPath(import.meta.url));
  const regimeFile = join(_here, '__tmp_regime_cli__.json');
  writeFileSync(regimeFile, JSON.stringify({
    as_of: '2026-05-15T21:30:00Z',
    range: { from: '2026-05-10', to: '2026-05-15' },
    classifier: { version: '2026-05-18.1' },
    labels: Object.fromEntries(trades.map(t => [t.timestamp.slice(0, 10), 'bull-trend'])),
  }));
  const result = spawnSync('node', [
    'scripts/score-rule-against-holdout.mjs',
    '--predicate', 'max_position_size_pct',
    '--params', '{"limit":0.10}',
    '--regime-history', regimeFile,
    '--adapt-set-distribution', '{"bull-trend":0.5,"chop":0.4,"bear-trend":0.1}',
  ], { input: JSON.stringify(trades), encoding: 'utf8' });
  rmSync(regimeFile, { force: true });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.regime_warning, `expected regime_warning, got envelope: ${JSON.stringify(parsed)}`);
  assert.match(parsed.regime_warning, /bull-trend/);
});
