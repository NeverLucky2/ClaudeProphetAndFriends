import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentHarness } from './harness.js';
import { secondsToNextPhaseBoundary, nextPhaseBoundary } from './harness.js';

// Boundaries are phase starts in ET minutes: 240(04:00) 570(09:30) 630(10:30) 900(15:00) 960(16:00).
// America/New_York is UTC-4 in May (EDT): 13:00Z = 09:00 ET. Use mid-May 2026 (no DST edge).

test('weekday before a later boundary returns seconds to that boundary', () => {
  // Thu 2026-05-21 13:00Z = 09:00 ET (540 min). Next boundary 09:30 (570) = 30 min.
  assert.equal(secondsToNextPhaseBoundary(new Date('2026-05-21T13:00:00Z')), 30 * 60);
});

test('weekday after the last boundary looks ahead to next day 04:00', () => {
  // Thu 2026-05-21 21:00Z = 17:00 ET, past the 16:00 last boundary.
  // Next boundary = Fri 04:00 ET: 7h to midnight + 4h = 11h.
  assert.equal(secondsToNextPhaseBoundary(new Date('2026-05-21T21:00:00Z')), 11 * 3600);
});

test('weekend looks ahead to Monday 04:00 (never returns null)', () => {
  // Sun 2026-05-17 23:00Z = 19:00 ET Sunday. Next boundary = Mon 2026-05-18 04:00 ET = 9h.
  // (Uses 05-17, not 05-24: the latter's Monday is 2026-05-25 Memorial Day, which the
  // holiday skip now rolls past — see the dedicated holiday cases in market-calendar.test.mjs.)
  assert.equal(secondsToNextPhaseBoundary(new Date('2026-05-17T23:00:00Z')), 9 * 3600);
});

test('exactly on a boundary skips it and returns seconds to the next one', () => {
  // Thu 2026-05-21 08:00Z = 04:00 ET exactly. The > 0 guard skips 04:00 and
  // returns the seconds to 09:30 = 5.5h.
  assert.equal(secondsToNextPhaseBoundary(new Date('2026-05-21T08:00:00Z')), 5.5 * 3600);
});

// nextPhaseBoundary returns both seconds and the phase the boundary enters.
// Reuses the same 8-day ET lookahead + weekend/holiday skip as secondsToNextPhaseBoundary.

test('nextPhaseBoundary: weekday before a later boundary returns {seconds, phase}', () => {
  // Thu 2026-05-21 13:00Z = 09:00 ET. Next boundary 09:30 = market_open. 30 min.
  const result = nextPhaseBoundary(new Date('2026-05-21T13:00:00Z'));
  assert.deepEqual(result, { seconds: 30 * 60, phase: 'market_open' });
});

test('nextPhaseBoundary: weekday after the last boundary looks ahead to next day pre_market', () => {
  // Thu 2026-05-21 21:00Z = 17:00 ET. Next boundary = Fri 04:00 = pre_market. 11h.
  const result = nextPhaseBoundary(new Date('2026-05-21T21:00:00Z'));
  assert.deepEqual(result, { seconds: 11 * 3600, phase: 'pre_market' });
});

test('nextPhaseBoundary: weekend looks ahead to Monday 04:00 pre_market', () => {
  // Sun 2026-05-17 23:00Z = 19:00 ET. Next boundary = Mon 04:00 ET = pre_market. 9h.
  const result = nextPhaseBoundary(new Date('2026-05-17T23:00:00Z'));
  assert.deepEqual(result, { seconds: 9 * 3600, phase: 'pre_market' });
});

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

// Trigger A: harness.start() surfaces broker-side fills that landed since the ET
// open. We test the unit (_emitFillsSummary) directly — it does the fetch +
// render + emit — rather than the full start() path, which needs heavy mocking.
function makeFillsHarness(goAxios, agentConfig = { strategyId: 'mean-rev-rsi2', name: 'Coil' }) {
  const h = new AgentHarness({
    sandboxId: 'sbx_test',
    getRuntime: () => ({ goAxios }),
  });
  h._agentConfig = agentConfig;
  return h;
}

test('_emitFillsSummary emits an agent_log line when there are fills', async () => {
  const goAxios = {
    get: async () => ({
      data: {
        strategy: 'mean-rev-rsi2', count: 1,
        fills: [{ symbol: 'AAPL', side: 'buy', qty: 12, avg_price: 184.2, filled_at: '2026-05-26T14:14:00Z' }],
      },
    }),
  };
  const h = makeFillsHarness(goAxios);
  const logs = [];
  h.state.on('agent_log', (d) => logs.push(d));

  await h._emitFillsSummary();

  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /^Coil — 1 fill today/);
  assert.match(logs[0].message, /AAPL/);
});

test('_emitFillsSummary stays silent on zero fills', async () => {
  const goAxios = { get: async () => ({ data: { strategy: 'mean-rev-rsi2', count: 0, fills: [] } }) };
  const h = makeFillsHarness(goAxios);
  const logs = [];
  h.state.on('agent_log', (d) => logs.push(d));

  await h._emitFillsSummary();

  assert.equal(logs.length, 0);
});

test('_emitFillsSummary soft-fails (no throw, no emit) when the fetch errors', async () => {
  const goAxios = { get: async () => { throw new Error('go down'); } };
  const h = makeFillsHarness(goAxios);
  const logs = [];
  h.state.on('agent_log', (d) => logs.push(d));

  await h._emitFillsSummary(); // must not reject
  assert.equal(logs.length, 0);
});

// _scheduleNext: suppressPhaseSnaps opts an agent out of the phase-boundary
// snap into the listed phases, letting the next wake fall on cadence (or a
// later scheduled time) instead.

