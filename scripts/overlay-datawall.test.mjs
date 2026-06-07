// scripts/overlay-datawall.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suppressedEras, dataWallSummary } from './overlay-datawall.mjs';

test('suppressedEras flags years over the dropped-weight threshold', () => {
  const dw = { '2016': 0.55, '2017': 0.40, '2020': 0.05, '2022': 0.02 };
  assert.deepEqual(suppressedEras(dw, { threshold: 0.30 }), ['2016', '2017']);
});

test('dataWallSummary reports VIXM + curve coverage flags', () => {
  const s = dataWallSummary({
    earliest: { VIXM: '2011-01-10', __curve: '2002-01-02' },
    droppedByYear: { '2020': 0.05 }, windowStart: '2016-01-01',
  });
  assert.equal(s.vixmCoversWindow, true);
  assert.equal(s.curveCoversWindow, true);
  assert.ok(Array.isArray(s.suppressed));
});
