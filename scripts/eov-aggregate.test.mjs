import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateCallVol, contractCountByMonth } from './eov-aggregate.mjs';

const bars = {
  'C1': [{ date: '2024-02-01', v: 100 }, { date: '2024-02-02', v: 50 }],
  'C2': [{ date: '2024-02-01', v: 10 }, { date: '2024-03-01', v: 7 }],
  'C3': [{ date: '2024-02-01', v: NaN }],
};

test('aggregateCallVol sums finite volume per date across contracts', () => {
  const a = aggregateCallVol(bars);
  assert.equal(a['2024-02-01'], 110); // 100 + 10, NaN dropped
  assert.equal(a['2024-02-02'], 50);
  assert.equal(a['2024-03-01'], 7);
});

test('contractCountByMonth counts distinct contracts trading per month', () => {
  const c = contractCountByMonth(bars);
  assert.equal(c['2024-02'], 2); // C1, C2 (C3 has no finite bar)
  assert.equal(c['2024-03'], 1); // C2
});