test('_scheduleNext: suppressPhaseSnaps=["pre_market"] skips a pre_market boundary snap', () => {
  const phaseRef = { phase: 'closed' };
  const h = makeHarness(phaseRef, { closed: 28800, pre_market: 900 });
  h._agentConfig = { suppressPhaseSnaps: ['pre_market'] };
  h.state.running = true;
  // Mock helpers: next boundary is 60s away into pre_market (would normally clamp seconds=60)
  h._getNextPhaseBoundary = () => ({ seconds: 60, phase: 'pre_market' });
  let scheduled;
  h.state.on('schedule', (d) => { scheduled = d; });
  h._scheduleNext();
  clearTimeout(h._timer);
  // Without suppression, seconds would clamp to 60 (the boundary). With suppression
  // we fall through to phase-cadence (closed=28800).
  assert.equal(scheduled.seconds, 28800, 'pre_market boundary snap should be suppressed');
});

test('_scheduleNext: suppressPhaseSnaps=["pre_market"] does NOT suppress market_open boundary', () => {
  const phaseRef = { phase: 'pre_market' };
  const h = makeHarness(phaseRef, { closed: 28800, pre_market: 900, market_open: 120 });
  h._agentConfig = { suppressPhaseSnaps: ['pre_market'] };
  h.state.running = true;
  // Next boundary is 60s away into market_open (NOT in suppressPhaseSnaps list)
  h._getNextPhaseBoundary = () => ({ seconds: 60, phase: 'market_open' });
  let scheduled;
  h.state.on('schedule', (d) => { scheduled = d; });
  h._scheduleNext();
  clearTimeout(h._timer);
  // market_open boundary should still clamp seconds to 60
  assert.equal(scheduled.seconds, 60, 'market_open boundary should still snap');
});

// _scheduleNext: scheduledBeats with exclusive=false adds wakes on top of phase
// cadence, clamping next wake if a scheduled time arrives sooner. The pre-existing
// exclusive=true mode (Coil/Drift/Trend) replaces phases entirely and runs BEFORE
// this code path.

test('_scheduleNext: additive scheduledBeats clamps to scheduled time when sooner than cadence', () => {
  const phaseRef = { phase: 'pre_market' };
  const h = makeHarness(phaseRef, { pre_market: 86400 });
  h._agentConfig = {
    scheduledBeats: { times: ['09:15'], weekdaysOnly: true, exclusive: false },
  };
  h.state.running = true;
  // Mock helpers: no boundary in play (phase cadence dominates), scheduled wake 900s away
  h._getNextPhaseBoundary = () => null;
  h._getSecondsToNextScheduledBeat = () => 900;
  let scheduled;
  h.state.on('schedule', (d) => { scheduled = d; });
  h._scheduleNext();
  clearTimeout(h._timer);
  // Cadence=86400, scheduled=900, so scheduled wins
  assert.equal(scheduled.seconds, 900, 'additive scheduled wake should clamp the next beat');
});

test('_scheduleNext: additive scheduledBeats does not interfere when scheduled time is later than cadence', () => {
  const phaseRef = { phase: 'market_open' };
  const h = makeHarness(phaseRef, { market_open: 120 });
  h._agentConfig = {
    scheduledBeats: { times: ['09:15'], weekdaysOnly: true, exclusive: false },
  };
  h.state.running = true;
  h._getNextPhaseBoundary = () => null;
  h._getSecondsToNextScheduledBeat = () => 3600;  // Way later than 120s cadence
  let scheduled;
  h.state.on('schedule', (d) => { scheduled = d; });
  h._scheduleNext();
  clearTimeout(h._timer);
  // Cadence=120, scheduled=3600, so cadence wins
  assert.equal(scheduled.seconds, 120, 'phase cadence should win when scheduled time is later');
});

test('_scheduleNext: agent with no scheduledBeats falls through to phase cadence + boundary clamp as before', () => {
  const phaseRef = { phase: 'pre_market' };
  const h = makeHarness(phaseRef, { pre_market: 900 });
  h._agentConfig = {};  // No scheduledBeats, no suppressPhaseSnaps
  h.state.running = true;
  h._getNextPhaseBoundary = () => ({ seconds: 1800, phase: 'market_open' });
  // No _getSecondsToNextScheduledBeat mock — should not be called
  let getScheduledCalls = 0;
  h._getSecondsToNextScheduledBeat = () => { getScheduledCalls++; return null; };
  let scheduled;
  h.state.on('schedule', (d) => { scheduled = d; });
  h._scheduleNext();
  clearTimeout(h._timer);
  // Cadence=900, boundary=1800 → cadence wins (boundary > cadence)
  assert.equal(scheduled.seconds, 900, 'phase cadence wins when boundary is further out');
  assert.equal(getScheduledCalls, 0, 'additive scheduledBeats helper should not be called without config');
});

test('_scheduleNext: exclusive scheduledBeats still replaces phase cadence entirely (Coil-style)', () => {
  const phaseRef = { phase: 'closed' };
  const h = makeHarness(phaseRef, { closed: 28800 });
  h._agentConfig = {
    scheduledBeats: { times: ['15:45'], weekdaysOnly: true, exclusive: true, windowMinutes: 5 },
  };
  h.state.running = true;
  // The exclusive path uses _getSecondsToNextScheduledBeat directly and returns
  // BEFORE reaching the cadence/boundary logic. Mock it to a known value.
  h._getSecondsToNextScheduledBeat = () => 7200;  // 2h away
  let scheduled;
  h.state.on('schedule', (d) => { scheduled = d; });
  h._scheduleNext();
  clearTimeout(h._timer);
  // Exclusive mode: schedules at the scheduled time, ignoring phase cadence (28800)
  assert.equal(scheduled.seconds, 7200, 'exclusive scheduledBeats should drive the schedule');
});
