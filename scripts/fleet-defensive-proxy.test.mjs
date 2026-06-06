import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma200, triggered, putSpreadValue, simulateDefensiveProxy } from './fleet-defensive-proxy.mjs';
import { bsPrice } from './coil-opt-bsm.mjs';

test('triggered when close < 200-day SMA', () => {
  const flat = Array.from({ length: 250 }, () => 100);
  assert.equal(triggered([...flat.slice(0, 249), 90]), true);
  assert.equal(triggered([...flat.slice(0, 249), 110]), false);
});
test('putSpreadValue = long higher-strike put − short lower-strike put (debit, >=0)', () => {
  const S = 100, Klong = 95, Kshort = 85, T = 30 / 365, r = 0.04, sig = 0.2;
  const v = putSpreadValue(S, Klong, Kshort, T, r, sig);
  assert.ok(Math.abs(v - (bsPrice('put', S, Klong, T, r, sig) - bsPrice('put', S, Kshort, T, r, sig))) < 1e-12);
  assert.ok(v >= 0);
});
test('spread gains as the underlying falls (structural convexity sanity)', () => {
  const args = [95, 85, 30 / 365, 0.04, 0.3];
  assert.ok(putSpreadValue(90, ...args) > putSpreadValue(100, ...args));
});

// >=250 bars: a rising untriggered stretch (above 200DMA) then a crash below the 200DMA.
function makeQqqCrashThen200() {
  const dates = [];
  const d = new Date('2016-01-04T12:00:00Z');
  for (let i = 0; i < 260; i += 1) { dates.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  const bars = [];
  for (let i = 0; i < 220; i += 1) { const c = 100 + 0.2 * i; bars.push({ date: dates[i], close: c }); }
  const base = bars[219].close;
  for (let i = 220; i < 260; i += 1) bars.push({ date: dates[i], close: base * 0.7 }); // crash well below the 200DMA
  return bars;
}

test('simulateDefensiveProxy: flat (ret 0, inactive) while untriggered; nonzero marks while a spread is on', () => {
  const series = simulateDefensiveProxy(makeQqqCrashThen200(), { start: '2016-01-01', end: '2026-06-06' });
  assert.ok(series.every(p => typeof p.ret === 'number' && typeof p.active === 'boolean'));
  assert.ok(series.some(p => p.active === true));               // entered a hedge during the crash
  assert.ok(series.some(p => p.active === false && p.ret === 0)); // flat while untriggered
});
