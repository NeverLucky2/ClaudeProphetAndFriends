// The strategy ids Coil trades under. A strategy id is a lookup key in five
// separate registries (guard agent attribution, MCP tool allowlist, beat
// preflight, candidate-cache warmer, reasoning digest) and THREE OF THEM FAIL
// OPEN -- most dangerously resolveAllowedTools, where an unknown id yields []
// which means "no filter, all tools allowed".
//
// Import this list rather than hardcoding an id, so adding a Coil variant can
// never silently unregister it. agent/coil-strategy-registration.test.mjs
// enforces that every id here resolves in every registry.
export const COIL_PAPER_STRATEGY_ID = 'mean-rev-rsi2';
export const COIL_LIVE_STRATEGY_ID = 'mean-rev-rsi2-live';
export const COIL_STRATEGY_IDS = [COIL_PAPER_STRATEGY_ID, COIL_LIVE_STRATEGY_ID];
