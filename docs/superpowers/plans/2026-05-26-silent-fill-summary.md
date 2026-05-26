# Silent-Fill Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface broker-side order fills that land between an agent's sparse LLM beats as a non-LLM, one-line terminal recap — shown on agent start and on dashboard open.

**Architecture:** A pure Go function groups *filled* orders by strategy tag (`SummarizeFills`), exposed via `GET /api/v1/fills/summary`. A soft-fail Node module (`agent/fills-summary.js`) fetches it and renders a single recap line. Two triggers emit that line: `harness.start()` (after "Agent started") and the `/api/events` SSE handler (to the connecting client only). Display-only; current-ET-day window; covers Coil/Drift/Turtle/Harvest via strategy tag.

**Tech Stack:** Go (gin, Alpaca SDK via `interfaces.TradingService`), Node ESM (`node:test`), SSE.

**Spec:** `docs/superpowers/specs/2026-05-26-silent-fill-summary-design.md`

---

## File Structure

- **Create** `services/fills_summary.go` — `FillItem`, `FillsSummary` types + pure `SummarizeFills(orders, strategy, since)`.
- **Create** `services/fills_summary_test.go` — table tests for `SummarizeFills`.
- **Modify** `controllers/order_controller.go` — add `HandleFillsSummary` + unexported `startOfEtTradingDay(now)` helper.
- **Modify** `controllers/order_controller_test.go` — extend `recordingTradingService` with a `ListOrders` fixture; add `TestHandleFillsSummary` + `TestStartOfEtTradingDay`.
- **Modify** `cmd/bot/main.go` — register `GET /fills/summary`.
- **Create** `agent/fills-summary.js` — `fetchFillsSummary`, `renderFillsSummaryLine`, `startOfEtTradingDayIso`.
- **Create** `agent/fills-summary.test.mjs` — `node:test` for the three exports.
- **Modify** `agent/harness.js` — import the module, add `_emitFillsSummary()`, call it in `start()`.
- **Modify** `agent/harness.test.mjs` — test `_emitFillsSummary()` emit / no-emit.
- **Modify** `agent/server.js` — import the module, add `emitConnectFillsSummaries(res)`, call it in `/api/events`.
- **Modify** `.env.example` — document `FILLS_SUMMARY_ENABLED`.

---

## Task 1: Go pure `SummarizeFills`

**Files:**
- Create: `services/fills_summary.go`
- Test: `services/fills_summary_test.go`

- [ ] **Step 1: Write the failing test**

Create `services/fills_summary_test.go`:

