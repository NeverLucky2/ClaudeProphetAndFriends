import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAccountMode } from './config-store.js';

const PAPER = 'https://paper-api.alpaca.markets';
const LIVE = 'https://api.alpaca.markets';

test('defaults baseUrl from the paper flag', () => {
  assert.deepEqual(resolveAccountMode({ paper: true }), { baseUrl: PAPER, paper: true });
  assert.deepEqual(resolveAccountMode({ paper: false }), { baseUrl: LIVE, paper: false });
});

test('accepts a baseUrl that agrees with the paper flag', () => {
  assert.deepEqual(resolveAccountMode({ baseUrl: LIVE, paper: false }), { baseUrl: LIVE, paper: false });
  assert.deepEqual(resolveAccountMode({ baseUrl: PAPER, paper: true }), { baseUrl: PAPER, paper: true });
});

// The false-comfort failure: an account labelled paper that points at real money.
test('rejects a live baseUrl labelled paper', () => {
  assert.throws(() => resolveAccountMode({ baseUrl: LIVE, paper: true }), /mode mismatch/i);
});

test('rejects a paper baseUrl labelled live', () => {
  assert.throws(() => resolveAccountMode({ baseUrl: PAPER, paper: false }), /mode mismatch/i);
});

test('rejects an unrecognized host (fails closed)', () => {
  assert.throws(() => resolveAccountMode({ baseUrl: 'https://example.com', paper: true }), /unrecognized/i);
});

test('trailing slashes and case do not defeat the check', () => {
  assert.throws(() => resolveAccountMode({ baseUrl: 'HTTPS://API.ALPACA.MARKETS/', paper: true }), /mode mismatch/i);
});

// Regression: updateAccount used the OLD paper value to default an empty
// baseUrl, so flipping paper alone left the URL pointing at the other mode.
test('flipping paper with no explicit baseUrl moves the URL', () => {
  assert.deepEqual(resolveAccountMode({ baseUrl: '', paper: false }), { baseUrl: LIVE, paper: false });
});
