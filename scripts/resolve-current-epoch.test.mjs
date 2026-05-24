// scripts/resolve-current-epoch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCurrentEpoch } from './resolve-current-epoch.mjs';

test('marker wins over config (post-mutation: config edited after stamping)', () => {
  // Trades were stamped X; marker says X; config was since edited to imply Y.
  const r = resolveCurrentEpoch({ markers: [{ strategyVersion: 'X' }], newestStampedVersion: 'X', configVersion: 'Y' });
  assert.deepEqual(r.currentVersions, ['X']);          // NOT reclassified to Y
  assert.equal(r.source, 'marker');
  assert.match(r.consistencyWarning, /un-deployed|Config implies/i);
});

test('no marker -> newest stamped trade', () => {
  const r = resolveCurrentEpoch({ markers: [], newestStampedVersion: 'Z', configVersion: 'Y' });
  assert.deepEqual(r.currentVersions, ['Z']);
  assert.equal(r.source, 'newest-trade');
  assert.equal(r.consistencyWarning, null);
});

test('no marker, no stamps -> config recompute (inferred)', () => {
  const r = resolveCurrentEpoch({ markers: [], newestStampedVersion: null, configVersion: 'Y' });
  assert.deepEqual(r.currentVersions, ['Y']);
  assert.equal(r.source, 'config-inferred');
});

test('multiple divergent markers -> all current, divergent flag', () => {
  const r = resolveCurrentEpoch({ markers: [{ strategyVersion: 'X' }, { strategyVersion: 'W' }], configVersion: 'X' });
  assert.deepEqual(r.currentVersions.sort(), ['W', 'X']);
  assert.equal(r.divergent, true);
  assert.equal(r.source, 'marker');
  assert.equal(r.consistencyWarning, null);
});

test('nothing resolvable -> empty + source none', () => {
  const r = resolveCurrentEpoch({ markers: [], newestStampedVersion: null, configVersion: null });
  assert.deepEqual(r.currentVersions, []);
  assert.equal(r.source, 'none');
});

test('markers with all-null strategyVersion fall through to newest-stamped', () => {
  const r = resolveCurrentEpoch({ markers: [{ strategyVersion: null }, {}], newestStampedVersion: 'Z', configVersion: 'Y' });
  assert.equal(r.source, 'newest-trade');
  assert.deepEqual(r.currentVersions, ['Z']);
});
