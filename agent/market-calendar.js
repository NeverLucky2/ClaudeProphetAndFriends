// Shared US market (NYSE) holiday calendar — single source of truth for the
// JS side (harness phase logic + preflight predicates + the get_datetime tool).
//
// Scope: FULL-CLOSE holidays only. Half-days / early closes (e.g. the day after
// Thanksgiving, Christmas Eve when observed as a 1pm close) are deliberately
// EXCLUDED — the market is open those mornings, so phase/preflight logic must
// treat them as normal trading days. A half-day in this set would wrongly make
// agents skip a live session.
//
// Dates are NYSE-observed (a Saturday holiday is observed the preceding Friday,
// a Sunday holiday the following Monday), expressed as America/New_York calendar
// dates "YYYY-MM-DD". Extend this list as new years are published by the NYSE.
//
// This module imports nothing from harness.js / preflight.js, so both can import
// it without the import cycle noted in preflight.js.
export const MARKET_HOLIDAYS = new Set([
  // 2025
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18',
  '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01',
  '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
  '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07',
  '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26',
  '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06',
  '2027-11-25', '2027-12-24',
]);

// etDateString returns the America/New_York calendar date ("YYYY-MM-DD") for a
// Date. en-CA locale formats as YYYY-MM-DD; the timeZone option pins it to ET so
// the result is correct regardless of the host machine's local timezone.
export function etDateString(now) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// isMarketHoliday returns true when `now` falls on a full-close US market
// holiday (by ET calendar date). Weekends are NOT treated as holidays here —
// callers detect weekends separately (a Saturday is "closed" but not a
// "holiday"). Unknown future years (beyond MARKET_HOLIDAYS) return false; keep
// the list current.
export function isMarketHoliday(now) {
  return MARKET_HOLIDAYS.has(etDateString(now));
}

// ── Trading-day arithmetic (holiday-aware) ──────────────────────────────────
// All helpers operate on ET calendar-date strings "YYYY-MM-DD". A noon-UTC
// anchor is used for stepping so DST never shifts the calendar date.
function _addCalendarDay(etDate) {
  const d = new Date(etDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// isTradingDay: a weekday that is not a full-close holiday.
export function isTradingDay(etDate) {
  const dow = new Date(etDate + 'T12:00:00Z').getUTCDay(); // 0 Sun .. 6 Sat
  if (dow === 0 || dow === 6) return false;
  return !MARKET_HOLIDAYS.has(etDate);
}

// nextTradingDay: the first trading day strictly after etDate.
export function nextTradingDay(etDate) {
  let d = _addCalendarDay(etDate);
  while (!isTradingDay(d)) d = _addCalendarDay(d);
  return d;
}

// addTradingDays: advance n trading days from etDate (n=0 returns etDate as-is,
// even if etDate itself is a weekend/holiday — callers anchor the start first).
export function addTradingDays(etDate, n) {
  let d = etDate;
  for (let i = 0; i < n; i++) d = nextTradingDay(d);
  return d;
}