```go
package services

import (
	"testing"
	"time"

	"prophet-trader/interfaces"
)

// ptr returns a pointer to f — Order.FilledAvgPrice is *float64.
func ptrF(f float64) *float64 { return &f }

// mkOrder builds a minimal interfaces.Order for SummarizeFills tests.
func mkOrder(symbol, side, status, clientOrderID string, qty float64, avg *float64, filledAt *time.Time) *interfaces.Order {
	return &interfaces.Order{
		Symbol:         symbol,
		Side:           side,
		Status:         status,
		ClientOrderID:  clientOrderID,
		Strategy:       interfaces.ParseStrategyFromClientOrderID(clientOrderID),
		FilledQty:      qty,
		FilledAvgPrice: avg,
		FilledAt:       filledAt,
	}
}

func TestSummarizeFills(t *testing.T) {
	since := time.Date(2026, 5, 26, 4, 0, 0, 0, time.UTC) // ~midnight ET
	t0 := since.Add(6 * time.Hour)                        // 10:00 ET
	t1 := since.Add(7 * time.Hour)                        // 11:00 ET
	before := since.Add(-2 * time.Hour)                   // prior session

	orders := []*interfaces.Order{
		mkOrder("AAPL", "buy", "filled", "mean-rev-rsi2:u1", 12, ptrF(184.20), &t1),
		mkOrder("MSFT", "buy", "filled", "mean-rev-rsi2:u2", 8, ptrF(402.10), &t0),
		mkOrder("NKE", "sell", "filled", "mean-rev-rsi2:u3", 15, nil, &t0),       // nil avg → 0
		mkOrder("TSLA", "buy", "filled", "turtle-trend:u4", 3, ptrF(250.0), &t0), // other strategy
		mkOrder("GOOG", "buy", "canceled", "mean-rev-rsi2:u5", 5, nil, &t0),      // not filled
		mkOrder("AMZN", "buy", "filled", "mean-rev-rsi2:u6", 4, ptrF(180.0), &before), // before since
		mkOrder("META", "buy", "filled", "mean-rev-rsi2:u7", 2, ptrF(500.0), nil),     // nil FilledAt
		nil, // defensive: nil entry
	}

	got := SummarizeFills(orders, "mean-rev-rsi2", since)

	if got.Count != 3 {
		t.Fatalf("Count = %d, want 3 (AAPL, MSFT, NKE)", got.Count)
	}
	if got.Strategy != "mean-rev-rsi2" {
		t.Errorf("Strategy = %q, want mean-rev-rsi2", got.Strategy)
	}
	// Sorted ascending by FilledAt: MSFT(t0), NKE(t0), AAPL(t1). t0 ties keep input order.
	if got.Fills[len(got.Fills)-1].Symbol != "AAPL" {
		t.Errorf("last fill = %q, want AAPL (latest FilledAt)", got.Fills[len(got.Fills)-1].Symbol)
	}
	// NKE had nil avg price → 0.
	for _, f := range got.Fills {
		if f.Symbol == "NKE" && f.AvgPrice != 0 {
			t.Errorf("NKE AvgPrice = %v, want 0 (nil source)", f.AvgPrice)
		}
		if f.Symbol == "MSFT" && (f.Qty != 8 || f.AvgPrice != 402.10 || f.Side != "buy") {
			t.Errorf("MSFT mapped wrong: %+v", f)
		}
	}
}

func TestSummarizeFills_EmptyStrategyMatchesAll(t *testing.T) {
	since := time.Date(2026, 5, 26, 4, 0, 0, 0, time.UTC)
	at := since.Add(time.Hour)
	orders := []*interfaces.Order{
		mkOrder("AAPL", "buy", "filled", "mean-rev-rsi2:u1", 1, ptrF(1), &at),
		mkOrder("TSLA", "buy", "filled", "turtle-trend:u2", 1, ptrF(1), &at),
		mkOrder("BARE", "buy", "filled", "", 1, ptrF(1), &at), // untagged
	}
	got := SummarizeFills(orders, "", since)
	if got.Count != 3 {
		t.Fatalf("Count = %d, want 3 (empty strategy matches all filled)", got.Count)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run TestSummarizeFills`
Expected: FAIL — `undefined: SummarizeFills` (compile error).

- [ ] **Step 3: Write minimal implementation**

Create `services/fills_summary.go`:

```go
package services

import (
	"sort"
	"time"

	"prophet-trader/interfaces"
)

// FillItem is a single filled order in a FillsSummary.
type FillItem struct {
	Symbol   string    `json:"symbol"`
	Side     string    `json:"side"` // "buy" | "sell"
	Qty      float64   `json:"qty"`
	AvgPrice float64   `json:"avg_price"`
	FilledAt time.Time `json:"filled_at"`
}

// FillsSummary is the response payload for GET /api/v1/fills/summary.
type FillsSummary struct {
	Strategy string     `json:"strategy"`
	Since    time.Time  `json:"since"`
	Count    int        `json:"count"`
	Fills    []FillItem `json:"fills"`
}

// SummarizeFills keeps orders that filled at/after `since` and, when `strategy`
// is non-empty, whose strategy tag matches. The tag is read from Order.Strategy,
// falling back to parsing ClientOrderID. Empty `strategy` matches every filled
// order (tagged or not). Non-"filled" status, nil FilledAt, and FilledAt before
// `since` are skipped. A nil FilledAvgPrice renders as 0. Result is sorted
// ascending by FilledAt.
func SummarizeFills(orders []*interfaces.Order, strategy string, since time.Time) FillsSummary {
	summary := FillsSummary{
		Strategy: strategy,
		Since:    since,
		Fills:    make([]FillItem, 0),
	}
	for _, o := range orders {
		if o == nil || o.Status != "filled" || o.FilledAt == nil || o.FilledAt.Before(since) {
			continue
		}
		tag := o.Strategy
		if tag == "" {
			tag = interfaces.ParseStrategyFromClientOrderID(o.ClientOrderID)
		}
		if strategy != "" && tag != strategy {
			continue
		}
		avg := 0.0
		if o.FilledAvgPrice != nil {
			avg = *o.FilledAvgPrice
		}
		summary.Fills = append(summary.Fills, FillItem{
			Symbol:   o.Symbol,
			Side:     o.Side,
			Qty:      o.FilledQty,
			AvgPrice: avg,
			FilledAt: *o.FilledAt,
		})
	}
	sort.SliceStable(summary.Fills, func(i, j int) bool {
		return summary.Fills[i].FilledAt.Before(summary.Fills[j].FilledAt)
	})
	summary.Count = len(summary.Fills)
	return summary
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run TestSummarizeFills`
Expected: PASS (both `TestSummarizeFills` and `TestSummarizeFills_EmptyStrategyMatchesAll`).

