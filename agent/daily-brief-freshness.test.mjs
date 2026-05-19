// Tests for the daily-brief freshness contract (constants + pure helpers).
// The constants must stay in sync with regime_gate's 29h window, and the
// helpers must be deterministic so the scheduler/MCP server can rely on
// them without flakiness around clock skew.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STALE_AFTER_HOURS,
  DAILY_BRIEF_FILENAME,
  injectFreshnessFields,
  parseBriefStaleness,
  briefAsOfDate,
} from './daily-brief-freshness.js';

test('STALE_AFTER_HOURS matches regime_gate 29h window', () => {
  // Must equal scripts/compute_daily_regime_score.py STALE_AFTER_HOURS (=29).
  // If you change one side, change both — or the operator's mental model
  // for "what counts as stale" diverges across cross-agent gates.
  assert.equal(STALE_AFTER_HOURS, 29);
});

test('DAILY_BRIEF_FILENAME is the stable filename', () => {
  assert.equal(DAILY_BRIEF_FILENAME, 'daily_brief.json');
});

test('injectFreshnessFields adds as_of and stale_after without mutating input', () => {
  const original = { date: '2026-05-19', summary: 'test', breadth_score: 42 };
  const now = new Date('2026-05-19T13:30:00.000Z');
  const out = injectFreshnessFields(original, now);

  // Original untouched (pure helper contract).
  assert.deepEqual(original, { date: '2026-05-19', summary: 'test', breadth_score: 42 });

  // as_of is exactly the supplied `now` in ISO.
  assert.equal(out.as_of, '2026-05-19T13:30:00.000Z');

  // stale_after is now + STALE_AFTER_HOURS, computed deterministically.
  // 13:30Z + 29h = next day 18:30Z.
  assert.equal(out.stale_after, '2026-05-20T18:30:00.000Z');

  // Existing fields preserved.
  assert.equal(out.date, '2026-05-19');
  assert.equal(out.summary, 'test');
  assert.equal(out.breadth_score, 42);
});

test('injectFreshnessFields overrides pre-existing as_of/stale_after (scheduler is source of truth)', () => {
  // If the LLM happened to write its own as_of/stale_after, the scheduler's
  // post-process must win — LLM clocks are unreliable.
  const original = {
    date: '2026-05-19',
    as_of: '1999-01-01T00:00:00.000Z',
    stale_after: '1999-01-02T00:00:00.000Z',
  };
  const now = new Date('2026-05-19T13:30:00.000Z');
  const out = injectFreshnessFields(original, now);

  assert.equal(out.as_of, '2026-05-19T13:30:00.000Z');
  assert.equal(out.stale_after, '2026-05-20T18:30:00.000Z');
});

test('parseBriefStaleness: fresh brief reports not stale', () => {
  const brief = {
    as_of: '2026-05-19T13:30:00.000Z',
    stale_after: '2026-05-20T18:30:00.000Z',
  };
  const now = new Date('2026-05-19T15:00:00.000Z'); // 1.5h after as_of
  const r = parseBriefStaleness(brief, now);
  assert.equal(r.isStale, false);
  assert.equal(r.hasFields, true);
  assert.equal(r.asOf, '2026-05-19T13:30:00.000Z');
  assert.equal(r.staleAfter, '2026-05-20T18:30:00.000Z');
});

test('parseBriefStaleness: expired brief reports stale', () => {
  const brief = {
    as_of: '2026-05-19T13:30:00.000Z',
    stale_after: '2026-05-20T18:30:00.000Z',
  };
  // 1 minute past stale_after.
  const now = new Date('2026-05-20T18:31:00.000Z');
  const r = parseBriefStaleness(brief, now);
  assert.equal(r.isStale, true);
  assert.equal(r.hasFields, true);
});

test('parseBriefStaleness: brief missing stale_after is treated as stale', () => {
  // Defensive: if the scheduler's post-process step was interrupted and the
  // file lacks freshness fields, force a re-run instead of silently trusting
  // it. The LLM-written body alone is not a freshness contract.
  const brief = { date: '2026-05-19', summary: 'no fields' };
  const now = new Date('2026-05-19T15:00:00.000Z');
  const r = parseBriefStaleness(brief, now);
  assert.equal(r.isStale, true);
  assert.equal(r.hasFields, false);
});

test('parseBriefStaleness: malformed stale_after is treated as stale', () => {
  const brief = { as_of: 'not-a-date', stale_after: 'also-not-a-date' };
  const now = new Date('2026-05-19T15:00:00.000Z');
  const r = parseBriefStaleness(brief, now);
  assert.equal(r.isStale, true);
  assert.equal(r.hasFields, false);
});

test('briefAsOfDate extracts UTC YYYY-MM-DD', () => {
  // Scheduler "have we run today?" compares this to today's ISO date slug.
  // Must be UTC date — using local time would cause double-runs near midnight.
  const brief = { as_of: '2026-05-19T23:45:00.000Z' };
  assert.equal(briefAsOfDate(brief), '2026-05-19');
});

test('briefAsOfDate returns null when as_of missing or malformed', () => {
  assert.equal(briefAsOfDate({}), null);
  assert.equal(briefAsOfDate({ as_of: 'garbage' }), null);
  assert.equal(briefAsOfDate(null), null);
});
