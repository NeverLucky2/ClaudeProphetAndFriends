import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DURATION_ETF, RATES_CLUSTER, BENCHMARKS, CARRY_TICKERS,
  MOD_DUR, ROLL_FROM, ROLL_TO, CASH_FIELD, CARRY_CACHE_SUBDIR,
} from './carry-universe.mjs';

test('duration leg is IEF; rates cluster is Turtle\'s {TLT,IEF,TIP}', () => {
  assert.equal(DURATION_ETF, 'IEF');
  assert.deepEqual([...RATES_CLUSTER].sort(), ['IEF', 'TIP', 'TLT']);
});
test('CARRY_TICKERS is the de-duped union of duration+cluster+benchmarks', () => {
  assert.ok(CARRY_TICKERS.includes('IEF') && CARRY_TICKERS.includes('QQQ'));
  assert.equal(CARRY_TICKERS.length, new Set(CARRY_TICKERS).size);
});
test('roll constants are the documented defaults', () => {
  assert.equal(MOD_DUR, 7.5);
  assert.equal(ROLL_FROM, 'y10');
  assert.equal(ROLL_TO, 'y7');
  assert.equal(CASH_FIELD, 'm3');
});
test('cache subdir lives under data/lab', () => {
  assert.ok(CARRY_CACHE_SUBDIR.replaceAll('\\', '/').endsWith('data/lab/carry-cache'));
});
