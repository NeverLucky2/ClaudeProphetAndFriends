# Coil/Turtle Reasoning Digest — Design

Date: 2026-06-02
Branch: `coil-turtle-reasoning-digest` (core already committed `62bdbb4`)
Status: design approved, pending spec review → implementation plan

## Context & goal

Prophet is being reframed as a teaching tool (see memory `prophet-teaching-improvements`).
The two **mechanical** agents — Turtle (trend, fully Go) and Coil (mean-reversion,
Go signal endpoints + LLM) — make deterministic entry decisions whose rationale is
currently invisible to the user. This feature surfaces a daily, human-readable
"why we did / didn't enter" digest for those two agents, at near-zero token cost.

The deterministic formatter core already exists and is committed:
`services/agent_reasoning_digest.go` — `ExplainMeanRevEntry(sig MeanRevSignal)` and
`ExplainTrendEntry(sig TrendSignal, entered bool, blockReason string)`. They FORMAT
authoritative signal values + the agent's own verdict; they never re-derive a
decision, so a rendered line can never contradict what the agent did. ASCII-only.

This design covers **wiring** the core into the two agents and a user-facing surface.

## Decisions (locked with user)

1. **Surface** = a Node daily job that writes a report file (+ small dashboard
   section), mirroring `trade-reconciliation.js`. Not a live dashboard tab; not
   "enrich Go endpoints only."
2. **Scope** = entries + ALL evaluated tickers, grouped (ENTERs first, then
   PASS/"why not"). Universes are already bounded (Turtle ~15 ETFs; Coil reads the
   scoped candidates endpoint, not every S&P symbol), so volume is a readable handful.
3. **Go emit fields are always-on** (additive, zero token cost, lets the LLM see
   Coil's "why" inline). Only the Node aggregation job is flag-gated.
4. **Commit shape** = squash everything (incl. core `62bdbb4`) into one
   `feat(reasoning-digest)` commit before merge (one-commit-per-backlog-item rule).
5. Coverage is **Turtle + Coil only**. Prophet is LLM-narrated already; per-trade
   outcome grading is a separate backlog item (Task 3) that builds on top.

## Architecture — 3 additive units + 1 flag-gated surface

### Unit 1 — Turtle emits (Go: `turtle_executor.go`, `turtle_controller.go`)
- Add a structured field to `HeartbeatResult`:
  `Reasoning []TickerRationale` where
  `TickerRationale{ Ticker string; Line string; SetupQualified bool; Taken bool; BlockedBy string }`.
- In `runEntries`, for every evaluated ticker compute the signal-level verdict line
  via `ExplainTrendEntry(*sig, taken, blockReason)`:
  - `SetupQualified` = `evaluateEntry(...).Eligible` (did the trend setup pass the
    Donchian/SMA/ATR/cold-start gates — the teaching content).
  - `Taken` = a buy order was actually placed.
  - `BlockedBy` = the gate that declined a *qualified* setup (risk cap / correlation
    / cluster / shares<1 / guard), so a qualified-but-not-taken line stays faithful.
    Empty when taken or when the setup itself didn't qualify.
  - `blockReason` passed to `ExplainTrendEntry` = `evaluateEntry`'s `Reason` on a
    signal-level pass, else the portfolio-gate reason.
- The executor retains its most recent `*HeartbeatResult`; `/api/v1/turtle/status`
  includes it so the Node job can read the day's reasoning. (Turtle runs once daily
  on the Go scheduler; by the after-close digest run its latest beat is complete.)

### Unit 2 — Coil emits (Go: `meanrev_controller.go`)
- `HandleGetCandidates` and `HandleGetSignal` attach
  `Explanation: services.ExplainMeanRevEntry(sig)` to each signal in the JSON
  response (a new field on the per-symbol payload, `omitempty` not used — always set).
- Single source of truth stays in Go; the LLM sees the explanation inline (handoff
  requirement) and the Node job reads the same field.

