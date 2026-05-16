# Penny Social-Exit Timer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Read first:** `docs/superpowers/plans/2026-05-16-llm-token-savings-prerequisites.md`. It contains the verified `services/alpaca_trading.go` API surface (`PlaceOrder`, `GetOrder`, `CancelOrder` — no `PlaceMarketOrder` shortcut exists), strategy-rule loading order, recommended execution sequence (this plan is **#1**, do this first), and the strategy-attribution invariant.

**Goal:** Move PennyProphet's social-signal 20-minute time exit (`TRADING_RULES_PENNY.md:263-282`) from the LLM heartbeat into the Go `PositionManager` so the LLM does not have to track wall-clock time-since-entry on every beat.

**Architecture:** Thread the dominant-signal type onto each managed position when it's opened. Inside `PositionManager.MonitorPositions` (the existing 5-second monitor loop), add a new check that fires only for positions with `DominantSignal == "social"`: at `now ≥ CreatedAt + 20 min` OR `now ≥ (today's market close − 15 min)`, cancel the bracket via the existing cancel path and place a market sell for the remaining quantity. The race-condition handling from the rules doc maps directly to the existing `MonitorPositions` flow.

**Tech Stack:** Go 1.21+, GORM (managed positions are persisted to DB so the timer survives restarts), Alpaca trading API.

---

## File Structure

- Modify: `services/position_manager.go` — add `DominantSignal` field + `evaluateSocialTimeExit` method called from `MonitorPositions`.
- Modify: `services/position_manager_persistence_test.go` (or a new test file) — unit tests for the time-exit logic.
- Modify: `database/storage.go` + the `DBManagedPosition` model — persist `DominantSignal`.
- Modify: `mcp-server.js` — `place_managed_position` accepts a `dominant_signal` field and forwards it.
- Modify: `controllers/order_controller.go` (or wherever `HandlePlaceManagedPosition` lives — grep first) — pass through `dominant_signal` from request body.
- Modify: `TRADING_RULES_PENNY.md` — annotate the social exit section as backend-managed.

---

## Task 0: Discover the place-managed wiring

- [ ] **Step 1: Find the HTTP handler and DB model**

```bash
grep -rn "PlaceManagedPosition\|managed_position\|DBManagedPosition" \
  controllers/ models/ database/ mcp-server.js | head -30
```

Record exact file:line refs. The plan below references `controllers/<file>.HandlePlaceManagedPosition` and `models/DBManagedPosition`; if the actual names differ, substitute everywhere.

- [ ] **Step 2: Confirm CancelOrder exists on the trading service**

```bash
grep -n "func.*CancelOrder\|func.*PlaceOrder" services/alpaca_trading.go | head
```

Confirm the signatures the timer will need: cancel a specific order ID, place a market sell for a symbol/qty.

---

## Task 1: Persist DominantSignal on managed positions

**Files:**
- Modify: `models/<managed-position-model-file>.go`
- Modify: `database/storage.go` (migration / column add — if AutoMigrate, just adding the struct field is enough)
- Modify: `services/position_manager.go` (request shape + ManagedPosition struct)

- [ ] **Step 1: Add the field to the DB model**

In whichever file defines `DBManagedPosition` (find via Task 0), add:

```go
DominantSignal string `gorm:"index"` // "social" | "regulatory" | "technical" | ""
```

- [ ] **Step 2: Add the field to the in-memory + request structs**

`services/position_manager.go`, in `ManagedPosition` (around line 64, after `Tags`):

```go
// Penny-only: drives the time-based exit. Empty on non-penny managed positions.
DominantSignal string `json:"dominant_signal,omitempty"`
```

And in `PlaceManagedPositionRequest` (around line 103):

```go
DominantSignal string `json:"dominant_signal,omitempty"`
```

- [ ] **Step 3: Plumb the field through `PlaceManagedPosition`**

In `PlaceManagedPosition` (line 152+), find where the `ManagedPosition` struct is built (around line 220-230 — the `CreatedAt: time.Now()` line is a landmark) and add:

```go
DominantSignal: req.DominantSignal,
```

Also ensure the field is persisted in the DB-save call further down (search for `dbPos :=` in the file and add the field mapping).

- [ ] **Step 4: Build + smoke**

```bash
go build ./...
go test ./services -run TestPositionManager -v
```

Expected: PASS (no behavior change yet).

- [ ] **Step 5: Commit**

```bash
git add services/position_manager.go models/<managed-position-file>.go
git commit -m "feat(penny): persist dominant_signal on managed positions"
```

---

## Task 2: Surface `dominant_signal` through the MCP boundary

**Files:**
- Modify: `mcp-server.js:317-406` (the `place_managed_position` tool definition + handler)
- Modify: `controllers/<the-handler>.go` (whichever controller exposes `/api/v1/managed-positions`)

- [ ] **Step 1: Add the field to the MCP tool input schema**

In `mcp-server.js`, find the `place_managed_position` tool block (starts near line 317). Add to `inputSchema.properties`:

```js
dominant_signal: {
  type: 'string',
  enum: ['social', 'regulatory', 'technical'],
  description: 'For PennyProphet entries: dominant signal classification. Drives the 20-minute time exit for social positions. Pass through from get_penny_signal_detail.',
},
```

In the handler (search for `place_managed_position` case in the tool-call switch), add `dominant_signal: args.dominant_signal,` to the request body forwarded to the Go backend.

- [ ] **Step 2: Add field to the controller request struct**

In whichever controller handles `POST /api/v1/managed-positions`, add `DominantSignal string \`json:"dominant_signal"\`` to the request struct, then pass it onto `pm.PlaceManagedPosition(ctx, &req)`. Since `services.PlaceManagedPositionRequest.DominantSignal` was added in Task 1, this is a one-line plumbing change.

