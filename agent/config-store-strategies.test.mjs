import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { _internals } from './config-store.js';
import { COIL_LIVE_STRATEGY_ID } from './coil-strategy-ids.js';

const strategies = _internals.defaultStrategies();
const byId = Object.fromEntries(strategies.map(s => [s.id, s]));

test('the live Coil strategy is registered', () => {
  const live = byId[COIL_LIVE_STRATEGY_ID];
  assert.ok(live, `${COIL_LIVE_STRATEGY_ID} is not in defaultStrategies()`);
  assert.equal(live.rulesFile, 'TRADING_RULES_MEANREV_LIVE.md');
});

test('the live rules file exists on disk', () => {
  assert.ok(existsSync('TRADING_RULES_MEANREV_LIVE.md'), 'live rules file is missing');
});

test('the live rules carry the live sizing params, not the paper ones', () => {
  const rules = readFileSync('TRADING_RULES_MEANREV_LIVE.md', 'utf8');
  assert.match(rules, /0\.12/, 'live rules must size at 12% per position');
  assert.match(rules, /Maximum 7 open/i, 'live rules must cap concurrency at 7');
  assert.match(rules, /halt/i, 'live rules must specify bear mode halt');
});

// The live file was forked from the paper file, and only 4 of the 8 places
// that state the position cap / per-position size were updated the first
// time around — the other 7 kept saying "14 positions" / "6%" while Risk
// Management said "max 7" / "12%". This is prose an LLM follows to place
// real-money orders, so any regression here is a live-account sizing bug,
// not a typo. Assert no paper-era literal survives anywhere in the file.
test('the live rules file contains no stale paper-era literals', () => {
  const rules = readFileSync('TRADING_RULES_MEANREV_LIVE.md', 'utf8');
  const staleParamPatterns = [
    // Bare "14" has no legitimate meaning anywhere in the live file — the
    // live position cap is 7. (Note: "6% per position" alone is NOT a safe
    // pattern here — the bear-mode table legitimately describes halfsize as
    // "6% per position", i.e. half of the live 12%.)
    /\b14\b/,
    /0\.06/, // paper's 6% sizing fraction (live sizes at 0.12)
    /6% hard cap/i, // paper's per-position hard-cap phrasing (live is 12%)
  ];
  for (const pattern of staleParamPatterns) {
    assert.doesNotMatch(
      rules,
      pattern,
      `live rules file contains a stale paper-era literal matching ${pattern}`
    );
  }
});

// The paper description claimed "5% per position; max 5 concurrent" while the
// rules file said 6% and 14. Do not let the live variant inherit a stale claim.
test('paper Coil description matches its rules file', () => {
  assert.match(byId['mean-rev-rsi2'].description, /6% per position/);
  assert.match(byId['mean-rev-rsi2'].description, /max 14 concurrent/);
});

test('live Coil description matches its rules file', () => {
  assert.match(byId[COIL_LIVE_STRATEGY_ID].description, /12% per position/);
  assert.match(byId[COIL_LIVE_STRATEGY_ID].description, /max 7 concurrent/);
});

test('paper Coil rules are untouched', () => {
  assert.equal(byId['mean-rev-rsi2'].rulesFile, 'TRADING_RULES_MEANREV.md');
});
