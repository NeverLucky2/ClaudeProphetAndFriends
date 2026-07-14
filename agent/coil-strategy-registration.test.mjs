import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COIL_STRATEGY_IDS, COIL_PAPER_STRATEGY_ID, COIL_LIVE_STRATEGY_ID } from './coil-strategy-ids.js';
import { resolveAllowedTools, STRATEGY_TOOL_ALLOWLISTS } from './tool-allowlists.js';
import { PREFLIGHT_REGISTRY } from './preflight.js';
import { candidateWarmerFlags } from './candidate-warmer-flags.js';
import { STRATEGY_KIND } from './reasoning-digest.js';

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
}

test('live Coil gets the same toolset as paper Coil', () => {
  assert.deepEqual(
    resolveAllowedTools([], COIL_LIVE_STRATEGY_ID),
    resolveAllowedTools([], 'mean-rev-rsi2'),
    'live Coil must not have a broader toolset than paper Coil',
  );
});