- [ ] **Step 3: Manually verify field round-trip**

Restart bot in paper mode. Place a managed position via the MCP tool with `dominant_signal: "social"`. Query the position back via `get_managed_positions` and confirm the field is set.

- [ ] **Step 4: Commit**

```bash
git add mcp-server.js controllers/<file>.go
git commit -m "feat(penny): plumb dominant_signal through place_managed_position MCP path"
```

---

## Task 3: Implement the social-exit timer in PositionManager

**Files:**
- Modify: `services/position_manager.go`
- Modify: `services/position_manager_persistence_test.go` (or new file `services/position_manager_social_exit_test.go`)

- [ ] **Step 1: Write the failing test**

Create `services/position_manager_social_exit_test.go`:

```go
package services

import (
	"context"
	"testing"
	"time"
)

func TestEvaluateSocialTimeExit_FiresAt20Min(t *testing.T) {
	pos := &ManagedPosition{
		ID:             "p1",
		Symbol:         "ABCD",
		Side:           "buy",
		RemainingQty:   100,
		Status:         "ACTIVE",
		DominantSignal: "social",
		CreatedAt:      time.Date(2026, 5, 16, 14, 0, 0, 0, time.UTC),
		StopLossOrderID: "stop-1",
		TakeProfitOrderID: "tp-1",
	}
	now := time.Date(2026, 5, 16, 14, 20, 0, 0, time.UTC) // 20 min later
	marketClose := time.Date(2026, 5, 16, 20, 0, 0, 0, time.UTC)

	got := shouldFireSocialTimeExit(pos, now, marketClose)
	if !got {
		t.Errorf("expected social time exit to fire at 20 min, got false")
	}
}

func TestEvaluateSocialTimeExit_FiresIfCloseWithin15Min(t *testing.T) {
	pos := &ManagedPosition{
		ID:             "p1",
		Status:         "ACTIVE",
		DominantSignal: "social",
		CreatedAt:      time.Date(2026, 5, 16, 19, 50, 0, 0, time.UTC), // entered 10 min before close
	}
	now := time.Date(2026, 5, 16, 19, 51, 0, 0, time.UTC)
	marketClose := time.Date(2026, 5, 16, 20, 0, 0, 0, time.UTC) // 9 min away

	if !shouldFireSocialTimeExit(pos, now, marketClose) {
		t.Errorf("expected fire when close is within 15 min, got false")
	}
}

func TestEvaluateSocialTimeExit_NoFireForNonSocial(t *testing.T) {
	pos := &ManagedPosition{
		Status:         "ACTIVE",
		DominantSignal: "technical",
		CreatedAt:      time.Date(2026, 5, 16, 14, 0, 0, 0, time.UTC),
	}
	now := time.Date(2026, 5, 16, 15, 0, 0, 0, time.UTC) // 1 hr later
	marketClose := time.Date(2026, 5, 16, 20, 0, 0, 0, time.UTC)

	if shouldFireSocialTimeExit(pos, now, marketClose) {
		t.Errorf("expected no fire for technical signal, got true")
	}
}

func TestEvaluateSocialTimeExit_NoFireBefore20Min(t *testing.T) {
	pos := &ManagedPosition{
		Status:         "ACTIVE",
		DominantSignal: "social",
		CreatedAt:      time.Date(2026, 5, 16, 14, 0, 0, 0, time.UTC),
	}
	now := time.Date(2026, 5, 16, 14, 19, 0, 0, time.UTC)
	marketClose := time.Date(2026, 5, 16, 20, 0, 0, 0, time.UTC)

	if shouldFireSocialTimeExit(pos, now, marketClose) {
		t.Errorf("expected no fire before 20 min, got true")
	}
}

func TestEvaluateSocialTimeExit_NoFireWhenClosed(t *testing.T) {
	pos := &ManagedPosition{
		Status:         "CLOSED",
		DominantSignal: "social",
		CreatedAt:      time.Date(2026, 5, 16, 14, 0, 0, 0, time.UTC),
	}
	now := time.Date(2026, 5, 16, 15, 0, 0, 0, time.UTC)
	marketClose := time.Date(2026, 5, 16, 20, 0, 0, 0, time.UTC)

	if shouldFireSocialTimeExit(pos, now, marketClose) {
		t.Errorf("expected no fire on CLOSED position, got true")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test ./services -run TestEvaluateSocialTimeExit -v
```

