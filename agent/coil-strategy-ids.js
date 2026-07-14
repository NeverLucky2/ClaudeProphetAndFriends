// The strategy ids Coil trades under. A strategy id is a lookup key in seven
// separate registries (guard agent attribution, MCP tool allowlist, beat
// preflight, candidate-cache warmer, reasoning digest, trade-grades measurement,
// graduation-report measurement) and THREE OF THEM FAIL OPEN -- most
// dangerously resolveAllowedTools, where an unknown id yields [] which means
// "no filter, all tools allowed". The two measurement registries don't fail
// open the same way, but they fail SILENT: an unregistered id there doesn't
// unlock anything, it just makes that id's trades invisible to grading and
// graduation -- just as dangerous for an experiment that must be "graded from
// trade one."
//
// Import this list rather than hardcoding an id, so adding a Coil variant can
// never silently unregister it. Two tests enforce every id here resolves in
// every registry: agent/coil-strategy-registration.test.mjs covers the six
// Node-side registries (tool allowlist, preflight, candidate warmer,
// reasoning-digest STRATEGY_KIND, scripts/trade-grades.mjs AGENTS,
// scripts/graduation-report.mjs AGENTS); services/trade_guard_test.go covers
// the seventh, Go-side AgentForStrategy registry.
export const COIL_PAPER_STRATEGY_ID = 'mean-rev-rsi2';
export const COIL_LIVE_STRATEGY_ID = 'mean-rev-rsi2-live';
export const COIL_STRATEGY_IDS = [COIL_PAPER_STRATEGY_ID, COIL_LIVE_STRATEGY_ID];
