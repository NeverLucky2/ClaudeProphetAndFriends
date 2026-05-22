// Pure classifier: decides which dashboard pane(s) an agent_log line renders into.
// Used by the browser (imported as an ES module) AND by node:test.
// Contract: a Go line is one the orchestrator tagged source:'go', or any line
// still carrying the legacy "[go:PORT]" prefix. Go errors mirror into the
// reasoning pane so a failure is impossible to miss; routine Go output does not.
// (Producer side stamps source:'go' via agent/go-log.js.)
export function classifyLogPanes({ source, message, level } = {}) {
  const isGo = source === 'go' || /^\[go:\d+\]/.test(String(message ?? ''));
  if (!isGo) return { main: true, go: false };
  return { main: level === 'error', go: true };
}
