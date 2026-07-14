import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COIL_STRATEGY_IDS, COIL_PAPER_STRATEGY_ID, COIL_LIVE_STRATEGY_ID } from './coil-strategy-ids.js';
import { resolveAllowedTools, STRATEGY_TOOL_ALLOWLISTS } from './tool-allowlists.js';
import { PREFLIGHT_REGISTRY } from './preflight.js';
import { candidateWarmerFlags } from './candidate-warmer-flags.js';
import { STRATEGY_KIND } from './reasoning-digest.js';
import { AGENTS as TRADE_GRADES_AGENTS } from '../scripts/trade-grades.mjs';
import { AGENTS as GRADUATION_REPORT_AGENTS } from '../scripts/graduation-report.mjs';

// Guard against silent vacuous-pass: if COIL_STRATEGY_IDS were ever emptied
// (or had an id renamed away), the `for` loop below would register ZERO
// sub-tests and this whole suite would go green having checked nothing. A
// conformance test that can pass vacuously is worse than none, so assert the
// two known ids are present before anything else runs.
test('COIL_STRATEGY_IDS contains at least the known paper and live ids', () => {
  assert.ok(COIL_STRATEGY_IDS.includes(COIL_PAPER_STRATEGY_ID), 'missing paper id mean-rev-rsi2');
  assert.ok(COIL_STRATEGY_IDS.includes(COIL_LIVE_STRATEGY_ID), 'missing live id mean-rev-rsi2-live');
  assert.ok(COIL_STRATEGY_IDS.length >= 2, 'COIL_STRATEGY_IDS unexpectedly small — loop below may under-cover');
});

// An unregistered strategy id does not fail loudly -- it fails OPEN. Left
// unregistered, live Coil would receive the FULL MCP toolset (resolveAllowedTools
// returns [], and [] means "no filter"). Every Coil id must resolve everywhere.
for (const id of COIL_STRATEGY_IDS) {
  test(`${id}: has a non-empty tool allowlist`, () => {
    const tools = resolveAllowedTools([], id);
    assert.ok(tools.length > 0, `${id} resolved to an EMPTY allowlist, which means NO FILTER (all tools allowed)`);
    assert.ok(STRATEGY_TOOL_ALLOWLISTS[id], `${id} missing from STRATEGY_TOOL_ALLOWLISTS`);
  });

  test(`${id}: has a registered preflight predicate`, () => {
    assert.equal(typeof PREFLIGHT_REGISTRY[id], 'function', `${id} has no preflight registered`);
  });

  test(`${id}: enables the meanrev candidate warmer`, () => {
    assert.equal(candidateWarmerFlags(id).ENABLE_MEANREV_WARMER, 'true');
    assert.equal(candidateWarmerFlags(id).ENABLE_DRIFT_WARMER, 'false');
  });

  test(`${id}: maps to 'coil' in the reasoning-digest STRATEGY_KIND registry`, () => {
    assert.equal(STRATEGY_KIND[id], 'coil', `${id} missing or wrong kind in reasoning-digest.js STRATEGY_KIND`);
  });

  // These two are the MEASUREMENT registries, not runtime ones — an id missing here
  // doesn't unlock extra tools, it silently makes that id's trades invisible to
  // grading/graduation. For a funded live account this is just as dangerous as a
  // fail-open runtime registry: a real-money experiment that grades as zero trades.
  test(`${id}: resolves in scripts/trade-grades.mjs's Coil AGENTS entry`, () => {
    const coil = TRADE_GRADES_AGENTS.find((a) => a.agentName === 'Coil');
    assert.ok(coil, "trade-grades.mjs AGENTS has no 'Coil' entry at all");
    assert.ok(
      Array.isArray(coil.strategyIds) && coil.strategyIds.includes(id),
      `${id} missing from trade-grades.mjs's Coil strategyIds — its closed trades would never be graded`,
    );
  });

  test(`${id}: resolves in scripts/graduation-report.mjs's Coil AGENTS entry`, () => {
    const coil = GRADUATION_REPORT_AGENTS.find((a) => a.name === 'Coil');
    assert.ok(coil, "graduation-report.mjs AGENTS has no 'Coil' entry at all");
    const ids = Array.isArray(coil.strategyId) ? coil.strategyId : [coil.strategyId];
    assert.ok(
      ids.includes(id),
      `${id} missing from graduation-report.mjs's Coil strategyId(s) — it would never graduate`,
    );
  });
}

test('live Coil gets the same toolset as paper Coil', () => {
  assert.deepEqual(
    resolveAllowedTools([], COIL_LIVE_STRATEGY_ID),
    resolveAllowedTools([], 'mean-rev-rsi2'),
    'live Coil must not have a broader toolset than paper Coil',
  );
});
