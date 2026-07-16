import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isEvalCandidate, weekdaysBetween, openEpisodes } from './coil-shadow-episodes.mjs';

const base = { ticker: 'X', entry_signal: false, earnings_within_5d: false,
  last_close: 98, rsi_2: 6, sma_5: 100, sma_200: 90, as_of: '2026-07-15T20:00:00Z' };

test('isEvalCandidate: strict pullback below the 5-day', () => {
  assert.equal(isEvalCandidate(base), true);
  assert.equal(isEvalCandidate({ ...base, last_close: 100.4 }), false); // above SMA5 (the band classifyWatch would allow)
  assert.equal(isEvalCandidate({ ...base, last_close: 100 }), false);   // equal to SMA5, not strictly below
  assert.equal(isEvalCandidate({ ...base, rsi_2: 4 }), false);          // firing, not WATCH
  assert.equal(isEvalCandidate({ ...base, last_close: 80 }), false);    // below SMA200, out of regime
  assert.equal(isEvalCandidate({ ...base, earnings_within_5d: true }), false);
});

test('weekdaysBetween counts trading days, skipping the weekend', () => {
  assert.equal(weekdaysBetween('2026-07-15', '2026-07-16'), 1); // Wed→Thu
  assert.equal(weekdaysBetween('2026-07-17', '2026-07-20'), 1); // Fri→Mon (skip Sat/Sun)
  assert.equal(weekdaysBetween('2026-07-15', '2026-07-22'), 5); // Wed→next Wed
});

test('openEpisodes opens fresh names and blocks reopen within the 5-day window', () => {
  const cand = { ...base, ticker: 'AMGN' };
  const r1 = openEpisodes({ active: {}, candidates: [cand], tags: { AMGN: 'fire_early' }, etDate: '2026-07-15' });
  assert.equal(r1.episodes.length, 1);
  assert.equal(r1.episodes[0].tag, 'fire_early');
  assert.equal(r1.episodes[0].entryRef, 98);
  assert.ok('AMGN' in r1.active);

  // Same name, 2 weekdays later → still active → no new episode.
  const r2 = openEpisodes({ active: r1.active, candidates: [cand], tags: { AMGN: 'declined' }, etDate: '2026-07-17' });
  assert.equal(r2.episodes.length, 0);

  // 6 weekdays after open → window elapsed → reopens.
  const r3 = openEpisodes({ active: r2.active, candidates: [cand], tags: { AMGN: 'declined' }, etDate: '2026-07-23' });
  assert.equal(r3.episodes.length, 1);
});
