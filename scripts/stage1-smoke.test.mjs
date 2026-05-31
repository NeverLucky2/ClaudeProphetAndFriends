// scripts/stage1-smoke.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFirings, thinFirings, splitByDate } from './stage1-signals.mjs';
import { buildPreregArtifact, verifyPrereg } from './stage1-prereg.mjs';
import { scoreSplit } from './stage1-score.mjs';

// One ticker, 60 rising sessions -> bullish tape; positive catalysts every 4th session.
function risingBars(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const close = 100 + i;
    const m = String(Math.floor(i / 28) + 1).padStart(2, '0');
    const d = String((i % 28) + 1).padStart(2, '0');
    out.push({ date: `2026-${m}-${d}`, open: close - 0.5, high: close + 1, low: close - 1, close });
  }
  return out;
}

test('end-to-end: build -> thin -> split -> score yields a verdict; artifact verifies', () => {
  const bars = risingBars(60);
  const barsByTicker = new Map([['AAA', bars]]);
  const catalysts = [];
  for (let i = 20; i < 55; i += 4) {
    catalysts.push({ ticker: 'AAA', date: bars[i].date, event_type: 'earnings', headline: 'tops estimates', snippet: '' });
  }
  const firings = splitByDate(thinFirings(buildFirings(catalysts, barsByTicker, 3), 3), bars[40].date);
  assert.ok(firings.length > 0);

  const artifact = buildPreregArtifact({ universeText: 'AAA\n', frictionText: '{}', splitDate: bars[40].date });
  assert.equal(verifyPrereg(artifact).ok, true);

  const holdout = firings.filter(f => f.split === 'holdout');
  const r = scoreSplit(holdout, artifact, { HR0Final: artifact.null.HR0_floor });
  // tiny n -> must be UNDERPOWERED (the honest result on a toy sample)
  assert.equal(r.verdict, 'UNDERPOWERED');
});
