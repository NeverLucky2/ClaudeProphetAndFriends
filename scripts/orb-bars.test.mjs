// scripts/orb-bars.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { etParts, toSessionBars, loadOrbSessions } from './orb-bars.mjs';

test('etParts converts an EST 14:30Z bar to 09:30 ET = minute 570', () => {
  const p = etParts('2020-01-02T14:30:00Z');
  assert.equal(p.date, '2020-01-02');
  assert.equal(p.minutes, 570);
});
test('etParts handles EDT (13:30Z = 09:30 ET in summer)', () => {
  assert.equal(etParts('2020-07-01T13:30:00Z').minutes, 570);
});
test('toSessionBars keeps RTH only, groups by ET date, sorts ascending', () => {
  const raw = [
    { Timestamp: '2020-01-02T14:00:00Z', Open: 1, High: 1, Low: 1, Close: 1, Volume: 9 }, // 09:00 ET pre-market → dropped
    { Timestamp: '2020-01-02T14:30:00Z', Open: 2, High: 3, Low: 1, Close: 2.5, Volume: 10 }, // 09:30 ET kept
    { Timestamp: '2020-01-02T20:55:00Z', Open: 5, High: 6, Low: 4, Close: 5, Volume: 11 }, // 15:55 ET kept
    { Timestamp: '2020-01-02T21:00:00Z', Open: 9, High: 9, Low: 9, Close: 9, Volume: 1 }, // 16:00 ET → dropped (>=960)
  ];
  const s = toSessionBars(raw);
  assert.equal(s.length, 1);
  assert.equal(s[0].date, '2020-01-02');
  assert.deepEqual(s[0].bars.map(b => b.minutes), [570, 955]);
});
test('loadOrbSessions reads {bars:[...]} from the lab cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'orb-'));
  mkdirSync(join(root, 'data', 'lab', 'orb-bar-cache'), { recursive: true });
  writeFileSync(join(root, 'data', 'lab', 'orb-bar-cache', 'SPY.json'), JSON.stringify({ bars: [
    { Timestamp: '2020-01-02T14:30:00Z', Open: 2, High: 3, Low: 1, Close: 2.5, Volume: 10 },
  ] }));
  const s = loadOrbSessions(root, 'SPY');
  assert.equal(s[0].bars[0].close, 2.5);
});
