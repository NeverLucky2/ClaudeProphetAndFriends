import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBrokerStatus, reconcileTrades } from './trade-reconciliation.js';

const ok = (symbol, side, status, filledQty = 0) => ({ symbol, side, status, filledQty });
const log = (symbol, side, status) => ({ symbol, side, status, timestamp: '2026-05-26T13:33:00Z' });

test('classifyBrokerStatus: terminal-took / terminal-reject / unresolved', () => {
  assert.equal(classifyBrokerStatus('filled'), 'took');
  assert.equal(classifyBrokerStatus('partially_filled'), 'took');
  assert.equal(classifyBrokerStatus('done_for_day', 3), 'took');
  assert.equal(classifyBrokerStatus('done_for_day', 0), 'unresolved');
  assert.equal(classifyBrokerStatus('rejected'), 'reject');
  assert.equal(classifyBrokerStatus('canceled'), 'reject');
  assert.equal(classifyBrokerStatus('expired'), 'reject');
  assert.equal(classifyBrokerStatus('new'), 'unresolved');
  assert.equal(classifyBrokerStatus('pending_new'), 'unresolved');
  assert.equal(classifyBrokerStatus('accepted'), 'unresolved');
});

test('phantom success: logged success, no terminal broker order', () => {
  const r = reconcileTrades([log('AMD', 'buy', 'success')], []);
  assert.equal(r.counts.phantomSuccess, 1);
  assert.equal(r.mismatches[0].class, 'phantom_success');
  assert.equal(r.mismatches[0].symbol, 'AMD');
});

test('false failure: logged failed, broker filled', () => {
  const r = reconcileTrades([log('AMD', 'buy', 'failed')], [ok('AMD', 'buy', 'filled', 2)]);
  assert.equal(r.counts.falseFailure, 1);
  assert.equal(r.mismatches[0].class, 'false_failure');
});

test('status divergence: 3 logged success, broker 1 filled + 2 rejected → 2', () => {
  const r = reconcileTrades(
    [log('QQQ', 'buy', 'success'), log('QQQ', 'buy', 'success'), log('QQQ', 'buy', 'success')],
    [ok('QQQ', 'buy', 'filled', 4), ok('QQQ', 'buy', 'rejected'), ok('QQQ', 'buy', 'rejected')],
  );
  assert.equal(r.counts.statusDivergence, 2);
  assert.equal(r.mismatches[0].class, 'status_divergence');
});

test('clean day: logged success matched by a fill → no mismatch', () => {
  const r = reconcileTrades([log('AMD', 'buy', 'success')], [ok('AMD', 'buy', 'filled', 2)]);
  assert.equal(r.mismatches.length, 0);
  assert.equal(r.counts.phantomSuccess + r.counts.falseFailure + r.counts.statusDivergence, 0);
});

test('non-terminal: logged failed vs pending_new order → zero mismatches, unresolved counted', () => {
  const r = reconcileTrades([log('AMD', 'buy', 'failed')], [ok('AMD', 'buy', 'pending_new')]);
  assert.equal(r.mismatches.length, 0);
  assert.equal(r.counts.unresolved, 1);
});

test('empty inputs: no throw, zero counts', () => {
  const r = reconcileTrades([], []);
  assert.equal(r.mismatches.length, 0);
  assert.equal(r.counts.total, 0);
});