- [ ] **Step 5: Commit**

```bash
git add services/fills_summary.go services/fills_summary_test.go
git commit -m "feat(go): pure SummarizeFills for filled-order recap"
```

---

## Task 2: Go endpoint `HandleFillsSummary` + route

**Files:**
- Modify: `controllers/order_controller.go` (add method + helper)
- Modify: `controllers/order_controller_test.go` (extend stub + add tests)
- Modify: `cmd/bot/main.go:645` area (register route)

- [ ] **Step 1: Extend the test stub to return a ListOrders fixture**

In `controllers/order_controller_test.go`, the shared `recordingTradingService.ListOrders` currently returns `nil, nil`. Add two fields and use them. Replace this method:

```go
func (r *recordingTradingService) ListOrders(_ context.Context, _ string) ([]*interfaces.Order, error) {
	return nil, nil
}
```

with:

```go
func (r *recordingTradingService) ListOrders(_ context.Context, _ string) ([]*interfaces.Order, error) {
	return r.listOrdersResult, r.listOrdersErr
}
```

And add the two fields to the `recordingTradingService` struct (alongside the existing fields):

```go
	listOrdersResult []*interfaces.Order
	listOrdersErr    error
```

(Existing tests leave both zero-valued, so they still see `nil, nil` — behavior unchanged.)

- [ ] **Step 2: Write the failing tests**

Append to `controllers/order_controller_test.go`:

```go
// TestHandleFillsSummary verifies the endpoint passes the strategy + since
// filters through to SummarizeFills and returns the JSON summary.
func TestHandleFillsSummary(t *testing.T) {
	gin.SetMode(gin.TestMode)

	since := time.Date(2026, 5, 26, 4, 0, 0, 0, time.UTC)
	filledAt := since.Add(6 * time.Hour)
	avg := 184.20
	trading := &recordingTradingService{
		listOrdersResult: []*interfaces.Order{
			{Symbol: "AAPL", Side: "buy", Status: "filled", ClientOrderID: "mean-rev-rsi2:u1",
				Strategy: "mean-rev-rsi2", FilledQty: 12, FilledAvgPrice: &avg, FilledAt: &filledAt},
			{Symbol: "TSLA", Side: "buy", Status: "filled", ClientOrderID: "turtle-trend:u2",
				Strategy: "turtle-trend", FilledQty: 3, FilledAvgPrice: &avg, FilledAt: &filledAt},
		},
	}
	oc := NewOrderController(trading, nil, noopStorage{})

	router := gin.New()
	router.GET("/api/v1/fills/summary", oc.HandleFillsSummary)

	url := "/api/v1/fills/summary?strategy=mean-rev-rsi2&since=" + since.Format(time.RFC3339)
	req := httptest.NewRequest(http.MethodGet, url, nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d (body=%s)", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, `"count":1`) {
		t.Errorf("want count 1 (only the mean-rev fill), got body=%s", body)
	}
	if !strings.Contains(body, `"symbol":"AAPL"`) || strings.Contains(body, "TSLA") {
		t.Errorf("want AAPL only, not TSLA; body=%s", body)
	}
}

func TestHandleFillsSummary_ListOrdersError(t *testing.T) {
	gin.SetMode(gin.TestMode)
	trading := &recordingTradingService{listOrdersErr: errors.New("alpaca down")}
	oc := NewOrderController(trading, nil, noopStorage{})

	router := gin.New()
	router.GET("/api/v1/fills/summary", oc.HandleFillsSummary)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/fills/summary?strategy=x", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status: want 500 on ListOrders error, got %d", w.Code)
	}
}

// TestStartOfEtTradingDay pins midnight-ET semantics without hardcoding offsets.
func TestStartOfEtTradingDay(t *testing.T) {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatalf("tzdata unavailable: %v", err)
	}
	now := time.Date(2026, 5, 26, 18, 30, 0, 0, time.UTC) // 14:30 ET (EDT)
	got := startOfEtTradingDay(now)
	et := got.In(loc)
	if et.Hour() != 0 || et.Minute() != 0 || et.Second() != 0 {
		t.Errorf("not midnight ET: %s", et)
	}
	if et.Year() != 2026 || et.Month() != time.May || et.Day() != 26 {
		t.Errorf("wrong ET date: %s, want 2026-05-26", et)
	}
}
```

