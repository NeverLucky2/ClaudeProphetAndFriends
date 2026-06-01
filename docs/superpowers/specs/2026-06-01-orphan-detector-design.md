# Orphan-Position Detector — Design

**Date:** 2026-06-01
**Status:** Approved (pending spec review)
**Area:** `services/position_manager.go` (Go trading backend)

## Context

`CloseManagedPosition` and the broker-reconciliation pass keep the managed-position
ledger in sync with broker truth in **one direction**: `reconcileWithBroker`
closes a managed row that is `ACTIVE`/`PARTIAL` when the broker no longer holds the
symbol (the *phantom* direction — managed row says open, broker is flat).

The **opposite** direction is unhandled: a managed row marked terminal
(`CLOSED`/`STOPPED_OUT`/`FAILED`) while the **broker still holds the shares** — an
*orphan*. Orphans were produced by the old fail-open `CloseManagedPosition` (marked
`CLOSED` even when the exit order failed) and are not auto-detected today. The agent
only stumbles on them at runtime when its rules compare `get_positions` (broker truth)
against its managed records.

**Confirmed instances (Coil / `sbx_mean_rev`, 2026-06-01):** the broker held UNH
(~13 sh) and DE (~9 sh) while both were `CLOSED` in the ledger (closed 2026-05-26 /
05-28 on the old fail-open code). Coil's heartbeat reported `positions_open: 4`
(WMT + MO live, UNH + DE orphans) and flagged DE for manual close. These orphans are
unmanaged — their protective stops were cancelled when the rows were (falsely) closed.

This detector closes the gap: it proactively finds orphans and alerts the operator.

## Goals

- Detect orphans for **this** agent on every reconciliation pass, reusing the broker
  read already performed (no extra `GetPositions` call).
- Never produce false positives on the **shared broker account** (all sandboxes point
  at one account; `GetPositions` returns every agent's positions).
- Surface each orphan where the operator will actually see it (Go console logs are not
  reliably persisted).
- Be **report-only** in v1 — never place an order — with a clean seam for a future
  flag-gated auto-close.

## Non-Goals

- Auto-closing / remediating orphans (future, behind `ENABLE_ORPHAN_AUTOCLOSE`).
- Detecting orphans this agent has **no record of** (cannot be attributed to this agent
  without a managed record; out of scope, and could belong to another agent).
- Any dashboard / frontend change (operator reads the log and the report file).
- Reconciling stale entry-order rows (`pending_new`) — separate follow-up.

## Design

### Placement & data reuse

Detection runs from inside the existing `reconcileWithBroker(ctx)` pass (invoked every
`reconcileEveryTicks` from `MonitorPositions`, plus once at startup). After the existing
phantom-close loop completes, it calls a new method `pm.detectOrphans(held)`, where
`held` is the `map[string]bool` of broker-held symbols already built from the single
`GetPositions` read. No additional broker call is made.

### Detection rule (shared-account-safe)

A pure helper computes the orphan set so it can be unit-tested without I/O:

```
findOrphans(held map[string]bool, positions []*ManagedPosition) []OrphanAlert
```

For each symbol `S` with `held[S] == true`:

1. If any record for `S` is **non-terminal** (`ACTIVE`/`PARTIAL`/`PENDING`) → live
   position, **skip**.
2. Else if there is **no record at all** for `S` in this PM → another agent's position
   on the shared account, **skip**. *(Primary false-positive guard.)*
3. Else (only **terminal** records exist for `S`: `CLOSED`/`STOPPED_OUT`/`FAILED`) →
   **orphan**. Emit an `OrphanAlert`.

Because detection is keyed off symbols this PM has records for, it can only flag this
agent's own symbols. (If this agent and another both traded the same ticker and this
agent's record is terminal, it is conservatively flagged for operator review — acceptable
for a report-only alert.)

### Data structure

```go
type OrphanAlert struct {
    Symbol         string    // broker-held symbol
    BrokerQty      float64   // qty the broker reports held (shared-account aggregate)
    PositionID     string    // the terminal managed record's id
    LedgerStatus   string    // CLOSED | STOPPED_OUT | FAILED
    ClosedAt       *time.Time // when the ledger marked it terminal (if set)
    DetectedAt     time.Time
}
```

`BrokerQty` is taken from the broker `Position` for `S`. (`held` is widened to carry the
qty, or the broker positions slice is passed alongside it — implementation detail for the
plan; the existing `reconcileWithBroker` already iterates the broker positions.)

### Dedup / noise control

`reconcileWithBroker` repeats ~every 60s, so detection must not log or rewrite the report
every pass. The PM gains:

```go
orphanAlerted map[string]bool // symbol -> already alerted; guarded by pm.mu
```

`detectOrphans` diffs the freshly-computed orphan set against `orphanAlerted`:

- **Newly appeared** symbol → log the `operator_review_required` ERROR, add to the set.
- **Resolved** symbol (no longer an orphan: broker dropped it, or a non-terminal record
  reappeared) → remove from the set.
- If the set changed in either direction → rewrite the report file.

File I/O and logging happen **outside** `pm.mu`.

### Surfacing

1. **Structured log** per newly-detected orphan (`logrus` ERROR, matching existing
   `operator_review_required` style): `symbol`, `broker_qty`, `position_id`,
   `ledger_status`, `closed_at`, `operator_review_required=true`.

2. **Persisted report** — a current-state snapshot at
   `<sandbox>/reports/orphans.json`, rewritten whenever the orphan set changes and
   emptied (written as `[]`) when there are none. Written through a nil-safe
   `OrphanReporter` injected like `segmentWriter`:
   - production: `main.go` wires the reporter with the per-sandbox reports dir derived
     from the storage DB directory;
   - tests: inject a reporter pointed at `t.TempDir()`;
   - if never wired (`nil`): logging still happens, no file is written.

   Snapshot is current-state (overwritten), not dated history; the timestamped audit
   trail lives in the ERROR logs.

### Auto-close seam (not built in v1)

`detectOrphans` returns / holds the typed `[]OrphanAlert`. A future
`ENABLE_ORPHAN_AUTOCLOSE` (default OFF) would feed that list into a remediation step
that places closing orders. v1 deliberately stops at detect + report and places no
orders.

### Flag

Report-only detection is harmless, so it is **on by default with no flag** (KISS). The
flag is reserved for the future auto-close.

## Testing (TDD)

`findOrphans` (pure, no I/O):
- terminal-only record + broker holds → flagged.
- no record for a held symbol → **not** flagged (other agent on shared account).
- `ACTIVE` record + broker holds → not flagged.
- both a terminal and a non-terminal record for the same symbol → not flagged (live).
- terminal record but broker flat → not flagged.

`detectOrphans` dedup:
- same orphan across two consecutive passes → alerted/reported **once**.
- orphan resolves (broker drops the symbol) → removed from the set, report refreshed.

`OrphanReporter`:
- writes the expected JSON to a temp dir; writes `[]` when the set empties.

Regression guard:
- existing `reconcileWithBroker` tests stay green — orphan detection places **no**
  orders and does not change phantom-close behavior.

## Rollout

Report-only, on by default. Per the deploy model (rebuild from local `main`), it takes
effect on the next Go-bot rebuild. Observe the `orphans.json` / logs; build the
`ENABLE_ORPHAN_AUTOCLOSE` remediation step later only if manual cleanup proves tedious.
