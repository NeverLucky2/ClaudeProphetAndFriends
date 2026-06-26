// Bounded in-memory ring of recent agent_log lines so the dashboard console can
// be backfilled after the SSE stream drops. The live broadcast path (server.js)
// is fire-and-forget: it discards every agent_log line whenever no client is
// connected (`if (sseClients.size === 0) return`). That is why the console goes
// blank when the monitor sleeps — the browser marks the page hidden, tears down
// /api/events (stopPolling → EventSource.close), and the lines emitted while the
// machine keeps trading are thrown away with no replay on reconnect.
//
// This buffer is the durable-for-a-window record those reconnects read from. Each
// agent_log frame is stamped with a monotonic id; the client tracks the highest
// id it has rendered and passes it back as `?since=` (and the browser also sends
// it as the Last-Event-ID header on a native auto-reconnect). /api/events replays
// `since(cursor)` to the fresh connection, filling the gap regardless of why the
// stream dropped — screen-off, sleep/wake, idle drop, or tab hide.
//
// Memory-bounded by count AND age. Ids are seeded from the wall clock so a
// process restart never issues an id below one a still-open client already holds
// (which would make the client mistake fresh lines for already-seen duplicates
// and silently drop them). Pure + injectable clock for unit testing, mirroring
// sse-keepalive.js / fills-summary.js. In-memory only by design: the full agent
// reasoning is already persisted durably in opencode's session DB — this buffer
// only needs to cover the short live-console gap across a disconnect, so a Node
// restart legitimately starts it empty.

// Format one buffered entry as an SSE frame. Both the live broadcast (server.js)
// and the reconnect backfill stamp frames through here so they can never disagree
// on the event type — the original bug was the backfill replaying every line as
// `event: agent_log`, which silently dropped the agent_text report on reconnect.
export function formatSseLogFrame({ id, event, data }) {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Buffer one console line and fan it out to the live clients, returning its id.
// Centralises the two obligations whose omission made agent_text a bug: (1) record
// the line for replay EVEN WHEN nobody is connected — that disconnected window is
// exactly what the buffer covers — and (2) stamp the live frame with the same
// id/event the reconnect backfill will use, via the shared formatSseLogFrame.
// Fire-and-forget write (dead clients are pruned by the req 'close' handler +
// keepalive), matching the original broadcast path in server.js.
export function broadcastBufferedLine(clients, logBuffer, event, data) {
  const id = logBuffer.push(data, event);
  if (clients && clients.size > 0) {
    const msg = formatSseLogFrame({ id, event, data });
    for (const client of clients) client.write(msg);
  }
  return id;
}

export function createLogBuffer({
  maxEntries = 1000,
  maxAgeMs = 30 * 60 * 1000,
  now = Date.now,
} = {}) {
  let nextId = Math.floor(now());
  let entries = []; // { id, t, data }, oldest → newest

  function prune() {
    const cutoff = now() - maxAgeMs;
    if (entries.length && entries[0].t < cutoff) {
      entries = entries.filter(e => e.t >= cutoff);
    }
    if (entries.length > maxEntries) {
      entries = entries.slice(entries.length - maxEntries);
    }
  }

  return {
    // Append a log payload, returning its assigned id. Caller stamps this id onto
    // the SSE frame (`id: <n>`) so the client can resume from it. `event` is the
    // SSE event type to replay the entry under — the console renders BOTH
    // agent_log (cost/heartbeat lines) and agent_text (the beat's report), so the
    // entry must remember which so a reconnect replays each under its own type.
    push(data, event = 'agent_log') {
      const id = nextId++;
      entries.push({ id, t: now(), event, data });
      prune();
      return id;
    },
    // Entries the client hasn't seen — id strictly greater than its cursor,
    // oldest → newest so replay preserves order. A stale/evicted cursor just
    // returns whatever survives in the window.
    since(lastId) {
      prune();
      const cursor = Number(lastId) || 0;
      return entries.filter(e => e.id > cursor);
    },
    get size() { return entries.length; },
    get lastId() { return entries.length ? entries[entries.length - 1].id : nextId - 1; },
  };
}
