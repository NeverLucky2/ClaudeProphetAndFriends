# CloseManagedPosition Fail-Closed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `CloseManagedPosition` from marking a position `CLOSED` when the broker exit never actually happened, so a failed close can no longer leave an unprotected orphan position at the broker.

**Architecture:** Restructure `CloseManagedPosition` to be *exit-first and fail-closed*. For an open (ACTIVE/PARTIAL) position, place the market exit order **before** tearing down the protective bracket; if the exit can't be placed, return an error and leave the position fully intact (ACTIVE, stop still live) — never a CLOSED ledger row over still-held broker shares. For a PENDING position, only mark CLOSED if the entry-order cancel succeeds. This mirrors the existing fail-safe discipline in `placeRiskOrders`/`flattenUnprotected`.

**Tech Stack:** Go 1.x, module `prophet-trader`, `testing` stdlib, `logrus`. SQLite via `database.LocalStorage` (`:memory:` in tests).

---

## Background / root cause (confirmed 2026-05-27)

`services/position_manager.go` `CloseManagedPosition` (current lines ~959–1043):
1. Cancels the protective stop **first**.
2. Places the market exit; on `PlaceOrder` error it logs *"Closing position in database despite order error"* and **continues**.
3. Unconditionally sets `Status = "CLOSED"` and returns `nil`.

When the exit sell fails (e.g. a 429 rate-limit storm), the ledger says CLOSED while the broker still holds the shares — an **unprotected orphan** (the stop was already canceled). Confirmed instance: Coil (`sbx_mean_rev`) closed UNH (13 sh) + ADI (11 sh) in its ledger at 2026-05-26 14:45:27 with `remaining_qty` intact, no sell order, no trade row, no reconcile note — broker still held them on 2026-05-27 → "RECONCILIATION MISMATCH". Because all six sandboxes share account `6e4f26af`, a failed close on any agent orphans a position every agent then trips over.

**Only caller:** `controllers/position_controller.go:96` (`HandleCloseManagedPosition`), which already returns HTTP 500 when `CloseManagedPosition` errors. No other callers — the new error path propagates correctly (the `close_managed_position` MCP tool will surface failure to the agent instead of a false 200 "success").

**Design decision — no feature flag.** This is a safety correctness fix, not a behavioral feature. A flag defaulting OFF would leave the orphan bug live, defeating the purpose. Ship unconditionally.

## File Structure

- **Modify:** `services/position_manager.go` — rewrite `CloseManagedPosition` (~959–1043); add small helper `cancelBracketOrders`.
- **Create:** `services/position_manager_close_test.go` — new test file (same `services` package; reuses `stubTrading` from `trade_guard_test.go` and `newReconcilePM`/`injectPosition` from `position_manager_reconcile_test.go`).

No schema, API, or interface changes. `CloseManagedPosition`'s signature is unchanged.

---

### Task 1: Failing tests for fail-closed close behavior

**Files:**
- Create: `services/position_manager_close_test.go`

- [ ] **Step 1: Write the failing tests + stub**

Create `services/position_manager_close_test.go`:

