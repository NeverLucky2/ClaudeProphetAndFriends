import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBarsWithVolume, indexByDate } from './coil-eventstudy-bars.mjs';

test('parseBarsWithVolume keeps OHLCV and sorts ascending by ET date', () => {
  const obj = { bars: [
    { Timestamp: '2022-01-04T05:00:00Z', Open: 2, High: 3, Low: 1, Close: 2.5, Volume: 100 },
    { Timestamp: '2022-01-03T05:00:00Z', Open: 1, High: 2, Low: 0.5, Close: 1.5, Volume: 200 },
  ] };
  const bars = parseBarsWithVolume(obj);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].date, '2022-01-03');
  assert.deepEqual(
    { o: bars[0].open, h: bars[0].high, l: bars[0].low, c: bars[0].close, v: bars[0].volume },
    { o: 1, h: 2, l: 0.5, c: 1.5, v: 200 });
});

test('indexByDate maps date -> array index', () => {
  const bars = [{ date: '2022-01-03' }, { date: '2022-01-04' }];
  const idx = indexByDate(bars);
  assert.equal(idx.get('2022-01-04'), 1);
  assert.equal(idx.get('2022-01-05'), undefined);
});