`errors` and `strings` are already imported in this test file.

- [ ] **Step 3: Run tests to verify they fail**

Run: `go test ./controllers/ -run "TestHandleFillsSummary|TestStartOfEtTradingDay"`
Expected: FAIL — `oc.HandleFillsSummary undefined` and `undefined: startOfEtTradingDay`.

- [ ] **Step 4: Implement the handler + helper**

In `controllers/order_controller.go`, add these two functions (e.g., right after `HandleGetOrders`). No new imports needed — `context`, `time`, `services`, `gin` are already imported.

```go
// HandleFillsSummary returns a recap of filled orders for the current ET trading
// day (or since the optional `since` RFC3339 param), attributed by strategy tag.
// Powers the non-LLM fills recap shown in the agent terminal on start and on
// dashboard open. GET /api/v1/fills/summary?strategy=<id>&since=<RFC3339>
func (oc *OrderController) HandleFillsSummary(c *gin.Context) {
	strategy := c.Query("strategy")

	since := startOfEtTradingDay(time.Now())
	if raw := c.Query("since"); raw != "" {
		if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
			since = parsed
		}
	}

	orders, err := oc.tradingService.ListOrders(context.Background(), "closed")
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, services.SummarizeFills(orders, strategy, since))
}

// startOfEtTradingDay returns 00:00 America/New_York for the ET calendar date of
// `now`. Default `since` anchor when no param is supplied. Node always passes an
// explicit `since`, so this is a safety net; on tzdata failure it falls back to
// UTC-day midnight to stay total.
func startOfEtTradingDay(now time.Time) time.Time {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		y, m, d := now.UTC().Date()
		return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
	}
	et := now.In(loc)
	y, m, d := et.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, loc)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./controllers/ -run "TestHandleFillsSummary|TestStartOfEtTradingDay"`
Expected: PASS (3 tests).

- [ ] **Step 6: Register the route**

In `cmd/bot/main.go`, find the order-endpoints block (around line 645):

```go
		api.GET("/orders", orderController.HandleGetOrders)
```

Add directly beneath it:

```go
		api.GET("/fills/summary", orderController.HandleFillsSummary)
```

- [ ] **Step 7: Verify the whole Go build + suite**

