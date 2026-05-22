# Options-Chain Fetch Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Alpaca options-chain fetch path survive rate-limiting (429) by adding shared admission control, bounded retry-on-429, and correct 429 status reporting — so Harvest stops missing qualifying trades to self-inflicted throttling and stops misdiagnosing it as a feed outage.

**Architecture:** Three orthogonal layers. (1) A process-wide token-bucket rate limiter (`golang.org/x/time/rate`) is injected into both the shared bar-fetch service and the options-chain trading service so they draw from one smoothed Alpaca data-API budget; the latency-critical intraday client stays exempt. (2) The options-chain fetch gains a bounded retry loop (≤2 retries, exp backoff, honoring `Retry-After`) reusing the existing transient-error classifier. (3) A typed `RateLimitedError` lets the HTTP controller return 429 (not 500) with `Retry-After`.

**Tech Stack:** Go, `golang.org/x/time/rate`, gin, logrus, Alpaca `marketdata`/`alpaca` SDKs, `go test`.

**Spec:** `docs/superpowers/specs/2026-05-22-options-chain-fetch-resilience-design.md`

---

## File Structure

**Created:**
- `services/rate_limiter.go` — the `RateLimiter` seam interface, the `acquire` nil-safe helper, and `NewAlpacaDataRateLimiter` constructor. One responsibility: admission control plumbing.
- `services/rate_limiter_test.go` — tests for the constructor sizing and `acquire`.
- `services/errors.go` — the typed `RateLimitedError`. One responsibility: structured 429 signal shared across layers.
- `services/errors_test.go` — tests for `RateLimitedError` formatting + `errors.As` extraction.

**Modified:**
- `services/alpaca_data.go` — add `limiter` field + `SetRateLimiter`; acquire in `GetHistoricalBars`/`GetMultiBars`.
- `services/alpaca_data_test.go` — limiter-gate + nil-default + intraday-exempt tests.
- `services/alpaca_trading.go` — add `limiter` + `fetchChainOnce` seam + `optionsRetryBackoff` fields; refactor `GetOptionsChain` into acquire + retry loop over `doFetchOptionsChain`; `doFetchOptionsChain` returns `RateLimitedError` on 429; add `chainRetryBackoff` + `parseRetryAfter`.
- `services/alpaca_trading_test.go` — retry-count, no-retry-on-4xx, backoff-cap, acquire-gate tests.
- `controllers/order_controller.go` — map `RateLimitedError` → HTTP 429 + `Retry-After`.
- `controllers/order_controller_test.go` — 429-passthrough + 500-fallthrough tests.
- `config/config.go` — add `AlpacaDataRatePerMin int` (env `ALPACA_DATA_RATE_PER_MIN`, default 180) + `parseIntOrDefault` helper.
- `config/config_test.go` — default + override test.
- `cmd/bot/main.go` — build limiter, inject into shared data + trading services (NOT intraday).
- `.env.example` — document `ALPACA_DATA_RATE_PER_MIN`.

---

## Task 1: Rate-limiter seam, acquire helper, and constructor

**Files:**
- Create: `services/rate_limiter.go`
- Create: `services/rate_limiter_test.go`
- Modify: `go.mod`, `go.sum` (promote `golang.org/x/time` to a direct dependency)

- [ ] **Step 1: Add the dependency**

Run: `go get golang.org/x/time/rate`
Expected: `go.mod` gains a `golang.org/x/time vX.Y.Z` require line (no longer `// indirect`).

- [ ] **Step 2: Write the failing test**

Create `services/rate_limiter_test.go`:

```go
package services

import (
	"context"
	"errors"
	"testing"

	"golang.org/x/time/rate"
)

func TestNewAlpacaDataRateLimiter_Sizing(t *testing.T) {
	// 180/min => 3 events/sec.
	lim := NewAlpacaDataRateLimiter(180, 10)
	if got := float64(lim.Limit()); got < 2.99 || got > 3.01 {
		t.Errorf("limit: got %v events/sec, want ~3.0 (180/min)", got)
	}
	if lim.Burst() != 10 {
		t.Errorf("burst: got %d, want 10", lim.Burst())
	}
}

func TestNewAlpacaDataRateLimiter_NonPositiveIsUnlimited(t *testing.T) {
	lim := NewAlpacaDataRateLimiter(0, 10)
	if lim.Limit() != rate.Inf {
		t.Errorf("non-positive perMinute must yield rate.Inf, got %v", lim.Limit())
	}
}

// fakeLimiter records Wait calls and can be made to fail.
type fakeLimiter struct {
	calls int
	err   error
}

func (f *fakeLimiter) Wait(ctx context.Context) error {
	f.calls++
	return f.err
}

func TestAcquire_NilLimiterIsNoOp(t *testing.T) {
	if err := acquire(context.Background(), nil); err != nil {
		t.Errorf("nil limiter must be a no-op, got %v", err)
	}
}

func TestAcquire_DelegatesToLimiter(t *testing.T) {
	sentinel := errors.New("blocked")
	f := &fakeLimiter{err: sentinel}
	err := acquire(context.Background(), f)
	if f.calls != 1 {
		t.Errorf("Wait calls: got %d, want 1", f.calls)
	}
	if !errors.Is(err, sentinel) {
		t.Errorf("acquire must return the limiter error, got %v", err)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./services/ -run 'RateLimiter|Acquire' -v`