```go
package services

import (
	"context"
	"errors"
	"testing"

	"prophet-trader/interfaces"
)

// closeStubTrading scripts PlaceOrder / CancelOrder outcomes for the close path
// and records calls. Embeds the base stubTrading (trade_guard_test.go) for the
// rest of the TradingService surface.
type closeStubTrading struct {
	*stubTrading
	placeErr     error // if set, PlaceOrder returns this error (simulates a failed exit)
	placeCalls   int
	placedOrders []*interfaces.Order
	cancelErr    error // if set, CancelOrder returns this error
	canceled     []string
}

func (s *closeStubTrading) PlaceOrder(_ context.Context, o *interfaces.Order) (*interfaces.OrderResult, error) {
	s.placeCalls++
	if s.placeErr != nil {
		return nil, s.placeErr
	}
	s.placedOrders = append(s.placedOrders, o)
	return &interfaces.OrderResult{OrderID: "exit-1", Status: "accepted"}, nil
}

func (s *closeStubTrading) CancelOrder(_ context.Context, id string) error {
	s.canceled = append(s.canceled, id)
	return s.cancelErr
}

func (s *closeStubTrading) contains(id string) bool {
	for _, c := range s.canceled {
		if c == id {
			return true
		}
	}
	return false
}

// A failed exit order must NOT mark the position CLOSED, must leave the stop
// untouched (still protected), and must return an error. This is the Coil
// UNH/ADI orphan from 2026-05-26.
func TestClose_ExitOrderFails_StaysActiveAndErrors(t *testing.T) {
	trading := &closeStubTrading{stubTrading: &stubTrading{}, placeErr: errors.New("alpaca 429 rate limited")}
	pm := newReconcilePM(t, trading)
	pos := &ManagedPosition{Symbol: "UNH", Side: "buy", Status: "ACTIVE", Quantity: 13, RemainingQty: 13, StopLossOrderID: "stop-1", AgentStrategy: "mean-rev-rsi2"}
	injectPosition(pm, pos)
	if err := pm.savePositionToDB(pos); err != nil {
		t.Fatalf("seed DB: %v", err)
	}

	err := pm.CloseManagedPosition(context.Background(), pos.ID)
	if err == nil {
		t.Fatal("expected error when exit order fails, got nil")
	}
	if pos.Status != "ACTIVE" {
		t.Errorf("in-memory status = %q, want ACTIVE (failed close must not mark CLOSED)", pos.Status)
	}
	if trading.contains("stop-1") {
		t.Error("stop-loss was cancelled on a failed close — position left unprotected")
	}
	saved, err := pm.storageService.GetManagedPosition(pos.ID)
	if err != nil {
		t.Fatalf("GetManagedPosition: %v", err)
	}
	if saved.Status != "ACTIVE" {
		t.Errorf("persisted status = %q, want ACTIVE", saved.Status)
	}
}

// A successful exit closes the position, places exactly one strategy-tagged
// exit order, and tears down both bracket legs.
func TestClose_ExitOrderSucceeds_ClosesAndCancelsBracket(t *testing.T) {
	trading := &closeStubTrading{stubTrading: &stubTrading{}}
	pm := newReconcilePM(t, trading)
	pos := &ManagedPosition{Symbol: "UNH", Side: "buy", Status: "ACTIVE", Quantity: 13, RemainingQty: 13, StopLossOrderID: "stop-1", TakeProfitOrderID: "tp-1", AgentStrategy: "mean-rev-rsi2"}
	injectPosition(pm, pos)

	if err := pm.CloseManagedPosition(context.Background(), pos.ID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pos.Status != "CLOSED" {
		t.Errorf("status = %q, want CLOSED", pos.Status)
	}
	if pos.ClosedAt == nil {
		t.Error("ClosedAt not set")
	}
	if trading.placeCalls != 1 {
		t.Errorf("placeCalls = %d, want 1", trading.placeCalls)
	}
	if len(trading.placedOrders) != 1 || trading.placedOrders[0].Strategy != "mean-rev-rsi2" {
		t.Errorf("exit order missing strategy tag: %+v", trading.placedOrders)
	}
	if !trading.contains("stop-1") || !trading.contains("tp-1") {
		t.Errorf("bracket not fully cancelled: canceled=%v", trading.canceled)
	}
}

// A PENDING position closes by cancelling the entry order; no exit order is placed.
func TestClose_Pending_CancelsEntry_NoExitOrder(t *testing.T) {
	trading := &closeStubTrading{stubTrading: &stubTrading{}}
	pm := newReconcilePM(t, trading)
	pos := &ManagedPosition{Symbol: "WMT", Side: "buy", Status: "PENDING", Quantity: 42, RemainingQty: 42, EntryOrderID: "entry-1"}
	injectPosition(pm, pos)

	if err := pm.CloseManagedPosition(context.Background(), pos.ID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if pos.Status != "CLOSED" {
		t.Errorf("status = %q, want CLOSED", pos.Status)
	}
	if trading.placeCalls != 0 {
		t.Errorf("placeCalls = %d, want 0 (no exit order for a pending close)", trading.placeCalls)
	}
	if !trading.contains("entry-1") {
		t.Errorf("entry order not cancelled: canceled=%v", trading.canceled)
	}
}

// Fail-closed for PENDING: if the entry-cancel errors, the entry could still
// fill, so the position must NOT be marked CLOSED.
func TestClose_Pending_CancelFails_StaysPending(t *testing.T) {
	trading := &closeStubTrading{stubTrading: &stubTrading{}, cancelErr: errors.New("alpaca 429 rate limited")}
	pm := newReconcilePM(t, trading)
	pos := &ManagedPosition{Symbol: "WMT", Side: "buy", Status: "PENDING", Quantity: 42, RemainingQty: 42, EntryOrderID: "entry-1"}
	injectPosition(pm, pos)

	err := pm.CloseManagedPosition(context.Background(), pos.ID)
	if err == nil {
		t.Fatal("expected error when entry cancel fails, got nil")
	}
	if pos.Status != "PENDING" {
		t.Errorf("status = %q, want PENDING (failed entry-cancel must not mark CLOSED)", pos.Status)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./services/ -run TestClose -v`
Expected: `TestClose_ExitOrderFails_StaysActiveAndErrors` FAILS (current code returns nil + marks CLOSED + cancels stop-1) and `TestClose_Pending_CancelFails_StaysPending` FAILS (current code ignores cancel error and marks CLOSED). The two success-path tests may pass or fail depending on current ordering — they lock in correct behavior post-fix.