Run: `go build ./... && go test ./controllers/ ./services/`
Expected: build succeeds; all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add controllers/order_controller.go controllers/order_controller_test.go cmd/bot/main.go
git commit -m "feat(go): GET /api/v1/fills/summary endpoint"
```

---

## Task 3: Node `agent/fills-summary.js`

**Files:**
- Create: `agent/fills-summary.js`
- Test: `agent/fills-summary.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `agent/fills-summary.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderFillsSummaryLine,
  fetchFillsSummary,
  startOfEtTradingDayIso,
} from './fills-summary.js';

const mk = (overrides = {}) => ({
  strategy: 'mean-rev-rsi2',
  count: 1,
  fills: [{ symbol: 'AAPL', side: 'buy', qty: 12, avg_price: 184.2, filled_at: '2026-05-26T14:14:00Z' }],
  ...overrides,
});

test('renderFillsSummaryLine returns empty for null / zero', () => {
  assert.equal(renderFillsSummaryLine(null, 'Coil'), '');
  assert.equal(renderFillsSummaryLine(mk({ count: 0, fills: [] }), 'Coil'), '');
});

test('renderFillsSummaryLine renders a single fill', () => {
  const line = renderFillsSummaryLine(mk(), 'Coil');
  assert.match(line, /^Coil — 1 fill today \(broker-side, no LLM beat\): BUY 12 AAPL @ \$184\.20 \(\d{2}:\d{2} ET\)$/);
});

test('renderFillsSummaryLine pluralizes and joins multiple', () => {
  const summary = mk({
    count: 2,
    fills: [
      { symbol: 'AAPL', side: 'buy', qty: 12, avg_price: 184.2, filled_at: '2026-05-26T14:14:00Z' },
      { symbol: 'NKE', side: 'sell', qty: 15, avg_price: 0, filled_at: '2026-05-26T17:40:00Z' },
    ],
  });
  const line = renderFillsSummaryLine(summary, 'Coil');
  assert.match(line, /2 fills today/);
  assert.match(line, /BUY 12 AAPL @ \$184\.20/);
  assert.match(line, /SELL 15 NKE \(\d{2}:\d{2} ET\)/); // avg_price 0 → no price
  assert.match(line, / · /);
});

test('renderFillsSummaryLine caps the list at 10 with "+N more"', () => {
  const fills = Array.from({ length: 13 }, (_, i) => ({
    symbol: `S${i}`, side: 'buy', qty: 1, avg_price: 1, filled_at: '2026-05-26T14:14:00Z',
  }));
  const line = renderFillsSummaryLine(mk({ count: 13, fills }), 'Turtle');
  assert.match(line, /13 fills today/);
  assert.match(line, /\+3 more$/);
});

test('fetchFillsSummary returns null on missing goAxios or strategy', async () => {
  assert.equal(await fetchFillsSummary(null, 'x', 'since'), null);
  assert.equal(await fetchFillsSummary({ get: async () => ({ data: {} }) }, '', 'since'), null);
});

test('fetchFillsSummary returns data on success and null on throw', async () => {
  const ok = { get: async () => ({ data: mk() }) };
  assert.deepEqual(await fetchFillsSummary(ok, 'mean-rev-rsi2', 'since'), mk());
  const bad = { get: async () => { throw new Error('boom'); } };
  assert.equal(await fetchFillsSummary(bad, 'mean-rev-rsi2', 'since'), null);
});

test('startOfEtTradingDayIso is midnight ET for the date (EDT and EST)', () => {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const check = (utcInput, expectDate) => {
    const iso = startOfEtTradingDayIso(new Date(utcInput));
    const p = fmt.formatToParts(new Date(iso)).reduce((a, x) => ((a[x.type] = x.value), a), {});
    assert.equal(`${p.year}-${p.month}-${p.day}`, expectDate);
    assert.equal(Number(p.hour) % 24, 0, `hour should be midnight ET, got ${p.hour}`);
    assert.equal(p.minute, '00');
  };
  check('2026-05-26T18:30:00Z', '2026-05-26'); // EDT (UTC-4): 14:30 ET
  check('2026-01-15T18:30:00Z', '2026-01-15'); // EST (UTC-5): 13:30 ET
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test agent/fills-summary.test.mjs`
Expected: FAIL — cannot find module `./fills-summary.js`.

- [ ] **Step 3: Write the implementation**

Create `agent/fills-summary.js`:

```js
// LLM-free fills recap. Fetches the current-ET-day filled-order summary for a
// strategy from the Go backend and renders a one-line terminal recap. Mirrors
// beat-context.js: split fetch + render so both are unit-testable without a live
// backend. Soft-fail throughout — a missing recap never blocks start or an SSE
// connect.

const MAX_LISTED = 10;

// fetchFillsSummary returns the parsed summary, or null on any error / missing
// inputs. 3000ms timeout matches beat-context.js's soft-fail fetch budget.
export async function fetchFillsSummary(goAxios, strategy, since) {
  if (!goAxios || !strategy) return null;
  try {
    const params = new URLSearchParams({ strategy });
    if (since) params.set('since', since);
    const resp = await goAxios.get(`/api/v1/fills/summary?${params.toString()}`, { timeout: 3000 });
    return resp?.data ?? null;
  } catch (_err) {
    return null;
  }
}

// renderFillsSummaryLine returns one terminal line, or '' when there is nothing
// to report (null summary or zero fills — quiet on no-fill days).
export function renderFillsSummaryLine(summary, agentName) {
  if (!summary || !Array.isArray(summary.fills) || !summary.count) return '';
  const name = agentName || 'Agent';
  const shown = summary.fills.slice(0, MAX_LISTED);
  const items = shown.map((f) => {
    const side = String(f.side || '').toUpperCase();
    const px = Number(f.avg_price) ? ` @ $${Number(f.avg_price).toFixed(2)}` : '';
    return `${side} ${formatQty(f.qty)} ${f.symbol}${px} (${formatEtTime(f.filled_at)} ET)`;
  });
  const extra = summary.count - shown.length;
  const tail = extra > 0 ? ` · +${extra} more` : '';
  const noun = summary.count === 1 ? 'fill' : 'fills';
  return `${name} — ${summary.count} ${noun} today (broker-side, no LLM beat): ${items.join(' · ')}${tail}`;
}

// startOfEtTradingDayIso returns the ISO instant for 00:00 America/New_York on
// the ET calendar date of `now`. Computed via Intl so the harness and SSE paths
// share one anchor regardless of the server's own timezone. Pure for testing.
export function startOfEtTradingDayIso(now = new Date()) {
  const tz = 'America/New_York';
  const [y, mo, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now).split('-').map(Number);

  const wp = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now).reduce((a, p) => ((a[p.type] = p.value), a), {});

  // ET wall-clock for `now`, read as if it were UTC, minus the real instant =
  // ET's UTC offset (handles EDT/EST automatically).
  const wallAsUtc = Date.UTC(
    Number(wp.year), Number(wp.month) - 1, Number(wp.day),
    Number(wp.hour) % 24, Number(wp.minute), Number(wp.second),
  );
  const nowMs = Math.floor(now.getTime() / 1000) * 1000;
  const offsetMs = wallAsUtc - nowMs;
  const etMidnightAsUtc = Date.UTC(y, mo - 1, d, 0, 0, 0);
  return new Date(etMidnightAsUtc - offsetMs).toISOString();
}

function formatQty(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n)) return '?';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function formatEtTime(iso) {
  if (!iso) return '??:??';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '??:??';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test agent/fills-summary.test.mjs`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add agent/fills-summary.js agent/fills-summary.test.mjs
git commit -m "feat(agent): fills-summary fetch/render module"
```

---

## Task 4: Harness trigger — emit recap on start

**Files:**
- Modify: `agent/harness.js` (import, `_emitFillsSummary`, call in `start()`)
- Test: `agent/harness.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `agent/harness.test.mjs`:

