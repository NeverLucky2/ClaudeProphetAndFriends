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
export function coilLiveHaltFlags(
  strategyId,
  operatorEnabledValue,
  operatorOrphanAutoflattenValue,
  operatorOrphanDedicatedValue,
) {
  const isLive = strategyId === COIL_LIVE_STRATEGY_ID;
  const armed = isLive && operatorEnabledValue === 'true';
  return {
    ENABLE_COIL_LIVE_HALT: armed ? 'true' : 'false',
    // Orphan auto-flatten (2026-07-14 spec). Same per-bot scoping as the halt
    // above: only live Coil may receive a 'true'; every other bot is hard-
    // 'false' so it cannot inherit a shared-.env value and start auto-
    // flattening. The operator keeps the kill switch -- live Coil gets the
    // operator's own value (default 'false' if unset), never a forced 'true'.
    ENABLE_COIL_ORPHAN_AUTOFLATTEN: isLive ? (operatorOrphanAutoflattenValue || 'false') : 'false',
    ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED: isLive ? (operatorOrphanDedicatedValue || 'false') : 'false',
  };
}
