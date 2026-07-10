import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_BARS, FIRE_MAX, NEAR_MISS_HI, RESOLUTION_CAP,
  barFacts, factsSeries, stateOf, resolveEpisode, enumerateEpisodes,
} from './coil-nearmiss-enum.mjs';

// A facts literal: gates hold when s200 < close < s5.
const F = (close, rsi2, s5, s200) => ({ close, rsi2, s5, s200 });

test('constants match the pre-registered values', () => {
  assert.equal(MIN_BARS, 210);
  assert.equal(FIRE_MAX, 5);
  assert.equal(NEAR_MISS_HI, 15);
  assert.equal(RESOLUTION_CAP, 10);
});

test('stateOf classifies FIRE / NEAR_MISS / OUT', () => {
  assert.equal(stateOf(null), 'OUT');
  assert.equal(stateOf(F(100, 3, 105, 90)), 'FIRE');       // gates hold, rsi<5
  assert.equal(stateOf(F(100, 9, 105, 90)), 'NEAR_MISS');  // gates hold, 5<=rsi<15
  assert.equal(stateOf(F(100, 20, 105, 90)), 'OUT');       // rsi>=15
  assert.equal(stateOf(F(100, 9, 95, 90)), 'OUT');         // close>s5 -> gate fails
  assert.equal(stateOf(F(100, 9, 105, 110)), 'OUT');       // close<s200 -> gate fails
});

test('resolveEpisode: a bar meeting all three fire conditions resolves as FIRE', () => {
  const facts = [F(100, 9, 105, 90), F(98, 3, 104, 90)];
  assert.deepEqual(resolveEpisode(facts, 0, { cap: 5 }), { outcome: 'FIRE', bars: 1 });
});

// The fire predicate is CONJUNCTIVE (rsi2<5 AND close<s5 AND close>s200). These two tests pin
// that down: a deep RSI alone must not convert an episode. Note FIRE-vs-BOUNCE ordering is
// vacuous — FIRE needs close<s5, BOUNCE needs close>s5 — so precedence is only meaningful
// between BOUNCE and REGIME_EXIT (tested below).
test('resolveEpisode: rsi2<5 but close ABOVE sma5 is a BOUNCE, not a FIRE', () => {
  const facts = [F(100, 9, 105, 90), F(106, 3, 104, 90)];
  assert.deepEqual(resolveEpisode(facts, 0, { cap: 5 }), { outcome: 'BOUNCE', bars: 1 });
});

test('resolveEpisode: rsi2<5 but close BELOW sma200 is a REGIME_EXIT, not a FIRE', () => {
  const facts = [F(100, 9, 105, 90), F(85, 3, 104, 90)];
  assert.deepEqual(resolveEpisode(facts, 0, { cap: 5 }), { outcome: 'REGIME_EXIT', bars: 1 });
});

test('resolveEpisode: close above SMA5 is a BOUNCE', () => {
  const facts = [F(100, 9, 105, 90), F(107, 60, 104, 90)];
  assert.deepEqual(resolveEpisode(facts, 0, { cap: 5 }), { outcome: 'BOUNCE', bars: 1 });
});

test('resolveEpisode: dropping below SMA200 while under SMA5 is a REGIME_EXIT', () => {
  const facts = [F(100, 9, 105, 90), F(85, 6, 104, 90)];
  assert.deepEqual(resolveEpisode(facts, 0, { cap: 5 }), { outcome: 'REGIME_EXIT', bars: 1 });
});

test('resolveEpisode: BOUNCE beats REGIME_EXIT when both could read true', () => {
  // close > s5 AND close < s200 is only possible if s5 < s200; bounce is checked first.
  const facts = [F(100, 9, 105, 90), F(96, 40, 95, 99)];
  assert.deepEqual(resolveEpisode(facts, 0, { cap: 5 }), { outcome: 'BOUNCE', bars: 1 });
});

test('resolveEpisode: UNRESOLVED at the cap', () => {
  // Bars that are neither fire, nor bounce, nor regime exit: rsi in band, close between.
  const hold = F(100, 9, 105, 90);
  const facts = [hold, hold, hold, hold];
  assert.deepEqual(resolveEpisode(facts, 0, { cap: 2 }), { outcome: 'UNRESOLVED', bars: 2 });
});

