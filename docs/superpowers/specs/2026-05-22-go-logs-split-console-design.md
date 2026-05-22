# Go Logs → Per-Agent Split Console — Design

**Date:** 2026-05-22
**Status:** ✅ Design — approved in brainstorming, ready for implementation planning.
**Derives from:** `docs/superpowers/specs/2026-05-22-go-logs-console-tab-brainstorming-brief.md`
(sub-project 2 of 3 from the cross-agent 429-storm work).

---

## 1. Background & goal

Today each agent's **Terminal** sub-tab interleaves the Go bot's raw logs
(`[go:4536] Fetching historical bars …`) with the LLM's beat narration. The
high-volume Go output buries the agent's actual reasoning and actions.

**Goal:** route each agent's Go-backend logs into a dedicated **side pane**
within that agent's Terminal, keeping the reasoning pane clean — while making
sure failures are never hidden.

This is **pure observability**: it moves log lines between panes. It does **not**
reduce API calls or log volume (that was sub-project #1, PR #57), and it touches
**no Go and no trading logic**.

## 2. Decisions (resolved during brainstorming)

1. **Per-agent, not shared.** Go logs are already per-agent: each sandbox runs
   its own `prophet_bot` on its own port, and lines are tagged with `sandboxId`
   and a `[go:PORT]` prefix. We keep that — no cross-agent aggregation.
2. **Placement = split pane inside each agent's Terminal** (not a new sub-tab,
   not a new top-level tab). `.terminal-area` splits into
   `[ Reasoning | Go Console ]`; the existing 320px stats sidebar is unchanged.
3. **Errors mirror to both panes.** Routine Go output stays in the Go Console;
   `error`-level Go lines (crashes, abnormal exit, auto-restart) **also** appear
   in the Reasoning pane so a failure is impossible to miss.
4. **Split point = explicit producer `source` field** (over frontend
   prefix-matching or a separate SSE event).
5. **No separate "inline mode" toggle.** A collapse control on the Go Console is
   the backward-compat story; because errors mirror to Reasoning, collapsing
   never hides a failure.

## 3. Architecture overview

Three layers, smallest viable change at each:

```
Producer (orchestrator.js)        Classifier (new, pure)        Frontend (index.html)
  agent_log + source:'go'   ──▶   classifyLogPanes(event)  ──▶   route into pane(s):
  on all 6 Go emit sites          → { main, go }                 reasoning / go-console
```

- **Producer:** stamp `source: 'go'` on the `agent_log` events the orchestrator
  emits for the Go backend. No new event type; the SSE pipe and `EVENTS`
  allowlist are untouched.
- **Classifier:** a pure, unit-tested helper decides which pane(s) each line
  renders into. Single source of truth for the routing rule.
- **Frontend:** the existing single `agent_log` SSE handler calls the classifier
  and appends the rendered line to the matching pane(s) of the line's sandbox.

## 4. Producer changes — `agent/orchestrator.js`

Add `source: 'go'` to all six `agent_log` emits inside `startGoBackend`:

| # | Line (approx) | Trigger | level | Prefixed `[go:]`? |
|---|---|---|---|---|
| 1 | ~212 | bot stdout | `info` | yes |
| 2 | ~220 | bot stderr | `warning` | yes |
| 3 | ~234 | backend exited | `info` (clean) / `error` (abnormal) | no |
| 4 | ~242 | crashed — auto-restarting | `error` | no |
| 5 | ~250 | auto-restart failed | `error` | no |
| 6 | ~265 | backend ready on port | `success` | no |

No other emit-time logic changes. In particular, **stderr stays `level: 'warning'`**
(see §9) so Slack error alerts are unaffected.

## 5. Classifier contract — `agent/log-source.mjs` (new)

```js
// Pure. No side effects, no DOM, no imports.
export function classifyLogPanes({ source, message, level } = {}) {
  const isGo = source === 'go' || /^\[go:\d+\]/.test(String(message ?? ''));
  if (!isGo) return { main: true, go: false };
  return { main: level === 'error', go: true };
}
```

Routing rules:

| Line | Reasoning (main) | Go Console (go) |
|---|---|---|
| LLM / scheduler (not Go) | ✅ | — |
| Go, `level` ∈ {info, warning, success} | — | ✅ |
| Go, `level: error` (crash / abnormal exit / restart) | ✅ | ✅ |

- The `/^\[go:\d+\]/` fallback ensures legacy or untagged `[go:PORT]` lines still
  route to the Go Console even without the `source` field.
- Safe default: anything not identified as Go → Reasoning only. A line never
  vanishes; worst case it lands in Reasoning.