---

### Task 2: Implement fail-closed CloseManagedPosition

**Files:**
- Modify: `services/position_manager.go` (replace the body of `CloseManagedPosition`, ~959–1043; add `cancelBracketOrders` helper)

- [ ] **Step 1: Replace the `CloseManagedPosition` function**

Replace the entire existing `CloseManagedPosition` function (from its doc comment through its closing brace) with:

```go
// CloseManagedPosition manually closes a managed position.
//
// Fail-closed: a position is marked CLOSED only after the broker action that
// actually flattens it is confirmed *placed*. For an open position that means
// the market exit order; for a PENDING (unfilled) position it means the entry
// cancel. If that action errors, the position is left fully intact and an error
// is returned — we never write a CLOSED ledger row over a still-held broker
// position. That desync is what stranded Coil's UNH/ADI on 2026-05-26: a failed
// exit during a rate-limit storm left the broker holding shares (and, because
// the old code cancelled the stop first, unprotected) while the ledger said
// CLOSED.
func (pm *PositionManager) CloseManagedPosition(ctx context.Context, positionID string) error {
	pm.mu.RLock()
	position, exists := pm.positions[positionID]
	pm.mu.RUnlock()
	if !exists {
		return fmt.Errorf("position not found: %s", positionID)
	}

	switch position.Status {
	case "ACTIVE", "PARTIAL":
		// Exit FIRST, before touching the protective bracket. If it can't be
		// placed, bail with the bracket untouched — position stays ACTIVE and
		// protected, caller retries.
		if position.RemainingQty > 0 {
			exitSide := "sell"
			if position.Side == "sell" {
				exitSide = "buy"
			}
			exitOrder := &interfaces.Order{
				Symbol:      position.Symbol,
				Qty:         position.RemainingQty,
				Side:        exitSide,
				Type:        "market",
				TimeInForce: "day",
				Status:      "pending",
				SubmittedAt: time.Now(),
				// Tag with the owning agent's strategy so the resulting DBOrder
				// is attributable (matches placeEntryOrder / flattenUnprotected).
				Strategy: position.AgentStrategy,
			}
			result, err := pm.tradingService.PlaceOrder(ctx, exitOrder)
			if err != nil {
				pm.logger.WithError(err).WithFields(logrus.Fields{
					"position_id":              position.ID,
					"symbol":                   position.Symbol,
					"operator_review_required": true,
				}).Error("Close failed: exit order placement failed — position left open and protected (NOT marked CLOSED)")
				return fmt.Errorf("close %s: exit order placement failed, position remains open: %w", position.Symbol, err)
			}

			// Exit accepted — persist it for attribution (best-effort), then
			// tear down the now-redundant protective/partial orders.
			exitOrder.ID = result.OrderID
			exitOrder.Status = result.Status
			if pm.storageService != nil {
				if saveErr := pm.storageService.SaveOrder(exitOrder); saveErr != nil {
					pm.logger.WithError(saveErr).WithField("order_id", result.OrderID).Warn("Failed to save exit order to database")
				}
			}
			pm.logger.WithFields(logrus.Fields{
				"position_id": position.ID,
				"order_id":    result.OrderID,
				"quantity":    position.RemainingQty,
			}).Info("Placed market exit order")
		}
		pm.cancelBracketOrders(ctx, position)

	case "PENDING":
		// Entry never filled — cancel the entry order. Fail-closed: if the
		// cancel errors, the entry can still fill and become an orphan, so do
		// NOT mark CLOSED.
		if position.EntryOrderID != "" {
			if err := pm.tradingService.CancelOrder(ctx, position.EntryOrderID); err != nil {
				pm.logger.WithError(err).WithFields(logrus.Fields{
					"position_id":              position.ID,
					"symbol":                   position.Symbol,
					"operator_review_required": true,
				}).Error("Close failed: could not cancel pending entry order — position left PENDING (NOT marked CLOSED)")
				return fmt.Errorf("close %s: pending entry cancel failed, position remains pending: %w", position.Symbol, err)
			}
			pm.logger.WithField("order_id", position.EntryOrderID).Info("Cancelled pending entry order")
		}

	default:
		// CLOSED / STOPPED_OUT / FAILED — already terminal. Idempotent no-op so
		// a double-close can't place a spurious order.
		pm.logger.WithFields(logrus.Fields{
			"position_id": position.ID,
			"status":      position.Status,
		}).Debug("CloseManagedPosition called on a terminal position — no-op")
		return nil
	}

	pm.mu.Lock()
	position.Status = "CLOSED"
	now := time.Now()
	position.ClosedAt = &now
	position.UpdatedAt = now
	pm.mu.Unlock()

	if err := pm.savePositionToDB(position); err != nil {
		pm.logger.WithError(err).WithFields(logrus.Fields{
			"position_id":              positionID,
			"operator_review_required": true,
		}).Error("Failed to persist CLOSED status after close — may resurrect on reload")
	}

	pm.logger.WithField("position_id", positionID).Info("Position manually closed")
	return nil
}

// cancelBracketOrders cancels a position's stop-loss, take-profit, and any
// partial-exit orders, best-effort. Called only after the exit order has been
// placed, so cancel errors are non-fatal — the orders may already be filled or
// cancelled, and the exit is already in flight.
func (pm *PositionManager) cancelBracketOrders(ctx context.Context, position *ManagedPosition) {
	if position.StopLossOrderID != "" {
		if err := pm.tradingService.CancelOrder(ctx, position.StopLossOrderID); err != nil {
			pm.logger.WithError(err).WithField("order_id", position.StopLossOrderID).Warn("Failed to cancel stop loss order (may already be filled/cancelled)")
		}
	}
	if position.TakeProfitOrderID != "" {
		if err := pm.tradingService.CancelOrder(ctx, position.TakeProfitOrderID); err != nil {
			pm.logger.WithError(err).WithField("order_id", position.TakeProfitOrderID).Warn("Failed to cancel take profit order (may already be filled/cancelled)")
		}
	}
	for _, orderID := range position.PartialExitOrders {
		if err := pm.tradingService.CancelOrder(ctx, orderID); err != nil {
			pm.logger.WithError(err).WithField("order_id", orderID).Warn("Failed to cancel partial exit order (may already be cancelled)")
		}
	}
}
```