Expected: FAIL — `undefined: NewAlpacaDataRateLimiter`, `undefined: acquire`.

- [ ] **Step 4: Write minimal implementation**

Create `services/rate_limiter.go`:

```go
package services

import (
	"context"

	"golang.org/x/time/rate"
)

// RateLimiter is the admission-control seam for Alpaca data-API calls. The
// production implementation is *golang.org/x/time/rate.Limiter; tests inject a
// fake. A nil RateLimiter means "no limit" (see acquire).
type RateLimiter interface {
	Wait(ctx context.Context) error
}

// NewAlpacaDataRateLimiter builds a token-bucket limiter for the shared Alpaca
// data API, sized to perMinute requests with the given burst. A non-positive
// perMinute yields an unlimited (rate.Inf) limiter so the limiter can be wired
// unconditionally and disabled by configuration.
func NewAlpacaDataRateLimiter(perMinute, burst int) *rate.Limiter {
	if perMinute <= 0 {
		return rate.NewLimiter(rate.Inf, burst)
	}
	return rate.NewLimiter(rate.Limit(float64(perMinute)/60.0), burst)
}

// acquire blocks until the limiter admits one request or ctx is done. A nil
// limiter is a no-op, so callers can hold a possibly-unset limiter without a
// branch at every call site and existing constructions stay unthrottled.
func acquire(ctx context.Context, l RateLimiter) error {
	if l == nil {
		return nil
	}
	return l.Wait(ctx)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./services/ -run 'RateLimiter|Acquire' -v`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum services/rate_limiter.go services/rate_limiter_test.go
git commit -m "Add Alpaca data-API rate-limiter seam and acquire helper"
```

---

## Task 2: Typed RateLimitedError

**Files:**
- Create: `services/errors.go`
- Create: `services/errors_test.go`

- [ ] **Step 1: Write the failing test**

Create `services/errors_test.go`:

```go
package services

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestRateLimitedError_MessageContainsHTTP429(t *testing.T) {
	// The message must contain "HTTP 429" so isTransientBrokerError classifies
	// it as transient (the retry loop relies on this).
	e := &RateLimitedError{RetryAfter: 2 * time.Second, Body: "too many requests"}
	if !isTransientBrokerError(e) {
		t.Errorf("RateLimitedError must be transient, message was %q", e.Error())
	}
}