```js
// Trigger A: harness.start() surfaces broker-side fills that landed since the ET
// open. We test the unit (_emitFillsSummary) directly — it does the fetch +
// render + emit — rather than the full start() path, which needs heavy mocking.
function makeFillsHarness(goAxios, agentConfig = { strategyId: 'mean-rev-rsi2', name: 'Coil' }) {
  const h = new AgentHarness({
    sandboxId: 'sbx_test',
    getRuntime: () => ({ goAxios }),
  });
  h._agentConfig = agentConfig;
  return h;
}

test('_emitFillsSummary emits an agent_log line when there are fills', async () => {
  const goAxios = {
    get: async () => ({
      data: {
        strategy: 'mean-rev-rsi2', count: 1,
        fills: [{ symbol: 'AAPL', side: 'buy', qty: 12, avg_price: 184.2, filled_at: '2026-05-26T14:14:00Z' }],
      },
    }),
  };
  const h = makeFillsHarness(goAxios);
  const logs = [];
  h.state.on('agent_log', (d) => logs.push(d));

  await h._emitFillsSummary();

  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /^Coil — 1 fill today/);
  assert.match(logs[0].message, /AAPL/);
});

test('_emitFillsSummary stays silent on zero fills', async () => {
  const goAxios = { get: async () => ({ data: { strategy: 'mean-rev-rsi2', count: 0, fills: [] } }) };
  const h = makeFillsHarness(goAxios);
  const logs = [];
  h.state.on('agent_log', (d) => logs.push(d));

  await h._emitFillsSummary();

  assert.equal(logs.length, 0);
});

test('_emitFillsSummary soft-fails (no throw, no emit) when the fetch errors', async () => {
  const goAxios = { get: async () => { throw new Error('go down'); } };
  const h = makeFillsHarness(goAxios);
  const logs = [];
  h.state.on('agent_log', (d) => logs.push(d));

  await h._emitFillsSummary(); // must not reject
  assert.equal(logs.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test agent/harness.test.mjs`
Expected: FAIL — `h._emitFillsSummary is not a function`.

- [ ] **Step 3: Add the import**

In `agent/harness.js`, find (line ~13):

```js
import { fetchBeatContext, renderBeatContextBlock } from './beat-context.js';
```

Add directly beneath it:

```js
import { fetchFillsSummary, renderFillsSummaryLine, startOfEtTradingDayIso } from './fills-summary.js';
```

- [ ] **Step 4: Add the `_emitFillsSummary` method**

In `agent/harness.js`, insert this method immediately before `async reloadConfig(options = {}) {`:

```js
  // LLM-free fills recap: fetch the day's broker-side fills for this agent's
  // strategy and emit a one-line agent_log (same pane as "Agent started").
  // Best-effort: any failure is swallowed so it never blocks startup.
  async _emitFillsSummary() {
    try {
      const strategy = this._agentConfig?.strategyId;
      if (!strategy) return;
      const runtime = this.getRuntime ? this.getRuntime(this.sandboxId) : null;
      const goAxios = runtime?.goAxios;
      if (!goAxios) return;
      const summary = await fetchFillsSummary(goAxios, strategy, startOfEtTradingDayIso());
      const line = renderFillsSummaryLine(summary, this._agentConfig?.name);
      if (line) this.state.emit('agent_log', { message: line, level: 'success' });
    } catch {
      // soft-fail: the recap is best-effort, never block start
    }
  }

```

- [ ] **Step 5: Call it from `start()`**

In `agent/harness.js` `start()`, find the "Agent started" emit followed by the Hybrid-startup comment:

```js
      level: 'success',
    });

    // Hybrid startup for scheduledBeats.exclusive agents: only fire the immediate
```

Replace with:

```js
      level: 'success',
    });

    // LLM-free fills recap — surfaces broker-side fills (resting limit entries,
    // bracket exits) that landed since the ET open. Soft-fails; never blocks start.
    if (process.env.FILLS_SUMMARY_ENABLED !== 'false') {
      void this._emitFillsSummary();
    }

    // Hybrid startup for scheduledBeats.exclusive agents: only fire the immediate
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test agent/harness.test.mjs`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 7: Commit**

```bash
git add agent/harness.js agent/harness.test.mjs
git commit -m "feat(agent): emit fills recap on harness start"
```

---

## Task 5: SSE trigger — recap on dashboard open

**Files:**
- Modify: `agent/server.js` (import, `emitConnectFillsSummaries`, call in `/api/events`)
- Modify: `.env.example` (document the flag)

This task is thin wiring around the already-tested `fills-summary.js` module; `server.js` has no unit-test harness in this repo, so it is verified by the Go/Node suites plus a manual check (Step 5).

- [ ] **Step 1: Add the import**

In `agent/server.js`, find (line ~33):

```js
import { appendTrade, readTrades } from './trades-store.js';
```

Add directly beneath it:

```js
import { fetchFillsSummary, renderFillsSummaryLine, startOfEtTradingDayIso } from './fills-summary.js';
```

