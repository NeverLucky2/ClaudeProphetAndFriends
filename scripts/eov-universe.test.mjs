import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EOV_UNIVERSE, BENCHMARK, BENCHMARK2, eovUniverse, allEovStockTickers } from './eov-universe.mjs';

test('universe is the fixed paper-derived 20, no dupes, no GOOG/SQ', () => {
  assert.equal(EOV_UNIVERSE.length, 20);
  assert.equal(new Set(EOV_UNIVERSE).size, 20);
  assert.ok(EOV_UNIVERSE.includes('GOOGL') && !EOV_UNIVERSE.includes('GOOG'));
  assert.ok(!EOV_UNIVERSE.includes('SQ'));
});

test('allEovStockTickers adds QQQ + SPY benchmarks', () => {
  assert.equal(BENCHMARK, 'QQQ');
  assert.equal(BENCHMARK2, 'SPY');
  const all = allEovStockTickers();
  assert.equal(all.length, 22);
  assert.ok(all.includes('QQQ') && all.includes('SPY'));
  assert.deepEqual(eovUniverse(), EOV_UNIVERSE);
});