### Unit 3 — Node daily digest job (`agent/reasoning-digest.js`, new)
Pure functions + injected-dependency I/O, mirroring `trade-reconciliation.js`:
- `runReasoningDigestAllSandboxes(isoDate)` (wired in `server.js`) iterates
  `orchestrator.runtimes`, resolves each agent via `getResolvedAgentForSandbox`,
  and per agent:
  - Turtle (`strategyId === 'trend'`) → `goAxios.get('/api/v1/turtle/status')` →
    read `Reasoning[]`.
  - Coil (`strategyId === 'mean-rev'`) → `goAxios.get('/api/v1/meanrev/candidates')`
    → read each candidate's `Explanation`.
  - Other agents skipped (not covered).
- `buildDigest(perAgentData)` (pure) groups into ENTERs then PASS/why-not, per agent.
- `renderMarkdown(digest)` / writes `data/reasoning-digest/<date>.{md,json}`.
- Soft-fail per sandbox (one bot down must not abort the rest).
- Never re-derives a verdict — consumes only the Go-computed Explain lines.

### Surface — scheduler job + read endpoint + dashboard section
- `reasoning_digest` scheduler job at ~4:50pm ET weekdays (just after the 4:45pm
  reconciliation job), idempotent per ET day (in-memory flag like the other daily
  jobs), gated by `REASONING_DIGEST_ENABLED` (**default OFF**).
- `GET /api/reasoning-digest?date=` serves the stored digest JSON.
- A small collapsible Trades-tab-style section renders the day's digest; silent when
  absent (no banner on days with no data).

## Data flow

```
Turtle Go scheduler (daily) ── evaluateEntry → ExplainTrendEntry → HeartbeatResult.Reasoning
                                                                        │  /api/v1/turtle/status
Coil signal endpoints ── ComputeMeanRevSignal → ExplainMeanRevEntry → candidate.Explanation
                                                                        │  /api/v1/meanrev/candidates
                                                                        ▼
        Node reasoning_digest job (4:50pm ET, REASONING_DIGEST_ENABLED) iterates runtimes,
        GETs both, groups + renders
                                                                        ▼
        data/reasoning-digest/<date>.{md,json}  +  GET /api/reasoning-digest  +  dashboard section
```

## Error handling
- Per-sandbox soft-fail, matching reconciliation/fills-summary.
- Missing/empty Go data for an agent → that agent omitted from the digest (not an
  error banner; "never a wrong banner" rule).
- Go-side Explain calls are pure formatters over already-fetched data → no new
  failure modes, no behavior change to either agent's trading.

## Testing (TDD)
- **Go**
  - Existing 5 tests on the formatters stay green.
  - `meanrev_controller` test: `Explanation` field present + correct in
    `/meanrev/candidates` and `/meanrev/signal` responses.
  - `turtle_executor` test: `HeartbeatResult.Reasoning` carries faithful entries for
    the three cases — entered, qualified-but-portfolio-blocked, signal-level pass.
- **Node**
  - `agent/reasoning-digest.test.mjs`: pure grouping/rendering from fixture Go
    payloads; `etDayOf` idempotency; empty-data silence; per-sandbox soft-fail;
    markdown render shape. Mirrors the reconciliation test suite.

## Flags & cadence
- `REASONING_DIGEST_ENABLED` (Node, default OFF) — gates only the scheduler job +
  cross-sandbox runner. Go emit fields are unconditional.
- Cadence: weekdays ~4:50pm ET, idempotent per ET trading day.

## Out of scope (YAGNI)
- Live dashboard tab (chose report file + section).
- Historical backfill of past days.
- Drift / Prophet coverage.
- Per-trade thesis-vs-outcome grading (Task 3, separate item, builds on this).

## Open items to pin during planning
- Confirm `/api/v1/turtle/status` current response shape and add last-`HeartbeatResult`
  retention if it doesn't already surface it.
- Confirm `MeanRevCandidatesResponse` per-symbol payload type to attach `Explanation`.
- Confirm `getResolvedAgentForSandbox` strategyId values (`'trend'`, `'mean-rev'`).
