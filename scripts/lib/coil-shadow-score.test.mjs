import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreEpisode } from './coil-shadow-score.mjs';

const ep = { name: 'X', openDate: '2026-07-15', entryRef: 98 };
const pt = (d, close, rsi = 20, sma5 = 100) => ({ as_of: `2026-07-${d}T20:00:00Z`, last_close: close, rsi_2: rsi, sma_5: sma5 });

test('target exit: close back above the 5-day → bounce', () => {
  const series = [pt('15', 98), pt('16', 99), pt('17', 101, 20, 100)]; // day 17 close 101 > sma5 100
  const r = scoreEpisode({ ...ep }, series);
  assert.equal(r.status, 'closed');
  assert.equal(r.exitDate, '2026-07-17');
  assert.equal(r.outcome, 'bounce');
  assert.ok(Math.abs(r.ret - (101 - 98) / 98) < 1e-9);
});

test('stop exit takes precedence and books a loss', () => {
  const series = [pt('15', 98), pt('16', 90)]; // 90 <= 98*0.93=91.14 → stop
  const r = scoreEpisode({ ...ep }, series);
  assert.equal(r.outcome, 'no-bounce');
  assert.equal(r.exitClose, 90);
});

test('exit replay never fires on the entry day itself', () => {
  // entry day already looks like a target (close 98 with sma5 97) but must be ignored.
  const series = [{ ...pt('15', 98, 20, 97) }, pt('16', 99), pt('17', 99), pt('18', 99), pt('19', 99), pt('22', 99)];
  const r = scoreEpisode({ ...ep }, series);
  assert.equal(r.status, 'closed');
  assert.equal(r.exitDate, '2026-07-22'); // 5-day timeout, not the entry day
});

test('re-reads entry_ref from the series (single adjustment basis)', () => {
  const series = [pt('15', 50 /* adjusted */), pt('16', 52, 20, 51)]; // close 52 > sma5 51 → target
  const r = scoreEpisode({ ...ep, entryRef: 98 /* stale snapshot value, must be ignored */ }, series);
  assert.ok(Math.abs(r.ret - (52 - 50) / 50) < 1e-9);
});

test('entry day missing from series → unscorable', () => {
  const series = [pt('16', 99), pt('17', 100)];
  const r = scoreEpisode({ ...ep }, series);
  assert.equal(r.status, 'unscorable');
});

test('>50% single-day move in window → unscorable (data glitch)', () => {
  const series = [pt('15', 98), pt('16', 40)]; // -59% one-day move
  const r = scoreEpisode({ ...ep }, series);
  assert.equal(r.status, 'unscorable');
});

test('laterFired flag set when RSI dips below 5 mid-hold', () => {
  const series = [pt('15', 98), pt('16', 97, 3), pt('17', 96, 3), pt('18', 96, 3), pt('19', 96, 3), pt('22', 96, 3)];
  const r = scoreEpisode({ ...ep }, series);
  assert.equal(r.laterFired, true);
});
