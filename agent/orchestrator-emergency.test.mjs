import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentOrchestrator } from './orchestrator.js';

// Build a fake runtime whose harness records when emergencyWake fires.
function fakeRuntime(sandboxId, woken, { running = true, paused = false } = {}) {
  return {
    sandboxId,
    harness: {
      state: { running, paused },
      emergencyWake: () => woken.push(sandboxId),
    },
  };
}

// On 2026-05-21 the mid-session scanner woke every running agent on a quantum-
// computing alert. Coil (mean-rev) and Harvest have no provision to act on
// intraday news, so they burned a full beat to conclude "not relevant." Only
// agents whose definition opts in (respondsToEmergencyWakes !== false) should
// be woken.

test('skips agents flagged respondsToEmergencyWakes:false, wakes the rest', () => {
  const woken = [];
  const orch = new AgentOrchestrator();
  orch.runtimes.set('s_prophet', fakeRuntime('s_prophet', woken));
  orch.runtimes.set('s_harvest', fakeRuntime('s_harvest', woken));
  orch.runtimes.set('s_coil', fakeRuntime('s_coil', woken));

  const resolve = (sid) => ({
    s_prophet: { id: 'default' },                                  // no flag => reactive
    s_harvest: { id: 'harvest', respondsToEmergencyWakes: false }, // exempt
    s_coil: { id: 'mean-rev', respondsToEmergencyWakes: false },   // exempt
  }[sid]);

  orch.triggerEmergencyHeartbeat('quantum stocks surging', resolve);
  assert.deepEqual(woken, ['s_prophet']);
});

test('an agent without the flag defaults to reactive (woken)', () => {
  const woken = [];
  const orch = new AgentOrchestrator();
  orch.runtimes.set('s1', fakeRuntime('s1', woken));
  orch.triggerEmergencyHeartbeat('news', () => ({ id: 'default' }));
  assert.deepEqual(woken, ['s1']);
});

test('respondsToEmergencyWakes:true is honored, not skipped', () => {
  const woken = [];
  const orch = new AgentOrchestrator();
  orch.runtimes.set('s', fakeRuntime('s', woken));
  orch.triggerEmergencyHeartbeat('news', () => ({ id: 'harvest', respondsToEmergencyWakes: true }));
  assert.deepEqual(woken, ['s']);
});

test('stopped and paused harnesses are never woken', () => {
  const woken = [];
  const orch = new AgentOrchestrator();
  orch.runtimes.set('stopped', fakeRuntime('stopped', woken, { running: false }));
  orch.runtimes.set('paused', fakeRuntime('paused', woken, { paused: true }));
  orch.runtimes.set('live', fakeRuntime('live', woken));
  orch.triggerEmergencyHeartbeat('news', () => ({ id: 'default' }));
  assert.deepEqual(woken, ['live']);
});
