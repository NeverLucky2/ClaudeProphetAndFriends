import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOrderValue } from './mcp-order-value.js';

test('stock buy: limit_price x qty, no multiplier', () => {
  assert.equal(computeOrderValue('place_buy_order', { limit_price: 50, qty: 10 }), 500);
});
test('options order: limit_price x qty x 100', () => {
  assert.equal(computeOrderValue('place_options_order', { limit_price: 6, quantity: 30 }), 18000);
});
test('allocation_dollars wins when provided', () => {
  assert.equal(computeOrderValue('place_managed_position', { allocation_dollars: 1500, limit_price: 1, qty: 1 }), 1500);
});
test('market options order with no price computes 0 (Go layer blocks)', () => {
  assert.equal(computeOrderValue('place_options_order', { quantity: 5 }), 0);
});
test('condor tools are NOT given the single-leg x100', () => {
  assert.equal(computeOrderValue('open_iron_condor', { limit_price: 2, quantity: 3 }), 6);
});
