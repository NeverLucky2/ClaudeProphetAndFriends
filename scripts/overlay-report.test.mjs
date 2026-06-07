// scripts/overlay-report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from './overlay-report.mjs';

test('renderReport emits the key sections', () => {
  const model = {
    preregHash: 'abc123',
    dataWall: { vixm: '2011-01-10', curve: '2002-01-02', vixmCoversWindow: true, curveCoversWindow: true, droppedByYear: { '2016': 0.5, '2022': 0.02 }, suppressed: ['2016'] },
    targets: [{
      name: 'Reconstructed Merrill book',
      rows: [{ candidate: 'Static GLD', size: '10%', calmDrag: 0.9, lumped: { mean: 0.3, lo: 0.1, hi: 0.5, episodes: 3 }, rateShock: { mean: -0.1, lo: -0.3, hi: 0.1, episodes: 1 }, growthScare: { mean: 0.4, lo: 0.2, hi: 0.6, episodes: 2 }, efficiency: { flag: 'ok', value: 0.33 }, regimeClass: 'fragile' }],
      stress: [{ candidate: 'def-Prophet proxy', grid: { '-0.10': 5, '-0.20': 10, '-0.30': 10 } }],
      recommendation: { branch: 'b', pick: 'def_prophet', text: 'Only def-Prophet is regime-robust.' },
    }],
  };
  const md = renderReport(model);
  assert.match(md, /# Fleet Hedge-Overlay/);
  assert.match(md, /Pre-registration hash/);
  assert.match(md, /Data-wall/);
  assert.match(md, /Reconstructed Merrill book/);
  assert.match(md, /Recommendation/);
  assert.match(md, /episodes/i);
});