test('resolveEpisode: UNRESOLVED when the series ends first', () => {
  const facts = [F(100, 9, 105, 90), F(100, 9, 105, 90)];
  assert.deepEqual(resolveEpisode(facts, 0, { cap: 5 }), { outcome: 'UNRESOLVED', bars: 1 });
});

test('resolveEpisode: null facts (insufficient warmup) resolve UNRESOLVED', () => {
  const facts = [F(100, 9, 105, 90), null];
  assert.deepEqual(resolveEpisode(facts, 0, { cap: 5 }), { outcome: 'UNRESOLVED', bars: 1 });
});

test('resolveEpisode: no lookahead — truncating after the resolving bar is identical', () => {
  const facts = [F(100, 9, 105, 90), F(101, 12, 105, 90), F(98, 3, 104, 90), F(200, 99, 1, 1)];
  const full = resolveEpisode(facts, 0, { cap: 10 });
  const cut = resolveEpisode(facts.slice(0, 3), 0, { cap: 10 });
  assert.deepEqual(full, { outcome: 'FIRE', bars: 2 });
  assert.deepEqual(cut, full);
});

// --- enumerateEpisodes: fresh-signal dedup ---
// Bars carry {date, close}; facts are derived, so we drive it through real closes.
// A long uptrend then a sharp pullback puts the last bars in the near-miss/fire zone.
function upThenPullback(len = 240, drop = 0.6) {
  const closes = [];
  for (let i = 0; i < len - 8; i += 1) closes.push(100 + 0.2 * i);
  const peak = closes[closes.length - 1];
  for (let k = 1; k <= 8; k += 1) closes.push(peak - drop * k);
  return closes;
}
const barsOf = (closes) => closes.map((c, i) => ({ date: `d${String(i).padStart(4, '0')}`, close: c }));

test('barFacts returns null before MIN_BARS of warmup', () => {
  const closes = upThenPullback();
  assert.equal(barFacts(closes, MIN_BARS - 2), null);
  assert.notEqual(barFacts(closes, MIN_BARS - 1), null);
});

test('factsSeries length matches closes and early entries are null', () => {
  const closes = upThenPullback();
  const f = factsSeries(closes);
  assert.equal(f.length, closes.length);
  assert.equal(f[0], null);
});

test('enumerateEpisodes: consecutive in-band bars yield exactly one episode', () => {
  const bars = barsOf(upThenPullback());
  const eps = enumerateEpisodes(bars, { cap: RESOLUTION_CAP });
  const starts = eps.map(e => e.idx);
  assert.equal(new Set(starts).size, starts.length);       // no duplicate starts
  for (let i = 1; i < starts.length; i += 1) {
    assert.ok(starts[i] > starts[i - 1], 'starts strictly increase');
  }
  // Every episode starts on a NEAR_MISS bar whose predecessor was not in-band.
  const facts = factsSeries(bars.map(b => b.close));
  for (const e of eps) {
    assert.equal(stateOf(facts[e.idx]), 'NEAR_MISS');
    assert.ok(!['NEAR_MISS', 'FIRE'].includes(stateOf(facts[e.idx - 1])));
  }
});

test('enumerateEpisodes: records date, rsi2, outcome and resolveDate', () => {
  const bars = barsOf(upThenPullback());
  const eps = enumerateEpisodes(bars, { cap: RESOLUTION_CAP });
  assert.ok(eps.length >= 1, 'fixture must produce at least one episode');
  const e = eps[0];
  assert.equal(e.date, bars[e.idx].date);
  assert.ok(e.rsi2 >= FIRE_MAX && e.rsi2 < NEAR_MISS_HI);
  assert.ok(['FIRE', 'BOUNCE', 'REGIME_EXIT', 'UNRESOLVED'].includes(e.outcome));
  if (e.outcome !== 'UNRESOLVED') assert.equal(e.resolveDate, bars[e.idx + e.bars].date);
});
