import { COIL_LIVE_STRATEGY_ID } from './coil-strategy-ids.js';

// Coil-live drawdown-halt gating (services/coil_live_halt_guard.go), the
// only code-enforced rail bounding real-money loss on the live Coil account.
// Only the live-Coil bot may receive the operator's ENABLE_COIL_LIVE_HALT
// value; every other strategy gets an explicit 'false' so it can't inherit a
// shared-.env 'true' and arm a drawdown halt keyed to a baseline/state dir
// meant for a different account (same reasoning as candidateWarmerFlags /
// the turtle + defensive-Prophet flags in orchestrator.js). The operator's
// value is passed through unchanged for live Coil rather than hardcoded to
// 'true' -- this keeps the operator's kill switch (leaving the flag unset)
// intact.
export function coilLiveHaltFlags(strategyId, operatorEnabledValue) {
  const armed = strategyId === COIL_LIVE_STRATEGY_ID && operatorEnabledValue === 'true';
  return {
    ENABLE_COIL_LIVE_HALT: armed ? 'true' : 'false',
  };
}
