import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRollup } from './coil-shadow-rollup.mjs';

// Non-degenerate closed episodes with a planted +2% fire-early edge over declined,
// absorbed day shock via day fixed effects. 6 names/day: RSI spans [5,15) so every
// bucket is populated; gaps are decorrelated (deterministic pseudo-noise) so the
// pooled within design is full column rank; fire is decoupled from RSI across days.
// (The plan's original 4-name/day fixture was degenerate and made the regression
// singular; this one is controller-verified to recover beta=0.02 exactly.)
function episodes() {
  const g = (a, b) => { const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return x - Math.floor(x); };
  const eps = [];
  for (let d = 0; d < 40; d += 1) {
    const dayShock = (d % 5) * 0.01;
    for (let i = 0; i < 6; i += 1) {
      const fire = d % 2 === 0 ? i < 3 : i >= 3; // varies within day, decoupled from RSI
      eps.push({ name: `N${i}`, openDate: `day-${d}`, tag: fire ? 'fire_early' : 'declined',
        status: 'closed', rsi2AtEntry: 5 + i * 1.6, sma5GapAtEntry: -2 + 2 * g(i, d),
        sma200GapAtEntry: 2 + 8 * g(i + 7, d + 3), ret: dayShock + (fire ? 0.02 : 0), outcome: 'bounce' });
    }
  }
  return eps;
}

test('terminal rollup recovers the planted edge and returns KEEP', async () => {
  const io = { readEpisodes: async () => episodes() };
  const r = await runRollup({ io, stage: 'terminal' });
  assert.ok(Math.abs(r.beta - 0.02) < 1e-3, `beta=${r.beta}`);
  assert.equal(r.verdict, 'KEEP');
  assert.ok(r.report.includes('KEEP'));
  assert.ok(r.report.includes('columns kept: 7/7'));
});

test('futility stage returns a gate, never KEEP', async () => {
  const io = { readEpisodes: async () => episodes() };
  const r = await runRollup({ io, stage: 'futility' });
  assert.ok(r.gate === 'continue' || r.gate === 'early-reject');
  assert.equal(r.verdict, undefined);
});

test('only closed, tagged episodes enter the regression', async () => {
  const eps = [...episodes(),
    { name: 'U', openDate: 'x', tag: 'unknown', status: 'closed', rsi2AtEntry: 6, sma5GapAtEntry: -1, sma200GapAtEntry: 5, ret: 9, outcome: 'bounce' },
    { name: 'O', openDate: 'y', tag: 'fire_early', status: 'open', rsi2AtEntry: 6, sma5GapAtEntry: -1, sma200GapAtEntry: 5 }];
  const io = { readEpisodes: async () => eps };
  const r = await runRollup({ io, stage: 'terminal' });
  assert.ok(Math.abs(r.beta - 0.02) < 1e-3); // the ret=9 unknown/open rows excluded
});