## 6. Frontend UX — `agent/public/index.html`

**Layout.** Split `.terminal-area` into two flex columns:
- **Reasoning** (`flex: ~1.4`) — the existing `.terminal[data-terminal=sid]`,
  behavior unchanged. The top `.terminal-search-bar` (search + level select)
  keeps filtering this pane only.
- **Go Console** (`flex: ~1`) — new `.terminal[data-terminal-go=sid]` with a
  left border, its own header, and its own search box.

The 320px stats `.sidebar` stays as the third column, unchanged.

**Go Console header.** `Go Console :PORT` label, a small search input scoped to
the Go pane, and a collapse/expand chevron.

**Collapse + persistence.** A single global `localStorage` key
(`goConsoleCollapsed`, default `false` = expanded) controls collapsed state for
all sandbox Go Consoles. New terminals created by `ensureSandboxTerminal` read it
on creation. Collapsed = folds to a thin bar showing the line count; Reasoning
reclaims the width.

**Scrollback cap.** The Go Console keeps at most **500** entries; appending past
the cap trims the oldest. (These are the high-volume lines; the Reasoning pane
keeps its current uncapped behavior to avoid scope creep.)

**Routing touch point.** Only the `agent_log` SSE handler changes: it calls
`classifyLogPanes(d)` and appends the rendered entry to the Reasoning pane and/or
the Go Console for `d.sandboxId`. All other event types (`agent_text`,
`beat_start`, `tool_call`, …) are unchanged → Reasoning only.

**Scope exclusions.**
- The **Manager** terminal (`ensureManagerTerminal`, `_manager`) has no Go backend
  → no Go Console added; left exactly as-is.
- **Mobile:** the existing rule already sets `.terminal-split { flex-direction: column }`
  and hides the sidebar; the Go Console stacks below Reasoning. No new mobile code
  beyond making the new pane participate in that stack.

## 7. Testing

`agent/log-source.test.mjs` (`node:test`), covering `classifyLogPanes`:
- LLM line (no source, no prefix) → `{ main:true, go:false }`.
- `source:'go'`, `level:'info'` → `{ main:false, go:true }`.
- `source:'go'`, `level:'warning'` (stderr) → `{ main:false, go:true }`.
- `source:'go'`, `level:'success'` (ready) → `{ main:false, go:true }`.
- `source:'go'`, `level:'error'` (crash) → `{ main:true, go:true }`.
- Untagged `[go:4536] …` with no `source`, `level:'info'` → `{ main:false, go:true }`.
- Untagged `[go:4536] …`, `level:'error'` → `{ main:true, go:true }`.
- Missing/empty input (`{}`, `undefined` message) → `{ main:true, go:false }`.

Frontend DOM wiring is verified manually (run the dashboard, confirm `[go:]`
lines land in the Go Console, a forced crash mirrors into Reasoning, collapse
persists across reload).

## 8. Non-goals / scope boundaries

- No change to log **volume** or API call counts.
- No Go-side or trading-logic changes.
- No new SSE event types; `EVENTS` allowlist and `broadcast` untouched.
- No "revert to fully-inline" mode (collapse + error-mirroring covers it).
- No cap or restructuring of the Reasoning pane.

## 9. Noted nuances

- **stderr level.** The orchestrator flattens all Go stderr to `level:'warning'`,
  so a Go error printed to stderr arrives as `warning` and stays Go-Console-only.
  We deliberately mirror only `level:'error'`. Real crashes still surface in
  Reasoning via the `error`-level lifecycle lines (exit/crash/restart). We do
  **not** reclassify stderr→error because `level:'error'` triggers Slack error
  alerts (`server.js` `notifySlack` on errors) — that would spam on routine
  stderr.
- **Post-crash recovery.** The follow-up `success` "ready on :PORT" line is
  Go-Console-only (not mirrored). After a mirrored crash, recovery is implied by
  beats resuming in Reasoning. Mirroring success-after-error was judged not worth
  the stateful complexity.

## 10. Files in play

- `agent/orchestrator.js` — add `source:'go'` to 6 emit sites (§4).
- `agent/log-source.mjs` — **new** pure classifier (§5).
- `agent/log-source.test.mjs` — **new** `node:test` suite (§7).
- `agent/public/index.html` — Go Console pane DOM + CSS, `agent_log` routing,
  collapse/persistence, scrollback cap (§6).

## 11. Rollout

- Branch off **`main`** (shares no code with the #1 bar-cache stack — does not
  stack on `fix-intraday-fetch-resilience`).
- One squashed implementation commit.
- PR to the fork `NeverLucky2/ClaudeProphetAndFriends`.
