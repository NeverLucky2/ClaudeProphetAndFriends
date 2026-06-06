// scripts/orb-universe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORB_ETF_UNIVERSE, ORB_LARGECAP_EXPLORATORY, BENCHMARK, gatedMktrelTickers, allOrbTickers } from './orb-universe.mjs';

test('ETF cut is the four liquid index ETFs', () => {
  assert.deepEqual([...ORB_ETF_UNIVERSE].sort(), ['DIA', 'IWM', 'QQQ', 'SPY']);
});
test('large-cap cut is exploratory momentum names', () => {
  for (const t of ['AAPL', 'NVDA', 'TSLA', 'AMD', 'META']) assert.ok(ORB_LARGECAP_EXPLORATORY.includes(t));
});
test('benchmark is SPY; gate_mktrel excludes SPY', () => {
  assert.equal(BENCHMARK, 'SPY');
  assert.deepEqual([...gatedMktrelTickers()].sort(), ['DIA', 'IWM', 'QQQ']);
});
test('allOrbTickers unions ETF + largecap + benchmark, deduped', () => {
  const a = allOrbTickers();
  assert.equal(new Set(a).size, a.length);
  assert.ok(a.includes('SPY') && a.includes('AAPL'));
});