func TestRateLimitedError_ExtractableViaErrorsAs(t *testing.T) {
	wrapped := fmt.Errorf("options chain fetch: %w", &RateLimitedError{RetryAfter: 3 * time.Second})
	var rle *RateLimitedError
	if !errors.As(wrapped, &rle) {
		t.Fatal("RateLimitedError must be recoverable from a wrapped error via errors.As")
	}
	if rle.RetryAfter != 3*time.Second {
		t.Errorf("RetryAfter: got %v, want 3s", rle.RetryAfter)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run 'RateLimitedError' -v`
Expected: FAIL — `undefined: RateLimitedError`.

- [ ] **Step 3: Write minimal implementation**

Create `services/errors.go`:

```go
package services

import (
	"fmt"
	"time"
)

// RateLimitedError is returned by Alpaca data-API fetches when the broker
// responds HTTP 429. It carries the parsed Retry-After hint (0 when the header
// is absent) so callers can both classify the failure (errors.As) and surface
// the broker's backoff guidance. The Error() string includes "HTTP 429" so the
// existing isTransientBrokerError classifier treats it as retryable.
type RateLimitedError struct {
	RetryAfter time.Duration
	Body       string
}

func (e *RateLimitedError) Error() string {
	return fmt.Sprintf("rate limited (HTTP 429), retry-after=%s: %s", e.RetryAfter, e.Body)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/ -run 'RateLimitedError' -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add services/errors.go services/errors_test.go
git commit -m "Add typed RateLimitedError for 429 classification"
```

---

## Task 3: Wire limiter into the shared bar-fetch service

**Files:**
- Modify: `services/alpaca_data.go:15-18` (struct), `:67-76` (constructors), `:79-103` (GetHistoricalBars), `:125-148` (GetMultiBars)
- Test: `services/alpaca_data_test.go`

- [ ] **Step 1: Write the failing test**

Add to `services/alpaca_data_test.go` (note: this file currently has no `context`/`errors` imports — add them):

```go
// The shared data service must acquire a rate-limiter token before issuing a
// fetch. We prove the gate by injecting a limiter that fails: GetHistoricalBars
// must return that error and never reach the network SDK call.
func TestGetHistoricalBars_AcquiresBeforeFetch(t *testing.T) {
	sentinel := errors.New("limiter blocked")
	svc := NewAlpacaDataService("k", "s")
	svc.SetRateLimiter(&fakeLimiter{err: sentinel})

	_, err := svc.GetHistoricalBars(context.Background(), "SPY", time.Now().AddDate(0, 0, -5), time.Now(), "1Day")
	if !errors.Is(err, sentinel) {
		t.Errorf("GetHistoricalBars must short-circuit on limiter error, got %v", err)
	}
}

func TestGetMultiBars_AcquiresBeforeFetch(t *testing.T) {
	sentinel := errors.New("limiter blocked")
	svc := NewAlpacaDataService("k", "s")
	svc.SetRateLimiter(&fakeLimiter{err: sentinel})

	_, err := svc.GetMultiBars(context.Background(), []string{"SPY", "QQQ"}, time.Now().AddDate(0, 0, -5), time.Now(), "1Day")
	if !errors.Is(err, sentinel) {
		t.Errorf("GetMultiBars must short-circuit on limiter error, got %v", err)
	}
}

// Limiter is opt-in: constructors leave it nil so existing callers/tests are
// unthrottled. The intraday client must NEVER be wired to the shared limiter
// (preserves the latency isolation from commit 1ec6b6a) — main.go only calls
// SetRateLimiter on the shared service, never the intraday one.
func TestConstructors_LeaveLimiterNil(t *testing.T) {
	if NewAlpacaDataService("k", "s").limiter != nil {
		t.Error("shared service must construct with nil limiter (opt-in via SetRateLimiter)")
	}
	if NewIntradayAlpacaDataService("k", "s").limiter != nil {
		t.Error("intraday service must never carry a limiter")
	}
}
```

Add `"context"` and `"errors"` to the import block of `services/alpaca_data_test.go` (currently imports only `"testing"` and `"time"`).

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/ -run 'AcquiresBeforeFetch|LeaveLimiterNil' -v`
Expected: FAIL — `svc.SetRateLimiter undefined` and `svc.limiter undefined`.

- [ ] **Step 3: Add the field, setter, and acquire calls**

In `services/alpaca_data.go`, change the struct (currently lines 15-18):

```go
// AlpacaDataService implements DataService using Alpaca Market Data API
type AlpacaDataService struct {
	client  *marketdata.Client
	logger  *logrus.Logger
	limiter RateLimiter // nil = unthrottled; set via SetRateLimiter at wiring time
}
```

Add a setter immediately after `NewIntradayAlpacaDataService` (after current line 76):

```go
// SetRateLimiter wires a shared admission limiter into this service. Wire it
// only into the shared data service (and the trading service), never the
// intraday service, so a heavy batch can never delay the intraday path.
func (s *AlpacaDataService) SetRateLimiter(l RateLimiter) {
	s.limiter = l
}
```

Add to the top of `GetHistoricalBars` (immediately after the function signature on current line 79, before the existing `s.logger.WithFields` call):

```go
	if err := acquire(ctx, s.limiter); err != nil {
		return nil, fmt.Errorf("historical bars rate-limit wait: %w", err)
	}
```

Add the same to the top of `GetMultiBars` (immediately after the signature on current line 125, before its `s.logger.WithFields` call):

```go
	if err := acquire(ctx, s.limiter); err != nil {
		return nil, fmt.Errorf("multi bars rate-limit wait: %w", err)
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./services/ -run 'AcquiresBeforeFetch|LeaveLimiterNil' -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full services package to check nothing regressed**

Run: `go test ./services/`
Expected: PASS (existing decoupling/timeout tests in `alpaca_data_test.go` still green; nil-limiter default keeps every other caller unthrottled).

- [ ] **Step 6: Commit**

```bash
git add services/alpaca_data.go services/alpaca_data_test.go
git commit -m "Gate shared bar-fetch service through the rate limiter"
```

---

## Task 4: Retry + acquire on the options-chain fetch

**Files:**
- Modify: `services/alpaca_trading.go` — imports, struct (`:52-68`), constructor (`:89-100`), `GetOptionsChain` (`:430-503`)
- Test: `services/alpaca_trading_test.go`

- [ ] **Step 1: Write the failing tests**

Add to `services/alpaca_trading_test.go` (add `"context"` is already imported; add `"time"` and `"errors"` to the import block — currently imports `context`, `fmt`, `io`, `math`, `interfaces`, `strings`, `testing`, `alpaca`, `logrus`):

```go
func TestGetOptionsChain_RetriesOnRateLimit(t *testing.T) {
	attempts := 0
	svc := newTestAlpacaService()
	svc.optionsRetryBackoff = 0 // no real sleeping in tests
	svc.fetchChainOnce = func(ctx context.Context, underlying string, exp time.Time) ([]*interfaces.OptionContract, error) {
		attempts++
		if attempts == 1 {
			return nil, &RateLimitedError{RetryAfter: 0, Body: "too many requests"}
		}
		return []*interfaces.OptionContract{{Symbol: "SPY_C"}}, nil
	}

	got, err := svc.GetOptionsChain(context.Background(), "SPY", time.Now())
	if err != nil {
		t.Fatalf("GetOptionsChain: %v", err)
	}
	if attempts != 2 {
		t.Errorf("attempts: got %d, want 2 (one retry after 429)", attempts)
	}
	if len(got) != 1 || got[0].Symbol != "SPY_C" {
		t.Errorf("expected the recovered chain, got %#v", got)
	}
}

func TestGetOptionsChain_DoesNotRetryNonTransient(t *testing.T) {
	attempts := 0
	svc := newTestAlpacaService()
	svc.optionsRetryBackoff = 0
	svc.fetchChainOnce = func(ctx context.Context, underlying string, exp time.Time) ([]*interfaces.OptionContract, error) {
		attempts++
		return nil, fmt.Errorf("options chain API error (HTTP 422): bad params")
	}

	_, err := svc.GetOptionsChain(context.Background(), "SPY", time.Now())
	if err == nil {
		t.Fatal("expected error")
	}
	if attempts != 1 {
		t.Errorf("attempts: got %d, want 1 (4xx must not retry)", attempts)
	}
}

func TestGetOptionsChain_StopsAfterMaxRetries(t *testing.T) {
	attempts := 0
	svc := newTestAlpacaService()
	svc.optionsRetryBackoff = 0
	svc.fetchChainOnce = func(ctx context.Context, underlying string, exp time.Time) ([]*interfaces.OptionContract, error) {
		attempts++
		return nil, &RateLimitedError{RetryAfter: 0, Body: "still throttled"}
	}

	_, err := svc.GetOptionsChain(context.Background(), "SPY", time.Now())
	var rle *RateLimitedError
	if !errors.As(err, &rle) {
		t.Fatalf("final error must remain a RateLimitedError, got %v", err)
	}
	if attempts != 3 {
		t.Errorf("attempts: got %d, want 3 (1 initial + 2 retries)", attempts)
	}
}

func TestGetOptionsChain_AcquiresBeforeFetch(t *testing.T) {
	sentinel := errors.New("limiter blocked")
	called := false
	svc := newTestAlpacaService()
	svc.limiter = &fakeLimiter{err: sentinel}
	svc.fetchChainOnce = func(ctx context.Context, underlying string, exp time.Time) ([]*interfaces.OptionContract, error) {
		called = true
		return nil, nil
	}

	_, err := svc.GetOptionsChain(context.Background(), "SPY", time.Now())
	if !errors.Is(err, sentinel) {
		t.Errorf("must short-circuit on limiter error, got %v", err)
	}
	if called {
		t.Error("fetch must not run when the limiter blocks")
	}
}

func TestChainRetryBackoff(t *testing.T) {
	base := 250 * time.Millisecond
	if got := chainRetryBackoff(1, base, nil); got != 250*time.Millisecond {
		t.Errorf("attempt 1: got %v, want 250ms", got)
	}
	if got := chainRetryBackoff(2, base, nil); got != 500*time.Millisecond {
		t.Errorf("attempt 2: got %v, want 500ms", got)
	}
	// Retry-After under the cap is honored verbatim.
	if got := chainRetryBackoff(1, base, &RateLimitedError{RetryAfter: 1 * time.Second}); got != 1*time.Second {
		t.Errorf("retry-after 1s: got %v, want 1s", got)
	}
	// Retry-After over the 2s cap is clamped.
	if got := chainRetryBackoff(1, base, &RateLimitedError{RetryAfter: 9 * time.Second}); got != 2*time.Second {
		t.Errorf("retry-after 9s: got %v, want 2s (capped)", got)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./services/ -run 'GetOptionsChain|ChainRetryBackoff' -v`
Expected: FAIL — `svc.optionsRetryBackoff undefined`, `svc.fetchChainOnce undefined`, `undefined: chainRetryBackoff`.

- [ ] **Step 3: Add struct fields and update imports**

In `services/alpaca_trading.go`, add `"errors"` and `"strconv"` to the import block (it already imports `bytes`, `context`, `encoding/json`, `fmt`, `io`, `math`, `net/http`, `interfaces`, `strings`, `time`, and the external SDKs).

Extend the struct (current lines 52-68) by adding three fields after `retryBackoff`:

```go
	// retryBackoff is the sleep between the first attempt and the single
	// retry on transient broker errors. Kept short — heartbeat windows are
	// tight and stale retries add market risk. Tests set to 0.
	retryBackoff time.Duration

	// limiter is the shared Alpaca data-API admission limiter. nil =
	// unthrottled; set via SetRateLimiter at wiring time.
	limiter RateLimiter
	// fetchChainOnce is the single-attempt options-chain fetch seam. Defaults
	// to doFetchOptionsChain; tests inject a fake to drive the retry loop
	// without a network call.
	fetchChainOnce func(ctx context.Context, underlying string, expiration time.Time) ([]*interfaces.OptionContract, error)
	// optionsRetryBackoff is the base backoff for the options-chain retry loop
	// (doubled per attempt). Tests set to 0.
	optionsRetryBackoff time.Duration
```

In `NewAlpacaTradingService` (after current line 99 `s.retryBackoff = 200 * time.Millisecond`), wire the seam and base backoff:

```go
	s.brokerPlaceOrder = s.client.PlaceOrder
	s.retryBackoff = 200 * time.Millisecond
	s.fetchChainOnce = s.doFetchOptionsChain
	s.optionsRetryBackoff = 250 * time.Millisecond
```

Add a setter near the constructor:

```go
// SetRateLimiter wires the shared admission limiter into the options-chain
// fetch path. Wire the same instance shared with the bar-fetch data service.
func (s *AlpacaTradingService) SetRateLimiter(l RateLimiter) {
	s.limiter = l
}
```

- [ ] **Step 4: Refactor GetOptionsChain into acquire + retry over a renamed once-fetcher**

Replace the current `GetOptionsChain` function (lines 430-503). First, rename the existing implementation to `doFetchOptionsChain` and change its 429 branch to return a `RateLimitedError`. The body is identical to today's `GetOptionsChain` except the signature name and the non-200 handling:

```go
// doFetchOptionsChain performs a single options-chain fetch. On HTTP 429 it
// returns a *RateLimitedError carrying the Retry-After hint; on other non-200
// statuses a generic error. This is the seam wrapped by GetOptionsChain's
// retry loop (s.fetchChainOnce).
func (s *AlpacaTradingService) doFetchOptionsChain(ctx context.Context, underlying string, expiration time.Time) ([]*interfaces.OptionContract, error) {
	s.logger.WithFields(logrus.Fields{
		"underlying": underlying,
		"expiration": expiration,
	}).Debug("Getting options chain")

	url := fmt.Sprintf("https://data.alpaca.markets/v1beta1/options/snapshots/%s", underlying)
	expirationStr := expiration.Format("2006-01-02")
	url += fmt.Sprintf("?expiration_date=%s&limit=1000", expirationStr)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("APCA-API-KEY-ID", s.apiKey)
	req.Header.Set("APCA-API-SECRET-KEY", s.apiSecret)
	req.Header.Set("Accept", "application/json")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch options chain: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusTooManyRequests {
		body, _ := io.ReadAll(resp.Body)
		return nil, &RateLimitedError{
			RetryAfter: parseRetryAfter(resp.Header),
			Body:       string(body),
		}
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("options chain API error (HTTP %d): %s", resp.StatusCode, string(body))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	var snapshot alpacaOptionsSnapshot
	if err := json.Unmarshal(body, &snapshot); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	contracts := make([]*interfaces.OptionContract, 0, len(snapshot.Snapshots))
	for symbol, data := range snapshot.Snapshots {
		contract := &interfaces.OptionContract{
			Symbol:            symbol,
			UnderlyingSymbol:  underlying,
			Bid:               data.LatestQuote.Bid,
			Ask:               data.LatestQuote.Ask,
			Premium:           data.LatestTrade.Price,
			ImpliedVolatility: data.ImpliedVolatility,
			Delta:             data.Greeks.Delta,
			Gamma:             data.Greeks.Gamma,
			Theta:             data.Greeks.Theta,
			Vega:              data.Greeks.Vega,
			ExpirationDate:    expiration,
		}
		contracts = append(contracts, contract)
	}

	s.logger.WithField("count", len(contracts)).Debug("Fetched options chain")
	return contracts, nil
}
```

Then add the new public `GetOptionsChain` (acquire + bounded retry) and the helpers:

```go
// GetOptionsChain fetches the options chain for an underlying, gated by the
// shared rate limiter and retried on transient errors (429/5xx/network) up to
// twice with exponential backoff, honoring Retry-After. Non-transient errors
// (e.g. 4xx validation) fail fast. The retry budget stays well within the
// caller's request context.
func (s *AlpacaTradingService) GetOptionsChain(ctx context.Context, underlying string, expiration time.Time) ([]*interfaces.OptionContract, error) {
	const maxAttempts = 3 // 1 initial + 2 retries
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			wait := chainRetryBackoff(attempt, s.optionsRetryBackoff, lastErr)
			if wait > 0 {
				select {
				case <-time.After(wait):
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
		}
		if err := acquire(ctx, s.limiter); err != nil {
			return nil, fmt.Errorf("options chain rate-limit wait: %w", err)
		}
		contracts, err := s.fetchChainOnce(ctx, underlying, expiration)
		if err == nil {
			return contracts, nil
		}
		lastErr = err
		if !isTransientBrokerError(err) {
			return nil, err
		}
	}
	return nil, lastErr
}

// chainRetryBackoff returns the wait before a retry attempt. When the last
// error was a 429 carrying a Retry-After, that hint wins (capped at 2s);
// otherwise exponential backoff from base (attempt 1 -> base, attempt 2 ->
// 2*base). A non-positive base disables sleeping (tests).
func chainRetryBackoff(attempt int, base time.Duration, lastErr error) time.Duration {
	var rle *RateLimitedError
	if errors.As(lastErr, &rle) && rle.RetryAfter > 0 {
		if rle.RetryAfter > 2*time.Second {
			return 2 * time.Second
		}
		return rle.RetryAfter
	}
	if base <= 0 {
		return 0
	}
	return base * time.Duration(int64(1)<<(attempt-1))
}

// parseRetryAfter reads a delta-seconds Retry-After header (the form Alpaca
// sends). Returns 0 when absent or unparseable.
func parseRetryAfter(h http.Header) time.Duration {
	v := strings.TrimSpace(h.Get("Retry-After"))
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil && secs >= 0 {
		return time.Duration(secs) * time.Second
	}
	return 0
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./services/ -run 'GetOptionsChain|ChainRetryBackoff' -v`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the full services package**

Run: `go test ./services/`
Expected: PASS (existing order-retry and snap tests unaffected — `fetchChainOnce` defaults to the real impl in the real constructor; `newTestAlpacaService` leaves it nil, so only the new tests that set it exercise `GetOptionsChain`).

- [ ] **Step 7: Commit**

```bash
git add services/alpaca_trading.go services/alpaca_trading_test.go
git commit -m "Add rate-limit gate and retry-on-429 to options-chain fetch"
```

---

## Task 5: Controller returns 429 instead of 500

**Files:**
- Modify: `controllers/order_controller.go:3-14` (imports), `:688-693` (error handling)
- Test: `controllers/order_controller_test.go`

- [ ] **Step 1: Inspect the existing test harness**

Run: `go test ./controllers/ -run GetOptionsChain -v` (there may be none yet) and open `controllers/order_controller_test.go` to find `recordingTradingService` (its `GetOptionsChain` stub is at line ~57). Confirm how a controller + gin test context is constructed in that file so the new test matches the established pattern.

- [ ] **Step 2: Write the failing test**

Add to `controllers/order_controller_test.go`. This uses `httptest` + gin in test mode; adapt the controller construction to match the existing helper in that file if one exists (e.g. a `newTestOrderController` builder). Add imports `errors`, `net/http`, `net/http/httptest`, `time`, `prophet-trader/services` as needed:

```go
// chainErrTradingService is a TradingService whose GetOptionsChain returns a
// preset error, so we can assert the controller's status mapping.
type chainErrTradingService struct {
	interfaces.TradingService // embed to satisfy the rest of the interface
	err                       error
}

func (s *chainErrTradingService) GetOptionsChain(_ context.Context, _ string, _ time.Time) ([]*interfaces.OptionContract, error) {
	return nil, s.err
}

func TestGetOptionsChain_RateLimitedReturns429(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oc := &OrderController{
		tradingService: &chainErrTradingService{err: &services.RateLimitedError{RetryAfter: 4 * time.Second, Body: "too many requests"}},
		logger:         testLogger(),
	}

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Params = gin.Params{{Key: "symbol", Value: "SPY"}}
	c.Request = httptest.NewRequest(http.MethodGet, "/api/options/chain/SPY", nil)

	oc.GetOptionsChain(c)

	if w.Code != http.StatusTooManyRequests {
		t.Errorf("status: got %d, want 429", w.Code)
	}
	if got := w.Header().Get("Retry-After"); got != "4" {
		t.Errorf("Retry-After: got %q, want \"4\"", got)
	}
}

func TestGetOptionsChain_OtherErrorReturns500(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oc := &OrderController{
		tradingService: &chainErrTradingService{err: errors.New("options chain API error (HTTP 503): boom")},
		logger:         testLogger(),
	}

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Params = gin.Params{{Key: "symbol", Value: "SPY"}}
	c.Request = httptest.NewRequest(http.MethodGet, "/api/options/chain/SPY", nil)

	oc.GetOptionsChain(c)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("status: got %d, want 500", w.Code)
	}
}
```

Note: if `order_controller_test.go` already defines a logger helper, reuse it instead of `testLogger()`; otherwise add:

```go
func testLogger() *logrus.Logger {
	l := logrus.New()
	l.SetOutput(io.Discard)
	return l
}
```

(Add `io` and `logrus` imports if not already present in the test file.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `go test ./controllers/ -run 'GetOptionsChain_RateLimited|GetOptionsChain_OtherError' -v`
Expected: FAIL — controller returns 500 for the rate-limited case (current behavior maps every error to 500).

- [ ] **Step 4: Update the controller error handling**

In `controllers/order_controller.go`, add `"errors"` to the import block (after `"context"`). Replace the error block at lines 689-693:

```go
	chain, err := oc.tradingService.GetOptionsChain(ctx, symbol, expiration)
	if err != nil {
		oc.logger.WithError(err).Error("Failed to get options chain")
		var rle *services.RateLimitedError
		if errors.As(err, &rle) {
			if rle.RetryAfter > 0 {
				c.Header("Retry-After", strconv.Itoa(int(rle.RetryAfter.Seconds())))
			}
			c.JSON(http.StatusTooManyRequests, gin.H{"error": err.Error(), "rate_limited": true})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
```

Note: this introduces `http.StatusTooManyRequests` / `http.StatusInternalServerError`. The controller does not currently import `net/http` — add `"net/http"` to the import block. (`strconv` and `services` are already imported.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./controllers/ -run 'GetOptionsChain_RateLimited|GetOptionsChain_OtherError' -v`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full controllers package**

Run: `go test ./controllers/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add controllers/order_controller.go controllers/order_controller_test.go
git commit -m "Return HTTP 429 (not 500) for rate-limited options-chain fetch"
```

---

## Task 6: Config knob + main.go wiring + .env.example

**Files:**
- Modify: `config/config.go:11-54` (struct), `:62-105` (Load), add `parseIntOrDefault`
- Test: `config/config_test.go`
- Modify: `cmd/bot/main.go:43-66` (build + inject limiter)
- Modify: `.env.example`

- [ ] **Step 1: Write the failing config test**

Add to `config/config_test.go` (match the file's existing env-set/reset pattern; if it uses `t.Setenv`, use that):

```go
func TestLoad_AlpacaDataRatePerMin_Default(t *testing.T) {
	t.Setenv("OPERATOR_EMAIL", "test@example.com") // required by Load
	t.Setenv("ALPACA_DATA_RATE_PER_MIN", "")
	if err := Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if AppConfig.AlpacaDataRatePerMin != 180 {
		t.Errorf("default: got %d, want 180", AppConfig.AlpacaDataRatePerMin)
	}
}

func TestLoad_AlpacaDataRatePerMin_Override(t *testing.T) {
	t.Setenv("OPERATOR_EMAIL", "test@example.com")
	t.Setenv("ALPACA_DATA_RATE_PER_MIN", "600")
	if err := Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if AppConfig.AlpacaDataRatePerMin != 600 {
		t.Errorf("override: got %d, want 600", AppConfig.AlpacaDataRatePerMin)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./config/ -run AlpacaDataRatePerMin -v`
Expected: FAIL — `AppConfig.AlpacaDataRatePerMin undefined`.

- [ ] **Step 3: Add the config field, loader, and helper**

In `config/config.go`, add to the `Config` struct (after `OperatorEmail`, before `// Trade guard limits` is fine):

```go
	// Shared Alpaca data-API rate cap (requests/min) governing bar + options-chain
	// fetches. Default 180 leaves headroom under the Basic plan's 200/min account
	// limit; raise on higher tiers. <=0 disables the cap.
	AlpacaDataRatePerMin int
```

In `Load()`, add to the struct literal (next to the other Alpaca fields):

```go
		AlpacaDataRatePerMin: parseIntOrDefault("ALPACA_DATA_RATE_PER_MIN", 180),
```

Add the helper near `parseFloat`:

```go
func parseIntOrDefault(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./config/ -run AlpacaDataRatePerMin -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the limiter in main.go**

In `cmd/bot/main.go`, after the credential validation (after current line 46) and before/around the service construction, build one shared limiter and inject it into the shared data service and the trading service — but NOT the intraday service:

```go
	// One shared Alpaca data-API admission limiter governs both the bar-fetch
	// path and the options-chain path so they stop colliding on the account-wide
	// rate budget. The intraday client is deliberately left ungated to preserve
	// its latency isolation (see services/alpaca_data.go SetRateLimiter doc).
	const alpacaDataBurst = 10
	alpacaDataLimiter := services.NewAlpacaDataRateLimiter(cfg.AlpacaDataRatePerMin, alpacaDataBurst)
```

After `tradingService` is constructed (after current line 60, guarding the nil case from the existing `err` warning path):

```go
	if tradingService != nil {
		tradingService.SetRateLimiter(alpacaDataLimiter)
	}
```

After `dataService` is constructed (after current line 66):

```go
	dataService.SetRateLimiter(alpacaDataLimiter)
```

Leave the `intradayDataService` construction at line ~469 unchanged — no `SetRateLimiter` call.

- [ ] **Step 6: Update .env.example**

Add near the other Alpaca settings in `.env.example`:

```
# Shared Alpaca data-API rate cap (requests/min) for bar + options-chain fetches.
# Default 180 (headroom under the Basic plan's 200/min). Raise on Algo Trader Plus.
# Set to 0 to disable the cap.
ALPACA_DATA_RATE_PER_MIN=180
```

- [ ] **Step 7: Build and run the whole suite**

Run: `go build ./... && go test ./...`
Expected: build succeeds; all packages PASS.

- [ ] **Step 8: Commit**

```bash
git add config/config.go config/config_test.go cmd/bot/main.go .env.example
git commit -m "Wire shared Alpaca rate limiter via ALPACA_DATA_RATE_PER_MIN"
```

---

## Task 7: Final verification

- [ ] **Step 1: Vet and full test run**

Run: `go vet ./... && go test ./...`
Expected: no vet complaints; all tests PASS.

- [ ] **Step 2: Confirm the intraday-exemption invariant by inspection**

Open `cmd/bot/main.go` and confirm `SetRateLimiter` is called on `tradingService` and `dataService` only — never on `intradayDataService`. This is the one invariant a unit test can't fully assert; verify it by reading the wiring.

- [ ] **Step 3: Squash into one commit per the project workflow**

The user's workflow is one squashed commit per backlog item. Squash the Task 1-6 commits into a single commit on this branch before merge (interactive rebase is unavailable in this environment; use `git reset --soft <base>` then re-commit):

```bash
git reset --soft $(git merge-base HEAD main)
git commit -m "Harden options-chain fetch against Alpaca 429 rate-limiting"
```

(Keep the spec/plan doc commits separate or fold them in per preference at finish time.)

---

## Self-Review

**Spec coverage:**
- §4.1 shared rate limiter (bars + chains, injected, no-op default, intraday exempt) → Tasks 1, 3, 4, 6. ✔
- §4.1 sizing via `ALPACA_DATA_RATE_PER_MIN` default 180, burst 10 → Task 6 + Task 1. ✔
- §4.2 retry ≤2, exp backoff 250→500ms, honor Retry-After capped 2s, reuse `isTransientBrokerError`, bars unchanged → Task 4. ✔
- §4.3 429 passthrough + Retry-After, other errors stay 500 → Task 5. ✔
- §6 typed `RateLimitedError` sentinel (chosen option b) → Task 2. ✔ (Placed in the `services` package, which `controllers` already imports — no new import edge, no cycle.)
- §5 testing across all three layers → Tasks 1-6 each ship tests. ✔

**Placeholder scan:** No TBD/TODO; every code step shows full code. Task 5 Step 1 instructs inspecting the existing test harness because the controller test file's construction helper must be matched — the test code itself is complete and adaptable.

**Type consistency:** `RateLimiter.Wait(ctx)`, `acquire(ctx, l)`, `RateLimitedError{RetryAfter, Body}`, `chainRetryBackoff(attempt, base, lastErr)`, `fetchChainOnce(ctx, underlying, expiration)`, `SetRateLimiter(l)` — names and signatures match across Tasks 1-6. The retry classifier reused everywhere is `isTransientBrokerError` (existing). Config field `AlpacaDataRatePerMin` consistent between Task 6 struct, loader, and main.go usage.