Expected: FAIL with `undefined: shouldFireSocialTimeExit`.

- [ ] **Step 3: Implement the trigger predicate**

Add to `services/position_manager.go` (top of file, with other helpers — or after `PartialExitConfig`):

```go
// shouldFireSocialTimeExit returns true when pos is a social-signal penny
// position that has either (a) been open ≥ 20 min OR (b) entered the
// last-15-min-of-session window — whichever comes first. Mirrors the rule
// in TRADING_RULES_PENNY.md lines 263-265.
//
// Positions whose Status is not ACTIVE are excluded — STOPPED_OUT, CLOSED,
// FAILED have already been handled by the bracket monitor.
func shouldFireSocialTimeExit(pos *ManagedPosition, now, marketClose time.Time) bool {
	if pos == nil || pos.DominantSignal != "social" {
		return false
	}
	if pos.Status != "ACTIVE" && pos.Status != "PARTIAL" {
		return false
	}
	if now.Sub(pos.CreatedAt) >= 20*time.Minute {
		return true
	}
	if !marketClose.IsZero() && marketClose.Sub(now) <= 15*time.Minute {
		return true
	}
	return false
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
go test ./services -run TestEvaluateSocialTimeExit -v
```

Expected: PASS for all 5 cases.

- [ ] **Step 5: Wire into MonitorPositions**

Find the existing `MonitorPositions` method (search for `func (pm *PositionManager) MonitorPositions`). Inside the per-position loop, add a branch *before* the bracket-evaluation code so the social-exit cancel-and-replace runs first:

```go
// Social-signal time exit (penny only). Fires before normal bracket
// evaluation so a stop or target firing in the same tick doesn't race
// the time exit — the cancel happens first.
marketClose := pm.todayMarketClose(now) // implement: 20:00 UTC = 16:00 ET, weekday-aware
if shouldFireSocialTimeExit(pos, now, marketClose) {
	if err := pm.executeSocialTimeExit(pm.ctx, pos); err != nil {
		pm.logger.WithError(err).WithField("position_id", pos.ID).Warn("social time exit failed")
	}
	continue
}
```

- [ ] **Step 6: Implement `executeSocialTimeExit` and `todayMarketClose`**

Add methods to `PositionManager`:

```go
// todayMarketClose returns the regular-session close in UTC for the date
// of `now`. Weekends return a zero time so the rule's "15 min before close"
// branch never fires on a weekend (the social position should have been
// flat by Friday close per the rules anyway).
func (pm *PositionManager) todayMarketClose(now time.Time) time.Time {
	et, err := time.LoadLocation("America/New_York")
	if err != nil {
		return time.Time{}
	}
	local := now.In(et)
	wd := local.Weekday()
	if wd == time.Saturday || wd == time.Sunday {
		return time.Time{}
	}
	close := time.Date(local.Year(), local.Month(), local.Day(), 16, 0, 0, 0, et)
	return close.UTC()
}

// executeSocialTimeExit implements the cancel-bracket → market-sell flow
// from TRADING_RULES_PENNY.md:264-282.
//
// 1. Cancel both stop-loss and take-profit orders if present.
// 2. If a cancel fails because the order already filled, treat the
//    position as already closed and return.
// 3. Place a market sell for RemainingQty.
// 4. Confirm fill within 60s (polling) — out of scope for v1; rely on the
//    bracket-monitor's existing post-fill reconcile to pick up the close.
func (pm *PositionManager) executeSocialTimeExit(ctx context.Context, pos *ManagedPosition) error {
	pm.logger.WithFields(map[string]interface{}{
		"position_id": pos.ID,
		"symbol":      pos.Symbol,
		"age":         time.Since(pos.CreatedAt).String(),
	}).Info("social-signal time exit firing")

	// Cancel stop + target if present. Errors on already-filled orders are
	// expected — log and continue, since the bracket monitor will detect
	// the fill and mark the position closed.
	for _, orderID := range []string{pos.StopLossOrderID, pos.TakeProfitOrderID} {
		if orderID == "" {
			continue
		}
		if err := pm.tradingService.CancelOrder(ctx, orderID); err != nil {
			pm.logger.WithError(err).WithField("order_id", orderID).Debug("cancel returned error (likely already filled)")
		}
	}

	// Re-fetch position to see if a bracket leg filled during cancellation.
	pm.mu.RLock()
	live, ok := pm.positions[pos.ID]
	pm.mu.RUnlock()
	if !ok || live == nil || live.Status == "CLOSED" || live.RemainingQty == 0 {
		return nil
	}

	// Place market sell for remaining shares. Strategy tag preserves
	// attribution so /api/v1/positions?strategy=penny-momentum and segment-
	// PnL continue to see this position correctly.
	side := "sell"
	if pos.Side == "sell" { // shorts unwound the other way; penny is long-only today, defensive only
		side = "buy"
	}
	_, err := pm.tradingService.PlaceOrder(ctx, &interfaces.Order{
		Symbol:      pos.Symbol,
		Qty:         live.RemainingQty,
		Side:        side,
		Type:        "market",
		TimeInForce: "day",
		Strategy:    "penny-momentum",
	})
	if err != nil {
		return fmt.Errorf("place market exit: %w", err)
	}

	// Mark position as closing; the bracket monitor's reconciliation flips to CLOSED on fill.
	pm.mu.Lock()
	live.Status = "CLOSED"
	now := time.Now()
	live.ClosedAt = &now
	pm.mu.Unlock()
	return nil
}
```

> Per the prereq doc: `PositionManager.tradingService` is `interfaces.TradingService`. Confirm `PlaceOrder` and `CancelOrder` are both on that interface (or expose them via a wrapper if `PositionManager` only sees a narrower subset today). `services/position_manager.go` already uses `pm.tradingService.GetPositions(ctx)` for its bracket monitor, so the broader interface is wired — adding `PlaceOrder`/`CancelOrder` to it (if missing) is a one-line interface addition.

- [ ] **Step 7: Run all PositionManager tests**

```bash
go test ./services -run TestPositionManager -v
go test ./services -run TestEvaluateSocialTimeExit -v
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add services/position_manager.go services/position_manager_social_exit_test.go
git commit -m "feat(penny): social-signal time exit handled by PositionManager"
```

---

## Task 4: Update penny rules to mark social-exit as backend-managed

**Files:**
- Modify: `TRADING_RULES_PENNY.md`

Per the prereq doc: the `customRules` JSON field in `data/agent-config.json` is dormant for penny-momentum because `rulesFile: "TRADING_RULES_PENNY.md"` is set — the runtime always reads the `.md`. The TRADING_RULES_PENNY.md preamble (lines 3-9) saying otherwise is stale and is corrected by Step 3 below.

- [ ] **Step 1: Update the social-signal section**

Edit `TRADING_RULES_PENNY.md:254-286` (the `dominant_signal = "social"` block). Replace the entire `TIME-BASED EXIT` subsection with:

```markdown
TIME-BASED EXIT:
The 20-minute (or 15-min-before-close) cancel-and-market-sell flow is now
executed by `PositionManager.executeSocialTimeExit` in the Go backend. The
agent does NOT need to track time-since-entry. Verify by reading the
managed position's `dominant_signal: "social"` field; if set, the backend
owns the timer.

If `place_managed_position` is called WITHOUT `dominant_signal: "social"`
on a social-driven entry, the backend will not fire the timer — pass the
field on every social entry. The signal pipeline returns this via
`get_penny_signal_detail.dominant_signal`.

RACE CONDITION HANDLING:
Backend cancels the bracket legs first, then places a market sell. If a
bracket leg fires before the cancel completes, the position is closed by
the bracket — the backend detects this via the post-cancel position
re-fetch and skips the market order.
```

