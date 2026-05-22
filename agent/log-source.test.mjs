import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLogPanes } from './public/log-source.js';

test('non-Go line (no source, no prefix) → reasoning pane only', () => {
  assert.deepEqual(
    classifyLogPanes({ message: 'Beat #12: scanning momentum', level: 'info' }),
    { main: true, go: false },
  );
});

test('Go info (source flag) → Go console only', () => {
  assert.deepEqual(
    classifyLogPanes({ source: 'go', message: '[go:4536] fetching bars', level: 'info' }),
    { main: false, go: true },
  );
});

test('Go stderr warning → Go console only (routine, not mirrored)', () => {
  assert.deepEqual(
    classifyLogPanes({ source: 'go', message: '[go:4536] slow response', level: 'warning' }),
    { main: false, go: true },
  );
});

test('Go ready (success) → Go console only', () => {
  assert.deepEqual(
    classifyLogPanes({ source: 'go', message: 'Trading backend ready on port 4536', level: 'success' }),
    { main: false, go: true },
  );
});

test('Go error (crash) → both panes', () => {
  assert.deepEqual(
    classifyLogPanes({ source: 'go', message: 'Trading backend crashed — auto-restarting', level: 'error' }),
    { main: true, go: true },
  );
});

test('untagged [go:PORT] info (regex fallback) → Go console only', () => {
  assert.deepEqual(
    classifyLogPanes({ message: '[go:4536] legacy line', level: 'info' }),
    { main: false, go: true },
  );
});

test('untagged [go:PORT] error → both panes', () => {
  assert.deepEqual(
    classifyLogPanes({ message: '[go:4536] boom', level: 'error' }),
    { main: true, go: true },
  );
});

test('Go line with missing level → Go console only (does not mirror)', () => {
  assert.deepEqual(
    classifyLogPanes({ source: 'go', message: '[go:4536] no level field' }),
    { main: false, go: true },
  );
});

test('empty / missing input defaults to reasoning pane only (never vanishes)', () => {
  assert.deepEqual(classifyLogPanes(), { main: true, go: false });
  assert.deepEqual(classifyLogPanes({}), { main: true, go: false });
  assert.deepEqual(classifyLogPanes({ message: undefined }), { main: true, go: false });
});
