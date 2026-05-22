import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goLog } from './go-log.js';

test('stamps source:"go" and passes through fields', () => {
  assert.deepEqual(
    goLog('s_prophet', 'info', '[go:4536] fetching bars'),
    { sandboxId: 's_prophet', level: 'info', message: '[go:4536] fetching bars', source: 'go' },
  );
});

test('preserves error level for lifecycle lines', () => {
  assert.deepEqual(
    goLog('s_turtle', 'error', 'Trading backend crashed — auto-restarting in 5s...'),
    { sandboxId: 's_turtle', level: 'error', message: 'Trading backend crashed — auto-restarting in 5s...', source: 'go' },
  );
});
