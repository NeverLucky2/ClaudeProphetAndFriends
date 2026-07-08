// agent/veto-log.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './veto-log.js';

test('parseArgs maps --flag value pairs', () => {
  const a = parseArgs(['--date', '2026-07-07', '--ticker', 'AMAT', '--ref', '552.30', '--reason', 'catalyst_driven']);
  assert.deepEqual(a, { date: '2026-07-07', ticker: 'AMAT', ref: '552.30', reason: 'catalyst_driven' });
});

test('parseArgs throws when a flag token is malformed', () => {
  assert.throws(() => parseArgs(['ticker', 'AMAT']), /--flag/);
});
