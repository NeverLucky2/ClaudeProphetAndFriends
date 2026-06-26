// Unit tests for the SSE log replay buffer (agent/log-buffer.js). The buffer is
// the durable-for-a-window record of agent_log lines that /api/events replays to
// a reconnecting dashboard so the console has no gap after the SSE stream drops
// (screen-off, sleep/wake, idle drop, tab hide). Pure + injectable clock, like
// sse-keepalive.js / fills-summary.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogBuffer, formatSseLogFrame, broadcastBufferedLine } from './log-buffer.js';

test('push assigns strictly increasing ids and returns them', () => {
  const buf = createLogBuffer();
  const id1 = buf.push({ message: 'a' });
  const id2 = buf.push({ message: 'b' });
  assert.ok(id2 > id1, `expected ${id2} > ${id1}`);
});

test('since(id) returns only entries newer than id, oldest→newest', () => {
  const buf = createLogBuffer();
  const id1 = buf.push({ message: 'a' });
  const id2 = buf.push({ message: 'b' });
  const id3 = buf.push({ message: 'c' });
  const missed = buf.since(id1);
  assert.deepEqual(missed.map(e => e.data.message), ['b', 'c']);
  assert.deepEqual(missed.map(e => e.id), [id2, id3]);
});

test('since(0) replays the whole buffer (fresh client / no cursor)', () => {
  const buf = createLogBuffer();
  buf.push({ message: 'a' });
  buf.push({ message: 'b' });
  assert.deepEqual(buf.since(0).map(e => e.data.message), ['a', 'b']);
});

test('since(lastId) returns [] when the caller is already current', () => {
  const buf = createLogBuffer();
  buf.push({ message: 'a' });
  const id2 = buf.push({ message: 'b' });
  assert.deepEqual(buf.since(id2), []);
});

test('caps the buffer at maxEntries, dropping the oldest', () => {
  const buf = createLogBuffer({ maxEntries: 3 });
  const ids = [];
  for (const m of ['a', 'b', 'c', 'd', 'e']) ids.push(buf.push({ message: m }));
  assert.deepEqual(buf.since(0).map(e => e.data.message), ['c', 'd', 'e']);
  // A cursor pointing at an already-evicted id replays whatever survives — no crash.
  assert.deepEqual(buf.since(ids[0]).map(e => e.data.message), ['c', 'd', 'e']);
});

test('prunes entries older than maxAgeMs using the injected clock', () => {
  let t = 1_000_000;
  const buf = createLogBuffer({ maxAgeMs: 1000, now: () => t });
  buf.push({ message: 'old' });
  t += 2000; // advance past maxAge
  buf.push({ message: 'fresh' });
  assert.deepEqual(buf.since(0).map(e => e.data.message), ['fresh']);
});

test('seeds ids from the clock so a restart never issues an id below a prior run', () => {
  // A still-open client holds the highest id it saw. If a restarted server began
  // numbering from 0 again, the client would mistake fresh low-id lines for
  // already-seen duplicates and silently drop them. Seeding from the wall clock
  // keeps ids monotonic across process restarts.
  const earlyId = createLogBuffer({ now: () => 1_000 }).push({ message: 'y' });
  const lateId = createLogBuffer({ now: () => 2_000 }).push({ message: 'x' });
  assert.ok(lateId > earlyId, `restarted buffer id ${lateId} should exceed prior ${earlyId}`);
});

test('push records the event type, defaulting to agent_log', () => {
  const buf = createLogBuffer();
  buf.push({ message: 'a' });                  // default — the existing callers
  buf.push({ text: 'report' }, 'agent_text');  // explicit
  assert.deepEqual(buf.since(0).map(e => e.event), ['agent_log', 'agent_text']);
});

test('since() replays each entry under its own event type — agent_text survives a reconnect', () => {
  // Regression: the dashboard console renders BOTH agent_log (the cost/heartbeat
  // lines) and agent_text (the beat's actual report). Before this fix only
  // agent_log was buffered, so switching window focus mid-beat replayed the cost
  // line on reconnect but silently dropped the report. The buffer must carry the
  // event type so the report (agent_text) is replayed under its own type.
  const buf = createLogBuffer();
  buf.push({ message: 'Beat cost: $0.03' });                    // agent_log
  const cursor = buf.push({ message: 'heartbeat processed' });  // agent_log
  // Client rendered up to `cursor`, then the stream dropped (tab hide) and the
  // report streamed while disconnected:
  buf.push({ text: '## Coil Scouting Report' }, 'agent_text');
  const replayed = buf.since(cursor);
  assert.deepEqual(replayed.map(e => e.event), ['agent_text']);
  assert.equal(replayed[0].data.text, '## Coil Scouting Report');
});

test('formatSseLogFrame emits an SSE frame carrying the entry event type and id', () => {
  // The live broadcast and the reconnect backfill both stamp frames through this
  // one helper so they can never disagree on event type — the bug was the backfill
  // hardcoding `event: agent_log` for every replayed line.
  const frame = formatSseLogFrame({ id: 42, event: 'agent_text', data: { text: 'report' } });
  assert.equal(frame, 'id: 42\nevent: agent_text\ndata: {"text":"report"}\n\n');
});

test('formatSseLogFrame round-trips a buffered entry under its own event type', () => {
  const buf = createLogBuffer();
  buf.push({ message: 'cost' });                       // agent_log
  buf.push({ text: 'report' }, 'agent_text');          // agent_text
  const frames = buf.since(0).map(formatSseLogFrame);
  assert.match(frames[0], /^id: \d+\nevent: agent_log\n/);
  assert.match(frames[1], /^id: \d+\nevent: agent_text\n/);
});

test('broadcastBufferedLine writes an event-typed frame to live clients AND buffers it', () => {
  const buf = createLogBuffer();
  const writes = [];
  const clients = new Set([{ write: (m) => writes.push(m) }]);
  broadcastBufferedLine(clients, buf, 'agent_text', { text: 'report' });
  // (1) the connected client received an agent_text frame (not agent_log)
  assert.equal(writes.length, 1);
  assert.match(writes[0], /^id: \d+\nevent: agent_text\ndata: {"text":"report"}\n\n$/);
  // (2) the same line is retained so a reconnecting client can replay it
  assert.deepEqual(buf.since(0).map(e => e.event), ['agent_text']);
});

test('broadcastBufferedLine buffers even with zero clients connected — the dropped-report bug', () => {
  // This is the exact failure: the tab is hidden (SSE torn down) when the beat
  // streams its report. With no client connected the line must STILL land in the
  // buffer, or the reconnect has nothing to replay and the report is lost.
  const buf = createLogBuffer();
  broadcastBufferedLine(new Set(), buf, 'agent_text', { text: 'Coil report' });
  assert.deepEqual(buf.since(0).map(e => e.data.text), ['Coil report']);
});
