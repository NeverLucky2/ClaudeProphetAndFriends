// Tests for holiday-aware phase/preflight logic. Uses node:test (Node ≥ 20).
//
// ET is UTC-4 in May (EDT) and UTC-5 in November (EST). Test instants are given
// in UTC and annotated with the ET wall-clock they map to. 2026-05-25 is
// Memorial Day (a full-close holiday); 2026-11-27 is the day-after-Thanksgiving
// EARLY CLOSE (a half-day — intentionally NOT a holiday here, market is open).
//
// Run: node --test agent/market-calendar.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isMarketHoliday, etDateString, MARKET_HOLIDAYS, isTradingDay, nextTradingDay, addTradingDays } from './market-calendar.js';
import { getCurrentPhase, secondsToNextPhaseBoundary } from './harness.js';
import { isClosedPhase, outOfTrendWindow } from './preflight.js';

// ── market-calendar module ─────────────────────────────────────────

test('isMarketHoliday: Memorial Day 2026-05-25 is a holiday', () => {
  assert.equal(isMarketHoliday(new Date('2026-05-25T18:00:00Z')), true); // 14:00 ET Mon
});

test('isMarketHoliday: New Year 2026-01-01 is a holiday', () => {
  assert.equal(isMarketHoliday(new Date('2026-01-01T17:00:00Z')), true); // 12:00 ET (EST)
});

test('isMarketHoliday: a normal weekday is not a holiday', () => {
  assert.equal(isMarketHoliday(new Date('2026-05-21T18:00:00Z')), false); // Thu
});

test('isMarketHoliday: day-after-Thanksgiving half-day is NOT treated as a holiday', () => {
  // 2026-11-27 is an early-close (1pm) day — market IS open, so excluded by design.
  assert.equal(isMarketHoliday(new Date('2026-11-27T19:00:00Z')), false); // 14:00 ET Fri (EST)
  assert.equal(MARKET_HOLIDAYS.has('2026-11-27'), false);
});

test('etDateString: late-UTC instant rolls back a day in ET', () => {
  // 03:00Z on 05-25 = 23:00 ET on 05-24 (EDT, UTC-4).
  assert.equal(etDateString(new Date('2026-05-25T03:00:00Z')), '2026-05-24');
  assert.equal(etDateString(new Date('2026-05-25T12:00:00Z')), '2026-05-25'); // 08:00 ET
});

// ── getCurrentPhase (harness) ──────────────────────────────────────

test('getCurrentPhase: holiday weekday → closed (even during would-be market hours)', () => {
  // Mon 2026-05-25 14:00 ET would be "midday" if it were a trading day.
  assert.equal(getCurrentPhase(new Date('2026-05-25T18:00:00Z')), 'closed');
});

test('getCurrentPhase: normal weekday midday → midday (unchanged)', () => {
  assert.equal(getCurrentPhase(new Date('2026-05-21T18:00:00Z')), 'midday'); // Thu 14:00 ET
});

test('getCurrentPhase: half-day (day after Thanksgiving) stays open, not closed', () => {
  assert.equal(getCurrentPhase(new Date('2026-11-27T19:00:00Z')), 'midday'); // Fri 14:00 ET
});

// ── secondsToNextPhaseBoundary (harness) ───────────────────────────

test('secondsToNextPhaseBoundary: on a holiday Monday, rolls to Tuesday 04:00', () => {
  // Mon 2026-05-25 04:00 ET (Memorial Day). Holiday skip → Tue 2026-05-26 04:00 ET = 24h.
  assert.equal(secondsToNextPhaseBoundary(new Date('2026-05-25T08:00:00Z')), 24 * 3600);
});

test('secondsToNextPhaseBoundary: Friday evening rolls past weekend AND Monday holiday', () => {
  // Fri 2026-05-22 17:00 ET → skip Sat, Sun, Mon(Memorial Day) → Tue 2026-05-26 04:00 ET = 83h.
  assert.equal(secondsToNextPhaseBoundary(new Date('2026-05-22T21:00:00Z')), 83 * 3600);
});

// ── isClosedPhase (preflight) ──────────────────────────────────────

test('isClosedPhase: holiday weekday → closed with reason "market holiday"', () => {
  const r = isClosedPhase(new Date('2026-05-25T18:00:00Z')); // Mon 14:00 ET
  assert.equal(r.closed, true);
  assert.equal(r.reason, 'market holiday');
});

test('isClosedPhase: normal weekday midday → not closed', () => {
  assert.equal(isClosedPhase(new Date('2026-05-21T18:00:00Z')).closed, false); // Thu 14:00 ET
});

// ── outOfTrendWindow (preflight) ───────────────────────────────────

test('outOfTrendWindow: holiday inside the 17:00 window → out', () => {
  const r = outOfTrendWindow(new Date('2026-05-25T21:00:00Z')); // Mon 17:00 ET, Memorial Day
  assert.equal(r.out, true);
  assert.match(r.reason, /holiday/);
});

test('outOfTrendWindow: normal weekday inside the 17:00 window → in window', () => {
  assert.equal(outOfTrendWindow(new Date('2026-05-21T21:00:00Z')).out, false); // Thu 17:00 ET
});

// ── Trading-day arithmetic ────────────────────────────────────────────

test('isTradingDay: weekdays true, weekends and holidays false', () => {
  assert.equal(isTradingDay('2026-05-28'), true);   // Thursday
  assert.equal(isTradingDay('2026-05-30'), false);  // Saturday
  assert.equal(isTradingDay('2026-05-31'), false);  // Sunday
  assert.equal(isTradingDay('2026-05-25'), false);  // Memorial Day (holiday)
});

test('nextTradingDay skips weekend', () => {
  assert.equal(nextTradingDay('2026-05-29'), '2026-06-01'); // Fri -> Mon
});

test('nextTradingDay skips a holiday', () => {
  assert.equal(nextTradingDay('2026-05-22'), '2026-05-26'); // Fri -> (Sat/Sun/Memorial) -> Tue
});

test('addTradingDays counts only trading days, holiday-aware', () => {
  // From Thu 2026-05-21: +1=Fri 22, +2 skips Sat/Sun/Memorial -> Tue 26, +3 -> Wed 27
  assert.equal(addTradingDays('2026-05-21', 3), '2026-05-27');
  assert.equal(addTradingDays('2026-05-21', 0), '2026-05-21'); // n=0 is identity
});