Note vs. old behavior: (1) the entry-order cancel that the old code ran for *every* status is dropped from the ACTIVE/PARTIAL path (an ACTIVE position's entry is already filled — cancel was a no-op) and handled explicitly in the PENDING branch; (2) terminal statuses are now an idempotent no-op instead of a re-CLOSE.

- [ ] **Step 2: Run the close tests to verify they pass**

Run: `go test ./services/ -run TestClose -v`
Expected: all four `TestClose_*` PASS.

---

### Task 3: Full regression + commit

- [ ] **Step 1: Run the full services suite**

Run: `go test ./services/...`
Expected: PASS (no existing test relied on close-despite-error; the only production caller, `HandleCloseManagedPosition`, already handles a returned error as HTTP 500).

- [ ] **Step 2: Build to confirm no compile breakage**

Run: `go build ./...`
Expected: clean build.

- [ ] **Step 3: Commit (single squashed commit per repo convention)**

```bash
git checkout -b close-managed-position-fail-closed
git add services/position_manager.go services/position_manager_close_test.go
git commit -m "fix: CloseManagedPosition fail-closed so a failed exit can't orphan a position

CloseManagedPosition marked a position CLOSED even when the exit order
failed to place (and after it had already cancelled the protective stop),
leaving the broker holding unprotected shares while the ledger said CLOSED.
This stranded Coil's UNH/ADI on 2026-05-26 during a 429 storm and surfaced
as a cross-agent reconciliation mismatch on the shared account.

Now exit-first and fail-closed: place the market exit before tearing down
the bracket; on failure leave the position ACTIVE + protected and return an
error (caller/agent retries). PENDING closes only after the entry cancel
succeeds. Exit orders are now strategy-tagged and persisted for attribution.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** Root-cause defect (unconditional CLOSED on failed exit) → Task 2 ACTIVE/PARTIAL branch + Task 1 `TestClose_ExitOrderFails`. Same-class PENDING defect → PENDING branch + `TestClose_Pending_CancelFails`. Attribution gap (untagged/unsaved exit order) → `Strategy` tag + `SaveOrder` in Task 2, asserted in `TestClose_ExitOrderSucceeds`. Caller impact → documented (controller already returns 500).
- **Placeholder scan:** none — all code and commands are concrete.
- **Type consistency:** `closeStubTrading` embeds `*stubTrading` (trade_guard_test.go:31); `newReconcilePM`/`injectPosition` from position_manager_reconcile_test.go; `interfaces.Order{Strategy,...}`, `interfaces.OrderResult{OrderID,Status}`, `ManagedPosition` fields, `pm.savePositionToDB`, `pm.storageService.GetManagedPosition`/`SaveOrder` all match existing signatures in `services/position_manager.go`.

## Out of scope (follow-ups, not this plan)

- **Orphan detector (defense-in-depth):** extend `reconcileWithBroker` to detect the *orphan-broker* direction (broker holds qty with no ACTIVE managed record) and emit an operator alert, instead of relying on each agent's LLM rules-prose check. Larger change; separate plan.
- **Stale entry-order status:** entry buy-order DB rows stay `pending_new`/`filled_qty=0` after the fill (status never reconciled). Separate bookkeeping fix.
- **Live UNH orphan:** operator is handling manually (flatten + cancel any stale stop). Not a code task.
