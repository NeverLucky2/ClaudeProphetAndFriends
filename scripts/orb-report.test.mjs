// scripts/orb-report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropTopN, edgeByHour } from './orb-report.mjs';

const approx = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) <= e, `${a} ≈ ${b}`);

test('dropTopN removes the n largest before averaging', () => {
  approx(dropTopN([1, 1, 1, 100], 1), 1);          // drop the 100
  approx(dropTopN([1, 2, 3], 0), 2);
});
test('edgeByHour buckets by ET hour from minutes-of-day', () => {
  const rows = [{ entryMinutes: 590, r: 1 }, { entryMinutes: 595, r: 3 }, { entryMinutes: 840, r: -1 }];
  const e = edgeByHour(rows);
  const h9 = e.find(x => x.hour === 9); const h14 = e.find(x => x.hour === 14);
  assert.equal(h9.n, 2); approx(h9.mean, 2);
  assert.equal(h14.n, 1); approx(h14.mean, -1);
});
