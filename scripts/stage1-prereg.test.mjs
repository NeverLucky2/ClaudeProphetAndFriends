// scripts/stage1-prereg.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256short, buildPreregArtifact, verifyPrereg } from './stage1-prereg.mjs';

const inputs = {
  universeText: 'AAPL\nMSFT\nNVDA\n',
  frictionText: '{"version":"2026-05-17.1"}',
  splitDate: '2026-03-15',
};

test('sha256short is stable 8-hex', () => {
  const h = sha256short('hello');
  assert.match(h, /^[0-9a-f]{8}$/);
  assert.equal(h, sha256short('hello'));
});

test('buildPreregArtifact freezes thresholds + required n=235 at the 0.55/0.63 floor', () => {
  const a = buildPreregArtifact(inputs);
  assert.equal(a.horizon_sessions, 3);
  assert.equal(a.null.HR0_floor, 0.55);
  assert.equal(a.power.required_independent_n_per_split, 235);
  assert.equal(a.variants.k, 1);
  assert.equal(a.split.split_date, '2026-03-15');
  assert.match(a.artifact_hash, /^[0-9a-f]{8}$/);
});

test('verifyPrereg passes on untouched artifact, fails on tamper', () => {
  const a = buildPreregArtifact(inputs);
  assert.equal(verifyPrereg(a).ok, true);
  const tampered = { ...a, power: { ...a.power, required_independent_n_per_split: 10 } };
  assert.equal(verifyPrereg(tampered).ok, false);
});
