// scripts/overlay-curve.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCurveFrom } from './overlay-curve.mjs';
test('loadCurveFrom returns [] when cache missing', () => { assert.deepEqual(loadCurveFrom('/no/such/root'), []); });
