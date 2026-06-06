// scripts/fleet-universe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TURTLE_ETFS, clusterOf, MEANREV_UNIVERSE, BENCHMARKS, allFleetTickers } from './fleet-universe.mjs';

test('turtle ETF basket mirrors trend_universe.go: 15 names, 6 clusters', () => {
  assert.equal(TURTLE_ETFS.length, 15);
  assert.equal(clusterOf('TLT'), 'rates');
  assert.equal(clusterOf('GLD'), 'metals');
  assert.equal(clusterOf('EEM'), 'intl_equity');
  assert.equal(clusterOf('SPY'), ''); // not in basket
  const clusters = new Set(TURTLE_ETFS.map(e => e.cluster));
  assert.deepEqual([...clusters].sort(), ['commodity','energy','fx','intl_equity','metals','rates']);
});

test('benchmarks are QQQ (primary) and SPY (reference)', () => {
  assert.deepEqual(BENCHMARKS, ['QQQ', 'SPY']);
});

test('allFleetTickers is the deduped union of ETFs + meanrev + benchmarks', () => {
  const all = allFleetTickers();
  assert.ok(all.includes('TLT') && all.includes('AAPL') && all.includes('QQQ'));
  assert.equal(all.length, new Set(all).size); // deduped
});
