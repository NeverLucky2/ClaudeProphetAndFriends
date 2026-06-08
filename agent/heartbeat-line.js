// One-line "heartbeat processed" confirmation for an agent's dashboard console pane.
// Pure formatter — the wiring (harness agent_log emit for Node agents; Go scheduler log line
// for Go-scheduled agents) calls this and routes the string through the existing console plumbing.
// Printed only on a PROCESSED beat (skipped/preflight beats already emit their own line).
export function formatHeartbeatLine({ agent, phase, etTime, toolCalls = 0, trades = 0 } = {}) {
  const who = agent ? `${agent} ` : '';
  const tc = `${toolCalls} tool call${toolCalls === 1 ? '' : 's'}`;
  const tr = `${trades} trade${trades === 1 ? '' : 's'}`;
  const ctx = [phase, etTime ? `${etTime} ET` : null].filter(Boolean).join(' ');
  const suffix = ctx ? ` · ${ctx}` : '';
  return `${who}✓ heartbeat processed — ${tc}, ${tr}${suffix}`;
}
