// Build an agent_log payload tagged as Go-backend output so the dashboard routes
// it to the per-agent Go console (and mirrors it into reasoning when level==='error').
// Single source of truth for the Go-log event shape — every orchestrator emit for
// the Go backend goes through here so the source tag can never be forgotten.
// The consumer side is agent/public/log-source.js (classifyLogPanes).
export function goLog(sandboxId, level, message) {
  return { sandboxId, level, message, source: 'go' };
}
