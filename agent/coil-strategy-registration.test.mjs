import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COIL_STRATEGY_IDS, COIL_LIVE_STRATEGY_ID } from './coil-strategy-ids.js';
import { resolveAllowedTools, STRATEGY_TOOL_ALLOWLISTS } from './tool-allowlists.js';
import { PREFLIGHT_REGISTRY } from './preflight.js';
import { candidateWarmerFlags } from './candidate-warmer-flags.js';

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
}

test('live Coil gets the same toolset as paper Coil', () => {
  assert.deepEqual(
    resolveAllowedTools([], COIL_LIVE_STRATEGY_ID),
    resolveAllowedTools([], 'mean-rev-rsi2'),
    'live Coil must not have a broader toolset than paper Coil',
  );
});
