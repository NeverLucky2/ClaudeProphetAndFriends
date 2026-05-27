import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTokenDelta, formatBeatCostLine } from './beat-cost.js';

test('extractTokenDelta reads opencode token shape { input, output, reasoning, cache:{read,write} }', () => {
  const d = extractTokenDelta({ input: 1200, output: 800, reasoning: 50, cache: { read: 42000, write: 1200 } });
  assert.deepEqual(d, { input: 1200, output: 800, reasoning: 50, cacheRead: 42000, cacheWrite: 1200 });
});

test('extractTokenDelta defaults missing fields / cache subobject / null to 0', () => {
  const zero = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  assert.deepEqual(extractTokenDelta({}), zero);
  assert.deepEqual(extractTokenDelta(null), zero);
  assert.deepEqual(extractTokenDelta(undefined), zero);
  assert.deepEqual(extractTokenDelta({ input: 100 }), { ...zero, input: 100 });
  assert.deepEqual(extractTokenDelta({ cache: {} }), zero);
});

test('extractTokenDelta coerces non-finite values to 0', () => {
  assert.deepEqual(
    extractTokenDelta({ input: 'x', output: NaN, cache: { read: null, write: undefined } }),
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  );
});

test('formatBeatCostLine: cost, total (from parts), breakdown, and hit rate', () => {
  // total = 1200 + 800 + 42000 + 1200 = 45200; hit = 42000/(42000+1200+1200) = 94.6% → 95%
  const line = formatBeatCostLine({ cost: 0.0123, input: 1200, output: 800, cacheRead: 42000, cacheWrite: 1200 });
  assert.match(line, /Beat cost: \$0\.0123/);
  assert.match(line, /tokens 45\.2k/);
  assert.match(line, /in 1\.2k/);
  assert.match(line, /out 800/);
  assert.match(line, /cache 42\.0k read \/ 1\.2k write/);
  assert.match(line, /cache hit 95%/);
});

test('formatBeatCostLine: zero input → hit rate n/a, no NaN', () => {
  const line = formatBeatCostLine({ cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.match(line, /cache hit n\/a/);
  assert.match(line, /tokens 0 /);
  assert.doesNotMatch(line, /NaN/);
});

test('formatBeatCostLine: tolerates missing args (all default 0)', () => {
  const line = formatBeatCostLine({});
  assert.match(line, /Beat cost: \$0\.0000/);
  assert.match(line, /cache hit n\/a/);
});