- [ ] **Step 2: Remove the stale "authoritative copy" note**

`TRADING_RULES_PENNY.md` lines 3-9 contain:

```markdown
> **Note:** The authoritative copy of these rules now lives inline in
> `data/agent-config.json` under `strategies[].id == "penny-momentum"`,
> field `customRules`. This file is a human-readable mirror only — the
> agent does NOT read it at runtime. Edit the JSON (or use the
> `adapt-strategy-penny` skill) to change agent behavior. Updates here
> will not take effect.
```

This is wrong — `agent/harness.js:71-79` reads `rulesFile` first, and `penny-momentum` has `rulesFile: "TRADING_RULES_PENNY.md"` set. Delete the whole block.

- [ ] **Step 3: Confirm the agent reads the markdown**

Restart the bot with one open social position. Inspect the system prompt the agent receives (enable `OPENCODE_LOG_LEVEL=debug` for one beat) and confirm the new social-exit section text is present.

- [ ] **Step 4: Commit**

```bash
git add TRADING_RULES_PENNY.md
git commit -m "docs(penny): social-exit timer backend-managed; correct stale rules-source note"
```

---

## Task 5: Manual smoke test

- [ ] **Step 1: Place a paper social-position via the dashboard or MCP**

Use `place_managed_position` with `dominant_signal: "social"`, a small position size, stop and target set. Verify it appears in `get_managed_positions`.

- [ ] **Step 2: Watch the bot log**

After 20 minutes, the log should show:
- `social-signal time exit firing`
- Cancel attempts for stop + target order IDs
- A market sell order placement
- Position transitions to CLOSED

- [ ] **Step 3: Verify with no-dominant-signal regression**

Place a managed position WITHOUT `dominant_signal`. Wait > 20 minutes. Confirm no time exit fires and the bracket continues to manage the position.

---

## Self-Review

**Spec coverage:**
- 20-minute timer — Task 3 step 3 + step 5. ✅
- 15-min-before-close override — Task 3 step 3. ✅
- Cancel bracket → market sell — Task 3 step 6. ✅
- Race-condition handling (bracket fires during cancel) — Task 3 step 6 (post-cancel re-fetch). ✅
- ≥ 30-min-to-close entry gating (rules line 285) — **not in scope** for this plan. That's an *entry* check; the timer is an *exit* check. The agent's existing entry checklist already encodes this.

**Gaps surfaced:**
1. **60-second fill confirmation in rules doc** (`TRADING_RULES_PENNY.md:273-276`) is downgraded to "best effort" here — Task 3 step 6 comment notes it. The existing bracket-monitor's post-fill reconcile will catch stalls, but not within 60s. If the operator needs the original 60s halt-and-alert behavior, add a Task 3-bis to poll the market-sell order ID and halt-log on timeout. Out of scope for the token-savings goal.
2. **DB migration:** Adding `DominantSignal` to `DBManagedPosition` assumes GORM `AutoMigrate` is on. If migrations are manual, Task 1 needs a `database/migrations/<date>_managed_position_dominant_signal.sql` step.
3. **Restart safety:** If the bot restarts after entry but before 20 min, `pm.loadPositionsFromDB()` restores positions with `DominantSignal` (now persisted, Task 1), so the timer evaluates correctly post-restart. ✅
4. **PartialExit interaction:** A social position with `partial_exit` enabled could fire partial → social-time-exit closes the rest. The plan handles this — `executeSocialTimeExit` reads `live.RemainingQty`, so a 50%-partial-exited position only sells the remaining 50%. ✅

**Type/signature consistency:** `DominantSignal` is added to `ManagedPosition`, `PlaceManagedPositionRequest`, and `DBManagedPosition` with the same name in all three. `shouldFireSocialTimeExit` signature matches everywhere it's called. ✅

**No placeholders:** No "TBD" / "TODO" remain. The only deferred items are explicit non-goals listed under Out of Scope below.

---

## Out of Scope

- Strict 60s fill confirmation on the market-sell (see Gap #1).
- Re-classifying existing open positions retroactively — only positions opened after this deployment have `DominantSignal` set; older positions continue under LLM management until closed.
- Timer for `regulatory` (3-day hold) and `technical` (3-day max) signals — those have a much longer horizon and the LLM tracking them in heartbeats is already cheap relative to the social signal's 20-min reaction window. Could be added in a follow-up plan if needed.