- [ ] **Step 2: Add the per-connect emitter**

In `agent/server.js`, add this function just above the `// ── SSE Endpoint ──` comment (just before `app.get('/api/events', ...)`):

```js
// Write a per-agent fills recap to a single freshly-connected SSE client. Not a
// broadcast — opening a second dashboard must not re-spam everyone. Mirrors the
// harness start-path recap so a mid-day dashboard open surfaces the same
// broker-side fills. Soft-fail per sandbox.
async function emitConnectFillsSummaries(res) {
  for (const runtime of orchestrator.runtimes.values()) {
    try {
      const harness = runtime?.harness;
      if (!harness?.state?.running) continue;
      const sandboxId = harness.sandboxId;
      const resolved = getResolvedAgentForSandbox(sandboxId);
      const strategy = resolved?.strategyId;
      const goAxios = runtime.goAxios;
      if (!strategy || !goAxios) continue;
      const summary = await fetchFillsSummary(goAxios, strategy, startOfEtTradingDayIso());
      const line = renderFillsSummaryLine(summary, resolved?.name);
      if (line && sseClients.has(res)) {
        const data = { message: line, level: 'success', sandboxId, timestamp: new Date().toISOString() };
        res.write(`event: agent_log\ndata: ${JSON.stringify(data)}\n\n`);
      }
    } catch {
      // soft-fail: best-effort recap per sandbox
    }
  }
}
```

- [ ] **Step 3: Call it on connect**

In `agent/server.js`, find the end of the `/api/events` handler:

```js
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});
```

Replace with:

```js
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));

  // Trigger B: surface each running agent's day fills to this client only.
  if (process.env.FILLS_SUMMARY_ENABLED !== 'false') {
    void emitConnectFillsSummaries(res);
  }
});
```

- [ ] **Step 4: Document the flag**

In `.env.example`, add a line near the other agent feature toggles (e.g., next to `BEAT_CONTEXT_ENABLED` if present, otherwise at the end of the agent section):

```bash
# Set to "false" to suppress the LLM-free fills recap shown on agent start and
# dashboard open. Default on.
FILLS_SUMMARY_ENABLED=true
```

- [ ] **Step 5: Manual verification**

Run the full suites first:

Run: `go build ./... && go test ./... && node --test agent/*.test.mjs`
Expected: build + all tests PASS.

Then a live smoke test:
1. Start the stack and open the dashboard with at least one agent running that has fills today (Coil after its 15:45 ET beat, or any agent with filled orders since ET-midnight).
2. Confirm a `success`-level line appears in that agent's terminal pane, e.g.:
   `Coil — 3 fills today (broker-side, no LLM beat): BUY 12 AAPL @ $184.20 (10:14 ET) · …`
3. Stop and restart that agent; confirm the same recap re-appears right under "Agent started" (the restart case from the original report).
4. Open a second browser tab; confirm only the newly-opened tab gets the recap written on connect (no duplicate broadcast to the first tab).

- [ ] **Step 6: Commit**

```bash
git add agent/server.js .env.example
git commit -m "feat(agent): emit fills recap to connecting dashboard client"
```

---

## Self-Review Notes

- **Spec coverage:** Go endpoint + pure `SummarizeFills` (Task 1–2); Node fetch/render + ET-midnight anchor (Task 3); Trigger A start emit (Task 4); Trigger B per-client SSE emit (Task 5); kill switch `FILLS_SUMMARY_ENABLED` (Tasks 4–5); display-only / current-ET-day window / all-agents via strategy tag (Tasks 1–5). No persistence or watcher — matches non-goals.
- **Type/name consistency:** `SummarizeFills(orders, strategy, since)` → `FillsSummary{strategy, since, count, fills[]FillItem{symbol, side, qty, avg_price, filled_at}}`; Node reads exactly those snake_case fields. `_emitFillsSummary`, `emitConnectFillsSummaries`, `fetchFillsSummary`, `renderFillsSummaryLine`, `startOfEtTradingDayIso`, `startOfEtTradingDay` (Go) used consistently across tasks.
- **No placeholders:** every code/step is concrete.
```
