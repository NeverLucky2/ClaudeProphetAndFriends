# Go Logs → Dedicated Console Tab — Brainstorming Brief

**Date:** 2026-05-22
**Status:** ⚠️ NOT a design — this is a *brainstorming kickoff* for a future session.
**Author:** Hand-off from the cross-agent 429-storm work (sub-project 2 of 3).

> **For the next session:** This file is context, not a plan. Start by invoking
> `superpowers:brainstorming` and use this as the project background, then resolve
> the Open Questions (§4) through dialogue before designing anything. Do NOT treat
> §3 as decisions — they are the current state, not the target.

---

## 1. The ask (operator's words)

> "The go logs can first live in a new tab next to the manager tab instead of
> showing on every agent."

Today each agent's **Terminal** tab interleaves the Go bot's raw logs
(`[go:4536] ... Fetching historical bars ...`) with the LLM's beat narration.
The Go-log volume buries the agent's actual reasoning/actions. The operator wants
the Go logs routed to a dedicated console view so each agent's Terminal stays
focused on the LLM.

**Scope reality check (already established):** this is **pure observability**. It
moves log lines around; it does NOT reduce any API calls or affect the 429 issue
(that was sub-project #1, shipped as PR #57). Don't let the brainstorm drift into
"also reduce the logging" — that's a different goal.

## 2. Why it's its own sub-project

This is one of three independent sub-projects from the 429-storm work (see memory
`cross-agent-429-storm-project`). It is **JS/UI only** — it touches the harness
(`agent/`) and the browser dashboard, and **no Go and no trading logic**. That
isolation is why it's separate from #1 (Go data layer) and #3 (FMP, cross-language).

## 3. How logs flow TODAY (current state — verified, with pointers)

Producer → server → browser, one pipe:

1. **Producers** emit `agent_log` events shaped `{ message, level, timestamp, sandboxId? }`:
   - **Go bot logs** — `agent/orchestrator.js:207-226`: the spawned `prophet_bot`'s
     stdout/stderr lines are emitted as `agent_log` with `level: 'info'`/`'warning'`,
     `sandboxId`, and the message **prefixed `[go:${runtime.port}]`** (GIN access
     logs are filtered out). The `[go:PORT]` prefix is the current Go-log marker.
   - **LLM beat logs** — `agent/harness.js` (many sites, e.g. :351, :364, :490, :630)
     emit `agent_log` via `this.state.emit(...)` — the agent's reasoning/status.
   - **Scheduler logs** — `agent/analysis-scheduler.js:700` emits `agent_log`
     prefixed `[Scheduler]`.
2. **Server fan-out** — `agent/server.js`: a single **SSE** stream. `sseClients` Set +
   `broadcast(event, data)` (:119-124) writes `event: agent_log\ndata: {json}`.
   `agent_log` is in the `EVENTS` allowlist (:127-129). Per-harness binding stamps
   `sandboxId` onto each event (`targetHarness.state.on('agent_log', ...)`, :258-259);
   the scheduler's are broadcast globally (:147).
3. **Browser** — `agent/public/index.html`: an `EventSource` in the `<script>` block
   consumes the SSE stream and renders `agent_log` into the **Terminal** tab,
   filtered to the active sandbox. Tabs are defined at :1079-1084
   (Terminal / Trades / History / Portfolio / Agents). There is already a
   **`.terminal-search-bar`** with a level `<select>` filter (~:775-792) and a
   per-sandbox terminal wrapper (`.sandbox-terminal-wrapper`, :758) — useful UI
   precedents for filtering/splitting.

**Key lever:** Go logs are already distinguishable (the `[go:PORT]` prefix). The
cleanest split point is probably to tag the event with an explicit
`source: 'go' | 'llm' | 'scheduler'` field at emit time (in orchestrator.js /
harness.js / scheduler) rather than prefix-matching strings in the browser — but
that is a design decision for the brainstorm, not a given.

## 4. Open questions the brainstorm MUST resolve (do not pre-decide)

1. **Per-sandbox vs global console.** One global "Console" tab showing every bot's
   Go logs (filterable by agent/port)? Or a per-agent Go sub-view? The operator
   said "next to the *manager* tab" — clarify what "manager" means in their mental
   model (the whole app? the Agents tab? a view not yet built?).
2. **What exactly moves.** All Go logs out of Terminal? Or keep Go **errors/warnings**
   in the agent Terminal (so failures stay visible per-agent) and move only `info`?
3. **Where to split** — three candidate layers, each with trade-offs:
   - Producer: add a `source` field to the `agent_log` event (cleanest, touches 3 emitters).
   - Server: broadcast a separate event (e.g. `go_log`) for Go-sourced lines.
   - Frontend-only: filter by `[go:` prefix in the browser (smallest change, brittle).
4. **Tab placement & UX** — new top-level tab vs a split pane in Terminal; does it
   reuse the existing search/level-filter bar; scrollback cap; does switching
   sandboxes filter it.
5. **Backward-compat / config** — should this be behind a toggle (some operators may
   want Go logs inline)? Default?

## 5. Constraints / preferences (from memory + repo conventions)

- Follow existing harness patterns: SSE `broadcast` + `EVENTS` allowlist, the
  tab/`switchTab` structure, the `.terminal-search-bar` filter idiom.
- **`node:test`** for any JS logic (per workflow-preferences). The split logic
  (e.g. a `classifyLogSource(message|event)` helper) should be a pure, unit-tested
  function — mirror how sub-project #1's `candidate-warmer-flags.js` was extracted
  + tested standalone.
- One squashed implementation commit per backlog item; plan-first then implement.
- PRs go to the fork `NeverLucky2/ClaudeProphetAndFriends`.
- This branch should start off `main` (or current main-equivalent) — it shares no
  code with the #1 bar-cache stack, so it does NOT need to stack on
  `fix-intraday-fetch-resilience`.

## 6. Files in play (starting set for the brainstorm)

- `agent/orchestrator.js` — Go-log producer (`[go:PORT]` emit, :207-226).
- `agent/harness.js` — LLM-log producer.
- `agent/analysis-scheduler.js` — scheduler-log producer.
- `agent/server.js` — SSE fan-out (`broadcast`, `EVENTS`, per-harness binding).
- `agent/public/index.html` — tabs, the `EventSource` consumer, terminal rendering
  + the existing search/level filter bar.
- (Possibly new) `agent/<log-source-classifier>.js` + `.test.mjs` — if a pure
  split helper is extracted.
