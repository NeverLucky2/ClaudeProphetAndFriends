// scripts/ema-universe.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMA_ETF_UNIVERSE, EMA_LARGECAP_UNIVERSE, BENCHMARKS, allStudyTickers } from './ema-universe.mjs';

test('ETF universe = Turtle macro basket + equity index ETFs, deduped', () => {
  for (const t of ['TLT', 'GLD', 'USO', 'DBC', 'UUP', 'EEM', 'EFA', 'SPY', 'QQQ', 'IWM']) {
    assert.ok(EMA_ETF_UNIVERSE.includes(t), `${t} missing`);
  }
  assert.equal(new Set(EMA_ETF_UNIVERSE).size, EMA_ETF_UNIVERSE.length, 'no dupes');
  assert.ok(!EMA_ETF_UNIVERSE.includes('DIA'), 'DIA excluded by default (near-redundant with SPY)');
});

test('large-cap cut reuses the Coil MEANREV universe', () => {
  assert.ok(EMA_LARGECAP_UNIVERSE.includes('AAPL') && EMA_LARGECAP_UNIVERSE.length >= 70);
});

test('benchmarks are SPY and QQQ', () => {
  assert.deepEqual(BENCHMARKS, ['SPY', 'QQQ']);
});

test('allStudyTickers unions everything incl. benchmarks, deduped', () => {
  const all = allStudyTickers();
  assert.ok(all.includes('SPY') && all.includes('AAPL') && all.includes('TLT'));
  assert.equal(new Set(all).size, all.length);
});
