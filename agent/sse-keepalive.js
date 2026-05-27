// SSE keepalive. When the agent is quiet — the steady state after the regime /
// beat cost reductions — the /api/events stream carries no traffic, so the
// browser, OS, or an intermediary proxy eventually drops the idle connection.
// Each drop makes the dashboard reconnect (connectSSE in public/index.html), and
// every reconnect re-runs the /api/events handler, which re-fires the
// connect-time fills recap (emitConnectFillsSummaries in server.js) — that is the
// source of the duplicate "N fills today" log lines. A periodic comment frame
// keeps the socket warm so it never idles out.
//
// SSE comment frames (lines beginning with ":") are ignored by EventSource, so
// they reach no client-side event handler — pure connection hygiene. Split out
// from server.js (which boots a live server on import) so the write+prune logic
// is unit-testable without spinning up the server, mirroring fills-summary.js.

// Cadence. Browsers/proxies typically drop idle connections at 30–120s; staying
// under that keeps the stream alive, and a 20s comment is far below any
// perceptible cost. Override via env (the tests use a short interval).
export const SSE_KEEPALIVE_MS = Number(process.env.SSE_KEEPALIVE_MS) || 20_000;

// A valid SSE comment frame: a line starting with ":" plus the blank-line
// terminator. EventSource silently discards it.
export const KEEPALIVE_FRAME = ': keepalive\n\n';

// Write the keepalive frame to every connected client, pruning any whose socket
// has gone away (a write throws on a destroyed stream). Mutates `clients` so the
// caller's Set stays clean — defense in depth alongside the req 'close' handler,
// which may not fire promptly on a half-open socket. Returns the count of live
// clients written to.
export function sendSseKeepalive(clients) {
  if (!clients || clients.size === 0) return 0;
  let written = 0;
  for (const client of clients) {
    try {
      client.write(KEEPALIVE_FRAME);
      written++;
    } catch {
      clients.delete(client);
    }
  }
  return written;
}
