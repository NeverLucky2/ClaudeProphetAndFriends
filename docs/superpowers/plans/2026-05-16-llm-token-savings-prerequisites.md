# LLM Token-Savings — Shared Prerequisites

Cross-cutting prerequisites for the four LLM-token-savings plans:

- `2026-05-16-penny-social-exit-timer.md`
- `2026-05-16-beat-context-bundle.md`
- `2026-05-16-harvest-exit-monitor.md`
- `2026-05-16-turtle-go-scheduler.md`

Each plan references this doc instead of re-deriving the verified facts below.

---

## Verified trading-service API surface

`services/alpaca_trading.go` exposes these public methods (verified 2026-05-16). The plans must use these signatures verbatim — no `PlaceMarketOrder` / `PlaceLimitOrder` / `GetOrderStatus` convenience shortcuts exist.

```go
// Place a stock order (market or limit). Strategy attribution is encoded
// into client_order_id when order.Strategy is non-empty.
func (s *AlpacaTradingService) PlaceOrder(
    ctx context.Context, order *interfaces.Order,
) (*interfaces.OrderResult, error)

// Cancel an order by broker-assigned ID.
func (s *AlpacaTradingService) CancelOrder(ctx context.Context, orderID string) error

// Fetch a single order (use .Status, .FilledQty, .FilledAvgPrice).
func (s *AlpacaTradingService) GetOrder(ctx context.Context, orderID string) (*interfaces.Order, error)

// List orders, optional status filter ("open" / "closed" / "all").
func (s *AlpacaTradingService) ListOrders(ctx context.Context, status string) ([]*interfaces.Order, error)

// List all positions (no strategy filter at this layer — strategy filtering
// lives on the /api/v1/positions?strategy=X HTTP handler).
func (s *AlpacaTradingService) GetPositions(ctx context.Context) ([]*interfaces.Position, error)

// Fetch the account (use .PortfolioValue, .Cash, .BuyingPower).
func (s *AlpacaTradingService) GetAccount(ctx context.Context) (*interfaces.Account, error)

// Place a 4-leg iron condor combo. Used by HarvestCloser.
func (s *AlpacaTradingService) PlaceMultiLegOrder(ctx context.Context, order MultiLegOrder) (string, error)
```

The `interfaces.Order` struct used as input to `PlaceOrder`:

```go
// From interfaces/. Key fields the plans construct manually:
type Order struct {
    Symbol      string
    Qty         float64
    Side        string  // "buy" | "sell"
    Type        string  // "market" | "limit" | "stop" | "stop_limit"
    TimeInForce string  // "day" | "gtc" | "ioc" | "fok"
    LimitPrice  *float64
    StopPrice   *float64
    Strategy    string  // attribution tag, e.g. "trend" / "penny-momentum"
    // Read-only after placement:
    Status         string
    FilledQty      float64
    FilledAvgPrice *float64
    ClientOrderID  string
}
```

### Helper for the plans

Where a plan says "place a market sell for N shares of SYM with strategy tag T", the implementation is:

```go
res, err := tradingService.PlaceOrder(ctx, &interfaces.Order{
    Symbol: sym, Qty: float64(n), Side: "sell",
    Type: "market", TimeInForce: "day", Strategy: t,
})
// res.OrderID is the broker order ID; persist it.
```

For a limit order with strategy tagging:

```go
limit := lastClose * 1.005
res, err := tradingService.PlaceOrder(ctx, &interfaces.Order{
    Symbol: sym, Qty: float64(n), Side: "buy",
    Type: "limit", TimeInForce: "day",
    LimitPrice: &limit, Strategy: "trend",
})
```

For polling order fill status:

```go
ord, err := tradingService.GetOrder(ctx, orderID)
if err != nil { /* handle */ }
switch ord.Status {
case "filled":      // ord.FilledQty, *ord.FilledAvgPrice are populated
case "partially_filled":
case "canceled", "expired":
case "new", "accepted", "pending_new", "accepted_for_bidding":
    // still working
}
```

---

## Strategy rule loading — `rulesFile` is authoritative

`agent/harness.js:68-80` reads rules in this order:

1. `agentConfig.customStrategyRules` (per-agent override)
2. `strategy.rulesFile` → read the `.md` file from disk
3. `strategy.customRules` (JSON inline fallback)

In `data/agent-config.json`, **all four production strategies have `rulesFile` set** (`TRADING_RULES_HARVEST.md`, `TRADING_RULES_V2.md`, `TRADING_RULES_PENNY.md`, `TRADING_RULES_TREND.md`) — so the markdown files are the live source of truth.

The `customRules` JSON content present on `v2-options` and `penny-momentum` strategies is a **dormant fallback** that only activates if the corresponding `.md` file fails to load. Editing it has no runtime effect.

**Consequence for the plans:** rules edits go into the `.md` files only. The TRADING_RULES_PENNY.md preamble (lines 3-9) that says "authoritative copy lives inline in `data/agent-config.json`" is stale and should be deleted in passing.

---

## Recommended execution order

Each plan adds its own env flag (`HARVEST_EXIT_MONITOR_ENABLED`, `TURTLE_SCHEDULER_ENABLED`, `BEAT_CONTEXT_ENABLED`) and is independently revertible. But three of the four touch `cmd/bot/main.go` and two touch `agent/preflight.js` — running them in **parallel branches** invites merge conflicts.

Implement sequentially on the same trunk in this order:

1. **Penny social-exit timer** — smallest blast radius, no `cmd/bot/main.go` changes worth speaking of, no preflight changes. Validates the "Go service replaces an LLM-driven timer" pattern.
2. **Beat-context bundle** — biggest token savings per LOC, applies to all four agents. One controller add to `main.go`. No preflight changes. Default-on env flag `BEAT_CONTEXT_ENABLED=true` with opt-out.
3. **Harvest exit monitor** — one preflight branch, one `main.go` block. Larger but contained to one agent.
4. **Turtle Go scheduler** — biggest implementation, simplest substitution (1 LLM beat/day → 0). Do last because all the patterns (Go strategy execution + status endpoint + preflight skip-by-flag) are already proven by the earlier plans.

---

## Strategy attribution invariants (do not break)

All four plans place orders on the operator's shared Alpaca paper account. `PlaceOrder` and `PlaceMultiLegOrder` already encode `order.Strategy` into the broker `client_order_id` as `"{strategy}:{uuid}"`. Every order placed by:

- Penny social-exit market sell → `Strategy: "penny-momentum"`
- Harvest close (single leg or combo) → `Strategy: "harvest"`
- Turtle entry/exit → `Strategy: "trend"`

This is how `/api/v1/positions?strategy=X`, the segment-PnL service, and the preflight position counts attribute correctly. Forgetting the tag silently breaks all four downstream consumers. **Every order-placing step in every plan must set `Strategy:`.**

---

## Soft-fail philosophy (consistent across all four)

Per `memory/architectural-patterns.md`'s dual-layer policy:

- **Preflight (Go-side)** fails OPEN — endpoint errors → run the LLM beat anyway.
- **Rules-side (LLM)** fails CLOSED — tool errors on critical gates → no new entries.
- **New Go services in these plans** fail OPEN for *information* fetches (e.g., beat-context bundle missing → harness proceeds), but the Go service itself is the new authority for the actions it takes (Penny social-exit, Harvest close, Turtle place_order). When *its own* inputs are degraded (e.g., HarvestPricer can't get a leg's mid), it skips the tick and logs — never closes/opens blind.

Every error path in every plan should land in one of these two columns; if it doesn't, that's a bug.
