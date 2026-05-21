import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentHarness } from './harness.js';

// Build a harness with an injectable current-phase and per-phase defaults so we
// can exercise _getHeartbeatSeconds() in isolation (the constructor has no side
// effects). getHeartbeatForPhase is called as (sandboxId, phase).
function makeHarness(phaseRef, defaults = { closed: 28800, pre_market: 900, market_open: 120 }) {
  return new AgentHarness({
    sandboxId: 'sbx_test',
    getCurrentPhaseFn: () => phaseRef.phase,
    getHeartbeatForPhase: (_sid, phase) => defaults[phase] ?? null,
  });
}

// On 2026-05-21 Prophet called set_heartbeat(3600) overnight thinking it was
// "extending to max interval," but 3600s is 8x SHORTER than the 28800s closed
// default — the override took priority and made it beat hourly all night. The
// override is meant to reflect the agent's read of the *current* phase, so it
// must auto-expire once the phase turns over.

test('override applies while still in the phase it was set in', () => {
  const phaseRef = { phase: 'closed' };
  const h = makeHarness(phaseRef);
  h.setHeartbeatOverride(3600, 'idle overnight');
  assert.equal(h._getHeartbeatSeconds(), 3600);
  // Still set after reading (oneTime defaults false).
  assert.equal(h.state.heartbeatOverride.seconds, 3600);
});

test('override auto-expires when the phase changes, reverting to phase default', () => {
  const phaseRef = { phase: 'closed' };
  const h = makeHarness(phaseRef);
  h.setHeartbeatOverride(3600, 'idle overnight');
  // Market rolls into pre-market: the overnight read no longer holds.
  phaseRef.phase = 'pre_market';
  assert.equal(h._getHeartbeatSeconds(), 900, 'should fall back to pre_market default');
  assert.equal(h.state.heartbeatOverride, null, 'stale override should be cleared');
});

test('setHeartbeatOverride records the phase it was set in', () => {
  const phaseRef = { phase: 'market_open' };
  const h = makeHarness(phaseRef);
  h.setHeartbeatOverride(60, 'scalping');
  assert.equal(h.state.heartbeatOverride.setInPhase, 'market_open');
  assert.equal(h.state.heartbeatOverride.oneTime, false);
});

test('oneTime override still clears after a single read (same phase)', () => {
  const phaseRef = { phase: 'market_open' };
  const h = makeHarness(phaseRef);
  h.state.heartbeatOverride = { seconds: 45, reason: 'one shot', oneTime: true, setInPhase: 'market_open' };
  assert.equal(h._getHeartbeatSeconds(), 45);
  assert.equal(h.state.heartbeatOverride, null);
});

test('legacy override without setInPhase persists across phases (back-compat)', () => {
  const phaseRef = { phase: 'closed' };
  const h = makeHarness(phaseRef);
  h.state.heartbeatOverride = { seconds: 1200, reason: 'legacy', oneTime: false };
  phaseRef.phase = 'pre_market';
  assert.equal(h._getHeartbeatSeconds(), 1200, 'no setInPhase => no auto-expire');
  assert.equal(h.state.heartbeatOverride.seconds, 1200);
});

test('clearHeartbeatOverride removes an active override', () => {
  const phaseRef = { phase: 'closed' };
  const h = makeHarness(phaseRef);
  h.setHeartbeatOverride(3600, 'idle');
  h.clearHeartbeatOverride();
  assert.equal(h.state.heartbeatOverride, null);
  assert.equal(h._getHeartbeatSeconds(), 28800, 'reverts to closed default after clear');
});

test('agent-level heartbeatOverrides config wins over PHASE_DEFAULTS when no runtime override', () => {
  const phaseRef = { phase: 'closed' };
  const h = makeHarness(phaseRef);
  h._agentConfig = { heartbeatOverrides: { closed: 14400 } };
  assert.equal(h._getHeartbeatSeconds(), 14400);
});
