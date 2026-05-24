// scripts/strategy-version.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStrategyVersion } from './strategy-version.mjs';

test('computeStrategyVersion: stable for identical text', () => {
  assert.equal(computeStrategyVersion('rule A\nrule B'), computeStrategyVersion('rule A\nrule B'));
});

test('computeStrategyVersion: differs on substantive change', () => {
  assert.notEqual(computeStrategyVersion('rule A'), computeStrategyVersion('rule B'));
});

test('computeStrategyVersion: CRLF and trailing whitespace do not flip', () => {
  assert.equal(computeStrategyVersion('rule A\nrule B'), computeStrategyVersion('rule A  \r\nrule B\t'));
});

test('computeStrategyVersion: empty / whitespace / null -> null', () => {
  assert.equal(computeStrategyVersion(''), null);
  assert.equal(computeStrategyVersion('   \n  '), null);
  assert.equal(computeStrategyVersion(null), null);
});

test('computeStrategyVersion: 12 hex chars when non-null', () => {
  assert.match(computeStrategyVersion('anything'), /^[0-9a-f]{12}$/);
});

import { resolveStrategyRules } from './strategy-version.mjs';

const noFiles = { readFile: async () => { throw new Error('ENOENT'); } };

test('resolveStrategyRules: agent.customStrategyRules wins', async () => {
  const rules = await resolveStrategyRules({ customStrategyRules: 'inline rules' }, { customRules: 'strat rules' }, noFiles);
  assert.equal(rules, 'inline rules');
});

test('resolveStrategyRules: strategy.rulesFile read via injected readFile', async () => {
  const readFile = async (p) => { assert.match(String(p), /MY_RULES\.md$/); return 'file rules'; };
  const rules = await resolveStrategyRules({ strategyId: 's1' }, { rulesFile: 'MY_RULES.md' }, { readFile });
  assert.equal(rules, 'file rules');
});

test('resolveStrategyRules: strategy.customRules when no rulesFile', async () => {
  const rules = await resolveStrategyRules({ strategyId: 's1' }, { customRules: 'strat rules' }, noFiles);
  assert.equal(rules, 'strat rules');
});

test('resolveStrategyRules: falls back to TRADING_RULES.md', async () => {
  const readFile = async (p) => { assert.match(String(p), /TRADING_RULES\.md$/); return 'fallback rules'; };
  const rules = await resolveStrategyRules({}, null, { readFile });
  assert.equal(rules, 'fallback rules');
});

test('resolveStrategyRules: empty string when nothing resolvable', async () => {
  const rules = await resolveStrategyRules({}, null, noFiles);
  assert.equal(rules, '');
});

test('resolveStrategyRules: falls through to TRADING_RULES.md when rulesFile read fails', async () => {
  const readFile = async (p) => {
    if (String(p).endsWith('MY_RULES.md')) throw new Error('ENOENT');
    assert.match(String(p), /TRADING_RULES\.md$/);
    return 'global rules';
  };
  const rules = await resolveStrategyRules({}, { rulesFile: 'MY_RULES.md' }, { readFile, onReadFileError: () => {} });
  assert.equal(rules, 'global rules');
});

import { buildVersionMarker, writeVersionMarker } from './strategy-version.mjs';

test('buildVersionMarker: shape with id, version, startedAt', () => {
  const m = buildVersionMarker({ strategyId: 'v2-options' }, 'a3f9c1d8e2b4', new Date('2026-05-23T00:00:00Z'));
  assert.deepEqual(m, { strategyId: 'v2-options', strategyVersion: 'a3f9c1d8e2b4', startedAt: '2026-05-23T00:00:00.000Z' });
});

test('buildVersionMarker: null id and version when absent', () => {
  const m = buildVersionMarker({}, null, new Date('2026-05-23T00:00:00Z'));
  assert.equal(m.strategyId, null);
  assert.equal(m.strategyVersion, null);
});

test('writeVersionMarker: mkdir + write to correct path with injected fs', async () => {
  const calls = {};
  const mkdir = async (d, o) => { calls.mkdir = { d, o }; };
  const writeFile = async (f, c) => { calls.writeFile = { f, c }; };
  const marker = { strategyId: 'x', strategyVersion: 'y', startedAt: 'z' };
  const file = await writeVersionMarker('6e4f26af', marker, { mkdir, writeFile, cwd: '/repo' });
  assert.match(file.replace(/\\/g, '/'), /\/repo\/data\/sandboxes\/6e4f26af\/\.current_strategy_version\.json$/);
  assert.deepEqual(calls.mkdir.o, { recursive: true });
  assert.equal(JSON.parse(calls.writeFile.c).strategyVersion, 'y');
  assert.ok(calls.writeFile.f.startsWith(calls.mkdir.d), 'writeFile path should be inside mkdir dir');
});
