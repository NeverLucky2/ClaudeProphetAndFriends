# Defensive-Prophet Option-Chain Fetch Repair — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the four defects that have prevented the Defensive-Prophet QQQ put-spread hedge from placing a single order since 2026-06-08, so it can locate a valid expiry, read a complete correctly-typed option chain, and execute.

**Architecture:** All four defects live in one transport path. `AlpacaOptionsDataService` currently fetches option *contracts* from the wrong Alpaca host, with two numeric fields typed wrong, reading only the first 100-row page. The executor's `pickExpiry` compounds it by probing a single exact date against a requirement that needs a date *range*. The repair collapses all contract fetching into one paginated helper (`fetchContracts`) on the correct host, adds a range-query wrapper, and points `pickExpiry` at it.

**Tech Stack:** Go 1.x, module `prophet-trader`, stdlib `net/http` + `encoding/json`, `logrus` for logging, stdlib `testing` + `net/http/httptest` for tests. No new dependencies.

## Global Constraints

- **Module path:** `prophet-trader` (imports are e.g. `prophet-trader/interfaces`).
- **No new dependencies.** stdlib + existing `logrus` only.
- **No strategy or tuning changes.** `hedgeArmThreshold` (50), `hedgeDebitCapPct` (0.01), `hedgeLongPctOTM` (0.05), `hedgeShortPctOTM` (0.15), `hedgeDTEMin` (45), `hedgeDTEMax` (60), `hedgeMaxConcurrent` (3), harvest/roll thresholds — all unchanged.
- **The repo must compile after every task.** The constructor signature change in Task 1 breaks all three `cmd/bot/main.go` call sites; they are updated in that same task for this reason.
- **Existing tests must stay green.** `services/alpaca_options_data_snapshot_test.go` sets only `baseURL` and exercises `GetOptionSnapshot`, which keeps using `baseURL` — do not move snapshots to the trading host.
- **Trading host constant:** `https://paper-api.alpaca.markets` (the `cfg.AlpacaBaseURL` default, `config/config.go:142`).
- **Contracts path:** `/v2/options/contracts` on the trading host. **Snapshots path:** `/v1beta1/options/snapshots` on `https://data.alpaca.markets`.
- **Test command:** `go test ./services/...` (add `-run <Name>` for a single test).
- **Build command:** `go build ./...`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `services/alpaca_options_data.go` | Modify | Adds `tradingURL` field; new `fetchContracts` paginated helper + `toOptionContract` mapper; `GetOptionChain`, new `GetOptionChainRange`, and `FindOptionsNearDTE` become thin wrappers. |
| `services/alpaca_options_data_chain_test.go` | Create | Transport tests for host routing, string-typed numerics, pagination, malformed contracts, error propagation. |
| `cmd/bot/main.go` | Modify (`:494`, `:522`, `:567`) | Pass `cfg.AlpacaBaseURL` into the 3 constructor call sites. |
| `services/prophet_hedge_structure.go` | Modify | Adds the pure `isThirdFriday` helper. |
| `services/prophet_hedge_structure_test.go` | Modify | Table-driven tests for `isThirdFriday`. |
| `services/prophet_hedge_executor.go` | Modify (`hedgeChainFetcher` ~`:23-26`, `pickExpiry` `:381-401`) | Interface gains `GetOptionChainRange`; `pickExpiry` switches to a band query with monthly preference. |
| `services/prophet_hedge_executor_test.go` | Modify (`hedgeStubChain` `:17-27`) | Stub gains `GetOptionChainRange` + `rangeChain` field; new `pickExpiry` tests. |

---

### Task 1: Split the data host from the trading host

**Files:**
- Modify: `services/alpaca_options_data.go:16-40` (struct + constructor), `:155-160` (`GetOptionChain` URL), `:222-227` (`FindOptionsNearDTE` URL)
- Modify: `cmd/bot/main.go:494`, `:522`, `:567`
- Test: `services/alpaca_options_data_chain_test.go` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `NewAlpacaOptionsDataService(apiKey, secretKey, tradingURL string) *AlpacaOptionsDataService`. Struct field `tradingURL string`. Package const `defaultAlpacaTradingURL = "https://paper-api.alpaca.markets"`.

- [ ] **Step 1: Write the failing test**

Create `services/alpaca_options_data_chain_test.go`:

```go
package services

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
)

// newChainTestService wires a service whose contract fetches go to `trading`
// and whose snapshot fetches go to `data`. Both are plain HTTP httptest
// servers, so a default client reaches either.
func newChainTestService(tradingURL, dataURL string) *AlpacaOptionsDataService {
	lg := logrus.New()
	lg.SetOutput(io.Discard)
	return &AlpacaOptionsDataService{
		apiKey:     "k",
		secretKey:  "s",
		baseURL:    dataURL,
		tradingURL: tradingURL,
		logger:     lg,
		client:     &http.Client{Timeout: 5 * time.Second},
	}
}

// TestGetOptionChain_UsesTradingHostAndV2Path locks the host/path split.
// The contracts endpoint lives on the TRADING API; calling it on
// data.alpaca.markets returns 404, which silently disabled the
// Defensive-Prophet hedge for 52 days.
func TestGetOptionChain_UsesTradingHostAndV2Path(t *testing.T) {
	var gotPath, gotExpiration string
	trading := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotExpiration = r.URL.Query().Get("expiration_date")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"option_contracts":[],"next_page_token":null}`))
	}))
	defer trading.Close()

	data := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("contracts request must not hit the data host (got path %q)", r.URL.Path)
		w.WriteHeader(http.StatusNotFound)
	}))
	defer data.Close()

	s := newChainTestService(trading.URL, data.URL)
	_, err := s.GetOptionChain(context.Background(), "QQQ", time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("GetOptionChain returned error: %v", err)
	}
	if gotPath != "/v2/options/contracts" {
		t.Errorf("path = %q, want %q", gotPath, "/v2/options/contracts")
	}
	if gotExpiration != "2026-09-18" {
		t.Errorf("expiration_date = %q, want %q", gotExpiration, "2026-09-18")
	}
}

// TestNewAlpacaOptionsDataService_EmptyTradingURLFallsBack guarantees a
// missing config value produces the paper default, never a malformed URL.
func TestNewAlpacaOptionsDataService_EmptyTradingURLFallsBack(t *testing.T) {
	s := NewAlpacaOptionsDataService("k", "s", "")
	if s.tradingURL != defaultAlpacaTradingURL {
		t.Errorf("tradingURL = %q, want %q", s.tradingURL, defaultAlpacaTradingURL)
	}
	if s.baseURL != "https://data.alpaca.markets" {
		t.Errorf("baseURL = %q, want the data host", s.baseURL)
	}
}

// TestNewAlpacaOptionsDataService_TrimsTrailingSlash keeps URL joining safe.
func TestNewAlpacaOptionsDataService_TrimsTrailingSlash(t *testing.T) {
	s := NewAlpacaOptionsDataService("k", "s", "https://api.alpaca.markets/")
	if s.tradingURL != "https://api.alpaca.markets" {
		t.Errorf("tradingURL = %q, want trailing slash trimmed", s.tradingURL)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/... -run 'TestGetOptionChain_UsesTradingHostAndV2Path|TestNewAlpacaOptionsDataService' -v`
Expected: **compile failure** — `unknown field 'tradingURL'`, `undefined: defaultAlpacaTradingURL`, and `not enough arguments in call to NewAlpacaOptionsDataService`.

- [ ] **Step 3: Add the field, constant, and constructor parameter**

In `services/alpaca_options_data.go`, add `"strings"` to the import block, then replace the struct and constructor (lines 16-40):

```go
// defaultAlpacaTradingURL is the paper trading host. Option CONTRACTS are
// served by the trading API, not the data API — data.alpaca.markets returns
// 404 for /options/contracts.
const defaultAlpacaTradingURL = "https://paper-api.alpaca.markets"

// AlpacaOptionsDataService fetches real options data from Alpaca.
// Two hosts, deliberately: snapshots/bars/quotes come from the DATA API,
// contract metadata comes from the TRADING API.
type AlpacaOptionsDataService struct {
	apiKey     string
	secretKey  string
	baseURL    string // data API  — /v1beta1/options/snapshots
	tradingURL string // trading API — /v2/options/contracts
	logger     *logrus.Logger
	client     *http.Client
}

// NewAlpacaOptionsDataService creates a new Alpaca options data service.
// tradingURL should be cfg.AlpacaBaseURL so the contracts host follows
// whichever account (paper or live) the sandbox is configured against; an
// empty value falls back to the paper host.
func NewAlpacaOptionsDataService(apiKey, secretKey, tradingURL string) *AlpacaOptionsDataService {
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})

	trimmed := strings.TrimRight(strings.TrimSpace(tradingURL), "/")
	if trimmed == "" {
		trimmed = defaultAlpacaTradingURL
	}

	return &AlpacaOptionsDataService{
		apiKey:     apiKey,
		secretKey:  secretKey,
		baseURL:    "https://data.alpaca.markets",
		tradingURL: trimmed,
		logger:     logger,
		client:     &http.Client{Timeout: 30 * time.Second},
	}
}
```

- [ ] **Step 4: Point the two contract URLs at the trading host**

In `GetOptionChain`, replace the `url := fmt.Sprintf(...)` block (lines 155-160):

```go
	url := fmt.Sprintf("%s/v2/options/contracts?underlying_symbols=%s&expiration_date=%s",
		s.tradingURL,
		underlying,
		expirationDate.Format("2006-01-02"),
	)
```

In `FindOptionsNearDTE`, replace its `url := fmt.Sprintf(...)` block (lines 222-227):

```go
	url := fmt.Sprintf("%s/v2/options/contracts?underlying_symbols=%s&expiration_date_gte=%s&expiration_date_lte=%s&type=call",
		s.tradingURL,
		underlying,
		startDate.Format("2006-01-02"),
		endDate.Format("2006-01-02"),
	)
```

- [ ] **Step 5: Update the three constructor call sites**

In `cmd/bot/main.go`, change all three lines to pass `cfg.AlpacaBaseURL`:

```go
// line 494
		hedgeOptionsData := services.NewAlpacaOptionsDataService(cfg.AlpacaAPIKey, cfg.AlpacaSecretKey, cfg.AlpacaBaseURL)
// line 522
		verticalOptionsData := services.NewAlpacaOptionsDataService(cfg.AlpacaAPIKey, cfg.AlpacaSecretKey, cfg.AlpacaBaseURL)
// line 567
		optDataSvc := services.NewAlpacaOptionsDataService(cfg.AlpacaAPIKey, cfg.AlpacaSecretKey, cfg.AlpacaBaseURL)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `go build ./... && go test ./services/... -run 'TestGetOptionChain_UsesTradingHostAndV2Path|TestNewAlpacaOptionsDataService|TestGetOptionSnapshot' -v`
Expected: PASS, including the pre-existing `TestGetOptionSnapshot_UsesSymbolsQueryParam` (snapshots must still use `baseURL`).

- [ ] **Step 7: Commit**

```bash
git add services/alpaca_options_data.go services/alpaca_options_data_chain_test.go cmd/bot/main.go
git commit -m "fix(options): fetch option contracts from the trading API, not the data API"
```

---

### Task 2: Parse string-typed strike_price and open_interest

**Files:**
- Modify: `services/alpaca_options_data.go:86-95` (`AlpacaOptionChainContract`), `:152-211` (`GetOptionChain` body)
- Test: `services/alpaca_options_data_chain_test.go`

**Interfaces:**
- Consumes: `newChainTestService(tradingURL, dataURL string)` from Task 1.
- Produces: `func (s *AlpacaOptionsDataService) fetchContracts(ctx context.Context, params neturl.Values) (map[string]*interfaces.OptionContract, error)` and `func (s *AlpacaOptionsDataService) toOptionContract(ac AlpacaOptionChainContract) (*interfaces.OptionContract, bool)`. Both are used by Tasks 3 and 4.

- [ ] **Step 1: Write the failing test**

Append to `services/alpaca_options_data_chain_test.go`:

```go
// contractJSON renders one Alpaca contract with the STRING-typed numerics
// Alpaca actually sends (strike_price:"654", open_interest:"4669").
func contractJSON(symbol, typ, strike, oi string) string {
	return `{"symbol":"` + symbol + `","underlying_symbol":"QQQ",` +
		`"expiration_date":"2026-09-18","type":"` + typ + `",` +
		`"strike_price":"` + strike + `","open_interest":"` + oi + `"}`
}

func chainPageJSON(token string, contracts ...string) string {
	tok := "null"
	if token != "" {
		tok = `"` + token + `"`
	}
	body := `{"option_contracts":[`
	for i, c := range contracts {
		if i > 0 {
			body += ","
		}
		body += c
	}
	return body + `],"next_page_token":` + tok + `}`
}

// TestGetOptionChain_ParsesStringTypedNumerics is the regression test for the
// decode failure: Alpaca sends strike_price and open_interest as JSON strings,
// and the struct declared them float64/int64, so Decode errored on every call.
func TestGetOptionChain_ParsesStringTypedNumerics(t *testing.T) {
	trading := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(chainPageJSON("",
			contractJSON("QQQ260918P00654000", "put", "654", "4669"))))
	}))
	defer trading.Close()

	s := newChainTestService(trading.URL, "http://unused.invalid")
	chain, err := s.GetOptionChain(context.Background(), "QQQ", time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("GetOptionChain returned error: %v", err)
	}
	c := chain["QQQ260918P00654000"]
	if c == nil {
		t.Fatalf("contract missing from chain; got %d entries", len(chain))
	}
	if c.StrikePrice != 654 {
		t.Errorf("StrikePrice = %v, want 654", c.StrikePrice)
	}
	if c.OpenInterest != 4669 {
		t.Errorf("OpenInterest = %v, want 4669", c.OpenInterest)
	}
	if c.ContractType != "put" {
		t.Errorf("ContractType = %q, want %q", c.ContractType, "put")
	}
	if !c.ExpirationDate.Equal(time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("ExpirationDate = %v, want 2026-09-18", c.ExpirationDate)
	}
}

// TestGetOptionChain_SkipsMalformedContractWithoutFailingChain: one bad row
// must not blank an otherwise usable chain. A bad strike is unusable (strike
// selection depends on it); a bad open_interest is informational, so the
// contract is kept with OI 0.
func TestGetOptionChain_SkipsMalformedContractWithoutFailingChain(t *testing.T) {
	trading := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(chainPageJSON("",
			contractJSON("QQQ260918P00654000", "put", "654", "4669"),
			contractJSON("QQQ260918P00BADXX", "put", "not-a-number", "1"),
			contractJSON("QQQ260918P00585000", "put", "585", "bad-oi"))))
	}))
	defer trading.Close()

	s := newChainTestService(trading.URL, "http://unused.invalid")
	chain, err := s.GetOptionChain(context.Background(), "QQQ", time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("GetOptionChain returned error: %v", err)
	}
	if len(chain) != 2 {
		t.Fatalf("chain size = %d, want 2 (bad strike dropped, bad OI kept)", len(chain))
	}
	if chain["QQQ260918P00BADXX"] != nil {
		t.Error("contract with unparseable strike must be dropped")
	}
	kept := chain["QQQ260918P00585000"]
	if kept == nil {
		t.Fatal("contract with unparseable open_interest must be kept")
	}
	if kept.OpenInterest != 0 {
		t.Errorf("OpenInterest = %d, want 0 for an unparseable value", kept.OpenInterest)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/... -run 'TestGetOptionChain_ParsesStringTypedNumerics|TestGetOptionChain_SkipsMalformed' -v`
Expected: FAIL — `failed to decode chain: json: cannot unmarshal string into Go struct field ... of type float64`.

- [ ] **Step 3: Retype the struct fields**

In `services/alpaca_options_data.go`, add `"strconv"` to the import block and replace `AlpacaOptionChainContract` (lines 86-95):

```go
// AlpacaOptionChainContract represents contract metadata.
// NOTE: Alpaca serialises strike_price and open_interest as JSON STRINGS
// ("654", "4669"). Declaring them float64/int64 makes the whole response
// fail to decode — parse them per contract instead.
type AlpacaOptionChainContract struct {
	Symbol           string `json:"symbol"`
	UnderlyingSymbol string `json:"underlying_symbol"`
	ExpirationDate   string `json:"expiration_date"`
	StrikePrice      string `json:"strike_price"`
	Type             string `json:"type"` // "call" or "put"
	Style            string `json:"style"`
	OpenInterest     string `json:"open_interest"`
}
```

- [ ] **Step 4: Add the mapper and the shared fetch helper**

Add these two methods to `services/alpaca_options_data.go` (place them immediately above `GetOptionChain`):

```go
// toOptionContract maps one Alpaca contract to the internal type. Returns
// ok=false for a contract that cannot be used at all — a bad strike or a bad
// expiration — so one malformed row degrades itself, not the whole chain.
func (s *AlpacaOptionsDataService) toOptionContract(ac AlpacaOptionChainContract) (*interfaces.OptionContract, bool) {
	strike, err := strconv.ParseFloat(ac.StrikePrice, 64)
	if err != nil {
		s.logger.WithFields(logrus.Fields{
			"symbol":       ac.Symbol,
			"strike_price": ac.StrikePrice,
		}).Debug("skipping option contract with unparseable strike_price")
		return nil, false
	}
	expDate, err := time.Parse("2006-01-02", ac.ExpirationDate)
	if err != nil {
		s.logger.WithFields(logrus.Fields{
			"symbol":          ac.Symbol,
			"expiration_date": ac.ExpirationDate,
		}).Debug("skipping option contract with unparseable expiration_date")
		return nil, false
	}
	// open_interest is informational on the hedge path — never drop a
	// contract over it.
	oi, err := strconv.ParseInt(ac.OpenInterest, 10, 64)
	if err != nil {
		oi = 0
	}
	return &interfaces.OptionContract{
		Symbol:           ac.Symbol,
		UnderlyingSymbol: ac.UnderlyingSymbol,
		ContractType:     ac.Type,
		StrikePrice:      strike,
		ExpirationDate:   expDate,
		DTE:              int(time.Until(expDate).Hours() / 24),
		OpenInterest:     oi,
	}, true
}

// fetchContracts issues a GET against the trading API's option-contracts
// endpoint with the caller's query params and returns the decoded contracts
// keyed by OCC symbol. Single-page for now; Task 3 adds pagination.
func (s *AlpacaOptionsDataService) fetchContracts(ctx context.Context, params neturl.Values) (map[string]*interfaces.OptionContract, error) {
	endpoint := fmt.Sprintf("%s/v2/options/contracts?%s", s.tradingURL, params.Encode())

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("APCA-API-KEY-ID", s.apiKey)
	req.Header.Set("APCA-API-SECRET-KEY", s.secretKey)

	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch option contracts: %w", err)
	}
	body, readErr := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
	}
	if readErr != nil {
		return nil, fmt.Errorf("failed to read contracts response: %w", readErr)
	}

	var chainResp AlpacaOptionChainResponse
	if err := json.Unmarshal(body, &chainResp); err != nil {
		return nil, fmt.Errorf("failed to decode chain: %w", err)
	}

	contracts := make(map[string]*interfaces.OptionContract)
	for _, ac := range chainResp.OptionContracts {
		if c, ok := s.toOptionContract(ac); ok {
			contracts[c.Symbol] = c
		}
	}
	return contracts, nil
}
```

- [ ] **Step 5: Reduce GetOptionChain to a wrapper**

Replace the entire body of `GetOptionChain` (lines 152-211 — from the `// GetOptionChain retrieves...` comment through its closing `}`) with:

```go
// GetOptionChain retrieves every listed contract for an underlying at ONE
// exact expiration date.
func (s *AlpacaOptionsDataService) GetOptionChain(ctx context.Context, underlying string, expirationDate time.Time) (map[string]*interfaces.OptionContract, error) {
	params := neturl.Values{}
	params.Set("underlying_symbols", underlying)
	params.Set("expiration_date", expirationDate.Format("2006-01-02"))

	contracts, err := s.fetchContracts(ctx, params)
	if err != nil {
		return nil, err
	}
	s.logger.WithFields(logrus.Fields{
		"underlying": underlying,
		"expiration": expirationDate.Format("2006-01-02"),
		"count":      len(contracts),
	}).Debug("Fetched option chain")
	return contracts, nil
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `go build ./... && go test ./services/... -run 'TestGetOptionChain' -v`
Expected: PASS (all three `TestGetOptionChain_*` tests, including Task 1's host test).

- [ ] **Step 7: Commit**

```bash
git add services/alpaca_options_data.go services/alpaca_options_data_chain_test.go
git commit -m "fix(options): parse Alpaca's string-typed strike_price and open_interest"
```

---

### Task 3: Follow pagination so puts are not lost

**Files:**
- Modify: `services/alpaca_options_data.go` (`fetchContracts`)
- Test: `services/alpaca_options_data_chain_test.go`

**Interfaces:**
- Consumes: `fetchContracts`, `toOptionContract` (Task 2); `newChainTestService`, `contractJSON`, `chainPageJSON` (Tasks 1–2).
- Produces: package consts `contractsPageLimit = 10000`, `contractsMaxPages = 20`. `fetchContracts` keeps its signature.

- [ ] **Step 1: Write the failing test**

Append to `services/alpaca_options_data_chain_test.go`:

```go
// TestGetOptionChain_FollowsPaginationSoPutsSurvive is the regression test for
// the defect that blocked the hedge even after the host and type fixes:
// Alpaca returns CALLS first and pages at 100, so page 1 of a QQQ expiry
// contains zero puts. nearestPut then returned nil for both legs and openNew
// skipped with "no valid strike pair (degenerate chain)".
func TestGetOptionChain_FollowsPaginationSoPutsSurvive(t *testing.T) {
	var pages int
	trading := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pages++
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("page_token") == "" {
			// Page 1: calls only, mirroring Alpaca's ordering.
			_, _ = w.Write([]byte(chainPageJSON("MTAw",
				contractJSON("QQQ260918C00654000", "call", "654", "10"))))
			return
		}
		_, _ = w.Write([]byte(chainPageJSON("",
			contractJSON("QQQ260918P00654000", "put", "654", "20"))))
	}))
	defer trading.Close()

	s := newChainTestService(trading.URL, "http://unused.invalid")
	chain, err := s.GetOptionChain(context.Background(), "QQQ", time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("GetOptionChain returned error: %v", err)
	}
	if pages != 2 {
		t.Errorf("server saw %d requests, want 2 (pagination not followed)", pages)
	}
	if len(chain) != 2 {
		t.Fatalf("chain size = %d, want 2 (union of both pages)", len(chain))
	}
	if chain["QQQ260918P00654000"] == nil {
		t.Error("put from page 2 missing — pagination must be followed or the hedge cannot pick strikes")
	}
}

// TestGetOptionChain_RequestsLargeLimit: asking for a big page keeps the
// common case to a single round trip.
func TestGetOptionChain_RequestsLargeLimit(t *testing.T) {
	var gotLimit string
	trading := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotLimit = r.URL.Query().Get("limit")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(chainPageJSON("")))
	}))
	defer trading.Close()

	s := newChainTestService(trading.URL, "http://unused.invalid")
	if _, err := s.GetOptionChain(context.Background(), "QQQ", time.Now()); err != nil {
		t.Fatalf("GetOptionChain returned error: %v", err)
	}
	if gotLimit != "10000" {
		t.Errorf("limit = %q, want %q", gotLimit, "10000")
	}
}

// TestGetOptionChain_PageCapErrorsRatherThanReturningPartial: a server that
// never stops paging must not silently yield a truncated chain — a partial
// chain produces wrong strikes, which is worse than skipping the beat.
func TestGetOptionChain_PageCapErrorsRatherThanReturningPartial(t *testing.T) {
	var pages int
	trading := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pages++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(chainPageJSON("always-more",
			contractJSON("QQQ260918P00654000", "put", "654", "1"))))
	}))
	defer trading.Close()

	s := newChainTestService(trading.URL, "http://unused.invalid")
	_, err := s.GetOptionChain(context.Background(), "QQQ", time.Now())
	if err == nil {
		t.Fatal("expected an error when the page cap is hit, got nil")
	}
	if pages != contractsMaxPages {
		t.Errorf("server saw %d requests, want the %d-page cap", pages, contractsMaxPages)
	}
}

// TestGetOptionChain_PropagatesNon200 guards against a regression that
// swallows the exact failure mode this whole repair exists to fix.
func TestGetOptionChain_PropagatesNon200(t *testing.T) {
	trading := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"Not Found"}`))
	}))
	defer trading.Close()

	s := newChainTestService(trading.URL, "http://unused.invalid")
	if _, err := s.GetOptionChain(context.Background(), "QQQ", time.Now()); err == nil {
		t.Fatal("expected an error for a 404 response, got nil")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/... -run 'TestGetOptionChain_FollowsPagination|TestGetOptionChain_RequestsLargeLimit|TestGetOptionChain_PageCap' -v`
Expected: compile failure on `contractsMaxPages` (undefined), and once that resolves, pagination/limit assertions fail.

- [ ] **Step 3: Add pagination to fetchContracts**

In `services/alpaca_options_data.go`, add the consts above `toOptionContract`:

```go
const (
	// contractsPageLimit asks for the whole chain in one round trip. A single
	// QQQ expiry is ~518 contracts; the default page size is 100.
	contractsPageLimit = 10000
	// contractsMaxPages bounds the token loop so a misbehaving server cannot
	// hang the 17:00 ET hedge heartbeat.
	contractsMaxPages = 20
)
```

Replace the body of `fetchContracts` with the paginated version:

```go
// fetchContracts issues paginated GETs against the trading API's
// option-contracts endpoint with the caller's query params and returns every
// contract across all pages, keyed by OCC symbol.
//
// Pagination is load-bearing, not a nicety: Alpaca returns calls before puts,
// so reading only the first page of a QQQ expiry yields zero puts.
func (s *AlpacaOptionsDataService) fetchContracts(ctx context.Context, params neturl.Values) (map[string]*interfaces.OptionContract, error) {
	contracts := make(map[string]*interfaces.OptionContract)
	pageToken := ""

	for page := 0; page < contractsMaxPages; page++ {
		q := neturl.Values{}
		for k, vs := range params {
			for _, v := range vs {
				q.Add(k, v)
			}
		}
		q.Set("limit", strconv.Itoa(contractsPageLimit))
		if pageToken != "" {
			q.Set("page_token", pageToken)
		}
		endpoint := fmt.Sprintf("%s/v2/options/contracts?%s", s.tradingURL, q.Encode())

		req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("APCA-API-KEY-ID", s.apiKey)
		req.Header.Set("APCA-API-SECRET-KEY", s.secretKey)

		resp, err := s.client.Do(req)
		if err != nil {
			return nil, fmt.Errorf("failed to fetch option contracts: %w", err)
		}
		body, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
		}
		if readErr != nil {
			return nil, fmt.Errorf("failed to read contracts response: %w", readErr)
		}

		var chainResp AlpacaOptionChainResponse
		if err := json.Unmarshal(body, &chainResp); err != nil {
			return nil, fmt.Errorf("failed to decode chain: %w", err)
		}
		for _, ac := range chainResp.OptionContracts {
			if c, ok := s.toOptionContract(ac); ok {
				contracts[c.Symbol] = c
			}
		}
		if chainResp.NextPageToken == "" {
			return contracts, nil
		}
		pageToken = chainResp.NextPageToken
	}

	// Refuse to hand back a truncated chain: wrong strikes are worse than a
	// skipped beat.
	return nil, fmt.Errorf("option contracts pagination exceeded %d pages — refusing to return a partial chain", contractsMaxPages)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go build ./... && go test ./services/... -run 'TestGetOptionChain' -v`
Expected: PASS — all seven `TestGetOptionChain_*` tests.

- [ ] **Step 5: Commit**

```bash
git add services/alpaca_options_data.go services/alpaca_options_data_chain_test.go
git commit -m "fix(options): follow contract pagination so puts are not truncated away"
```

---

### Task 4: Add GetOptionChainRange

**Files:**
- Modify: `services/alpaca_options_data.go` (new method; `FindOptionsNearDTE` refactor)
- Test: `services/alpaca_options_data_chain_test.go`

**Interfaces:**
- Consumes: `fetchContracts` (Tasks 2–3).
- Produces: `func (s *AlpacaOptionsDataService) GetOptionChainRange(ctx context.Context, underlying string, gte, lte time.Time) (map[string]*interfaces.OptionContract, error)` — consumed by Task 6's `hedgeChainFetcher`.

- [ ] **Step 1: Write the failing test**

Append to `services/alpaca_options_data_chain_test.go`:

```go
// TestGetOptionChainRange_UsesDateRangeParams locks the query shape the hedge
// needs. A single exact expiration_date cannot answer "which expiries exist in
// the 45-60 DTE band" — at that horizon only monthlies are listed, so an exact
// probe date almost never matches one.
func TestGetOptionChainRange_UsesDateRangeParams(t *testing.T) {
	var gotPath, gotGte, gotLte, gotExact string
	trading := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotGte = r.URL.Query().Get("expiration_date_gte")
		gotLte = r.URL.Query().Get("expiration_date_lte")
		gotExact = r.URL.Query().Get("expiration_date")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(chainPageJSON("",
			contractJSON("QQQ260918P00654000", "put", "654", "1"))))
	}))
	defer trading.Close()

	s := newChainTestService(trading.URL, "http://unused.invalid")
	chain, err := s.GetOptionChainRange(context.Background(), "QQQ",
		time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC),
		time.Date(2026, 9, 29, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("GetOptionChainRange returned error: %v", err)
	}
	if gotPath != "/v2/options/contracts" {
		t.Errorf("path = %q, want %q", gotPath, "/v2/options/contracts")
	}
	if gotGte != "2026-09-14" || gotLte != "2026-09-29" {
		t.Errorf("range = %q..%q, want 2026-09-14..2026-09-29", gotGte, gotLte)
	}
	if gotExact != "" {
		t.Errorf("expiration_date = %q, want it absent on a range query", gotExact)
	}
	if len(chain) != 1 {
		t.Errorf("chain size = %d, want 1", len(chain))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/... -run TestGetOptionChainRange -v`
Expected: compile failure — `s.GetOptionChainRange undefined`.

- [ ] **Step 3: Add the method and refactor FindOptionsNearDTE**

Add immediately after `GetOptionChain` in `services/alpaca_options_data.go`:

```go
// GetOptionChainRange retrieves every listed contract for an underlying whose
// expiration falls within [gte, lte] inclusive. Used to discover which
// expiries actually exist inside a DTE band.
func (s *AlpacaOptionsDataService) GetOptionChainRange(ctx context.Context, underlying string, gte, lte time.Time) (map[string]*interfaces.OptionContract, error) {
	params := neturl.Values{}
	params.Set("underlying_symbols", underlying)
	params.Set("expiration_date_gte", gte.Format("2006-01-02"))
	params.Set("expiration_date_lte", lte.Format("2006-01-02"))

	contracts, err := s.fetchContracts(ctx, params)
	if err != nil {
		return nil, err
	}
	s.logger.WithFields(logrus.Fields{
		"underlying": underlying,
		"gte":        gte.Format("2006-01-02"),
		"lte":        lte.Format("2006-01-02"),
		"count":      len(contracts),
	}).Debug("Fetched option chain range")
	return contracts, nil
}
```

Then replace the whole `FindOptionsNearDTE` function (from its `// FindOptionsNearDTE finds...` comment through its closing `}`) with:

```go
// FindOptionsNearDTE finds call contracts near a target DTE for an underlying.
func (s *AlpacaOptionsDataService) FindOptionsNearDTE(ctx context.Context, underlying string, targetDTE int, tolerance int) (map[string]*interfaces.OptionContract, error) {
	targetDate := time.Now().AddDate(0, 0, targetDTE)

	params := neturl.Values{}
	params.Set("underlying_symbols", underlying)
	params.Set("expiration_date_gte", targetDate.AddDate(0, 0, -tolerance).Format("2006-01-02"))
	params.Set("expiration_date_lte", targetDate.AddDate(0, 0, tolerance).Format("2006-01-02"))
	params.Set("type", "call")

	return s.fetchContracts(ctx, params)
}
```

Delete any now-unused imports the compiler flags.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go build ./... && go test ./services/... -v`
Expected: PASS — the whole services package, including every pre-existing hedge test.

- [ ] **Step 5: Commit**

```bash
git add services/alpaca_options_data.go services/alpaca_options_data_chain_test.go
git commit -m "feat(options): add GetOptionChainRange for DTE-band expiry discovery"
```

---

### Task 5: Add the isThirdFriday helper

**Files:**
- Modify: `services/prophet_hedge_structure.go`
- Test: `services/prophet_hedge_structure_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `func isThirdFriday(t time.Time) bool` — consumed by Task 6.

- [ ] **Step 1: Write the failing test**

Append to `services/prophet_hedge_structure_test.go`:

```go
func TestIsThirdFriday(t *testing.T) {
	cases := []struct {
		name string
		date time.Time
		want bool
	}{
		{"2026-09-18 monthly", time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC), true},
		{"2026-10-16 monthly", time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC), true},
		{"2026-09-11 second Friday", time.Date(2026, 9, 11, 0, 0, 0, 0, time.UTC), false},
		{"2026-09-25 fourth Friday", time.Date(2026, 9, 25, 0, 0, 0, 0, time.UTC), false},
		{"2026-09-16 Wednesday weekly", time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC), false},
		{"2026-09-21 Monday weekly", time.Date(2026, 9, 21, 0, 0, 0, 0, time.UTC), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := isThirdFriday(c.date); got != c.want {
				t.Errorf("isThirdFriday(%s) = %v, want %v", c.date.Format("2006-01-02"), got, c.want)
			}
		})
	}
}
```

`services/prophet_hedge_structure_test.go` currently imports only `testing`, `prophet-trader/interfaces`, and `prophet-trader/models` — **you must add `"time"`** to its import block for the test above to compile.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./services/... -run TestIsThirdFriday -v`
Expected: compile failure — `undefined: isThirdFriday`.

- [ ] **Step 3: Write the helper**

Append to `services/prophet_hedge_structure.go`:

```go
// isThirdFriday reports whether t is the third Friday of its month — the
// standard US monthly option expiration. The third Friday is always in the
// 15th-21st window. Monthlies carry the open interest in the 45-60 DTE band
// the hedge trades; weeklies that far out are thin or unlisted.
func isThirdFriday(t time.Time) bool {
	return t.Weekday() == time.Friday && t.Day() >= 15 && t.Day() <= 21
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./services/... -run TestIsThirdFriday -v`
Expected: PASS (all six subtests).

- [ ] **Step 5: Commit**

```bash
git add services/prophet_hedge_structure.go services/prophet_hedge_structure_test.go
git commit -m "feat(hedge): add isThirdFriday monthly-expiry helper"
```

---

### Task 6: Make pickExpiry query the DTE band

**Files:**
- Modify: `services/prophet_hedge_executor.go` (`hedgeChainFetcher` ~`:23-26`, `pickExpiry` `:381-401`)
- Test: `services/prophet_hedge_executor_test.go` (`hedgeStubChain` `:17-27`, new tests)

**Interfaces:**
- Consumes: `GetOptionChainRange` (Task 4), `isThirdFriday` (Task 5).
- Produces: `hedgeChainFetcher` gains `GetOptionChainRange(ctx context.Context, underlying string, gte, lte time.Time) (map[string]*interfaces.OptionContract, error)`. `hedgeStubChain` gains field `rangeChain map[string]*interfaces.OptionContract`.

- [ ] **Step 1: Extend the test stub**

In `services/prophet_hedge_executor_test.go`, replace the `hedgeStubChain` type and its `GetOptionChain` method (lines 17-24) with:

```go
type hedgeStubChain struct {
	chain      map[string]*interfaces.OptionContract
	rangeChain map[string]*interfaces.OptionContract
	snaps      map[string]*interfaces.OptionContract
}

func (s hedgeStubChain) GetOptionChain(_ context.Context, _ string, _ time.Time) (map[string]*interfaces.OptionContract, error) {
	return s.chain, nil
}

// GetOptionChainRange defaults to `chain` when no explicit rangeChain is set,
// so existing fixtures keep working unchanged.
func (s hedgeStubChain) GetOptionChainRange(_ context.Context, _ string, _, _ time.Time) (map[string]*interfaces.OptionContract, error) {
	if s.rangeChain != nil {
		return s.rangeChain, nil
	}
	return s.chain, nil
}
```

- [ ] **Step 2: Write the failing tests**

Append to `services/prophet_hedge_executor_test.go`:

```go
// hedgeExpiryFixture builds a chain of puts at the given expiries, all priced
// identically — only the expiration dates matter to pickExpiry.
func hedgeExpiryFixture(exps ...time.Time) map[string]*interfaces.OptionContract {
	chain := map[string]*interfaces.OptionContract{}
	for i, e := range exps {
		sym := fmt.Sprintf("QQQ_P475_%d", i)
		chain[sym] = &interfaces.OptionContract{
			Symbol: sym, ContractType: "put", StrikePrice: 475, ExpirationDate: e,
		}
	}
	return chain
}

// TestPickExpiry_PrefersMonthlyOverEarlierWeekly: the band query can surface
// both a weekly and a monthly. The monthly carries the open interest, and the
// short leg's liquidity is not covered by the spread guard, so the monthly
// wins even though the weekly has a lower DTE.
func TestPickExpiry_PrefersMonthlyOverEarlierWeekly(t *testing.T) {
	now := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	weekly := time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC)  // Wed, DTE 47
	monthly := time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC) // 3rd Fri, DTE 49

	ex := NewProphetHedgeExecutor(nil, hedgeStubRegime{},
		hedgeStubChain{rangeChain: hedgeExpiryFixture(weekly, monthly)},
		nil, nil, nil, nil)

	got, ok := ex.pickExpiry(context.Background(), selectStructure(RegimeGateStatus{}, 0), now)
	if !ok {
		t.Fatal("pickExpiry returned ok=false, want a monthly expiry")
	}
	if !got.Equal(monthly) {
		t.Errorf("picked %s, want the monthly %s", got.Format("2006-01-02"), monthly.Format("2006-01-02"))
	}
}

// TestPickExpiry_FallsBackToNearestWhenNoMonthly keeps the hedge tradable in a
// band that happens to contain no third Friday.
func TestPickExpiry_FallsBackToNearestWhenNoMonthly(t *testing.T) {
	now := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	early := time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC) // DTE 47
	late := time.Date(2026, 9, 23, 0, 0, 0, 0, time.UTC)  // DTE 54

	ex := NewProphetHedgeExecutor(nil, hedgeStubRegime{},
		hedgeStubChain{rangeChain: hedgeExpiryFixture(early, late)},
		nil, nil, nil, nil)

	got, ok := ex.pickExpiry(context.Background(), selectStructure(RegimeGateStatus{}, 0), now)
	if !ok {
		t.Fatal("pickExpiry returned ok=false, want the nearest in-band expiry")
	}
	if !got.Equal(early) {
		t.Errorf("picked %s, want the nearest in-band %s", got.Format("2006-01-02"), early.Format("2006-01-02"))
	}
}

// TestPickExpiry_EmptyBandSkipsCleanly: the real-world case that produced 52
// days of silent skips — no listed expiry in the band.
func TestPickExpiry_EmptyBandSkipsCleanly(t *testing.T) {
	now := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	ex := NewProphetHedgeExecutor(nil, hedgeStubRegime{},
		hedgeStubChain{rangeChain: map[string]*interfaces.OptionContract{}},
		nil, nil, nil, nil)

	if _, ok := ex.pickExpiry(context.Background(), selectStructure(RegimeGateStatus{}, 0), now); ok {
		t.Error("pickExpiry returned ok=true on an empty band, want false")
	}
}

// TestPickExpiry_IgnoresOutOfBandExpiries: the API range is inclusive by date,
// so the DTE filter must still reject anything outside [DTEMin, DTEMax].
func TestPickExpiry_IgnoresOutOfBandExpiries(t *testing.T) {
	now := time.Date(2026, 7, 31, 12, 0, 0, 0, time.UTC)
	tooSoon := time.Date(2026, 8, 21, 0, 0, 0, 0, time.UTC) // 3rd Fri, DTE 21
	inBand := time.Date(2026, 9, 18, 0, 0, 0, 0, time.UTC)  // 3rd Fri, DTE 49

	ex := NewProphetHedgeExecutor(nil, hedgeStubRegime{},
		hedgeStubChain{rangeChain: hedgeExpiryFixture(tooSoon, inBand)},
		nil, nil, nil, nil)

	got, ok := ex.pickExpiry(context.Background(), selectStructure(RegimeGateStatus{}, 0), now)
	if !ok {
		t.Fatal("pickExpiry returned ok=false, want the in-band monthly")
	}
	if !got.Equal(inBand) {
		t.Errorf("picked %s, want %s", got.Format("2006-01-02"), inBand.Format("2006-01-02"))
	}
}
```

`services/prophet_hedge_executor_test.go` currently imports `context`, `strings`, `testing`, `time`, `prophet-trader/interfaces`, and `prophet-trader/models` — **you must add `"fmt"`** for `hedgeExpiryFixture` to compile.

Note on the nils in these tests: `NewProphetHedgeExecutor` replaces a nil logger with a discard logger, and `pickExpiry` touches only `e.chain`, so passing nil for the ledger, trader, account fetcher, and guard is safe here.

- [ ] **Step 3: Run tests to verify they fail**

Run: `go test ./services/... -run TestPickExpiry -v`
Expected: FAIL — `TestPickExpiry_PrefersMonthlyOverEarlierWeekly` picks the weekly (current min-DTE behavior), and the interface does not yet require `GetOptionChainRange`.

- [ ] **Step 4: Extend the interface and rewrite pickExpiry**

In `services/prophet_hedge_executor.go`, add the method to `hedgeChainFetcher`:

```go
type hedgeChainFetcher interface {
	GetOptionChain(ctx context.Context, underlying string, exp time.Time) (map[string]*interfaces.OptionContract, error)
	GetOptionChainRange(ctx context.Context, underlying string, gte, lte time.Time) (map[string]*interfaces.OptionContract, error)
	GetOptionSnapshot(ctx context.Context, optionSymbol string) (*interfaces.OptionContract, error)
}
```

Replace `pickExpiry` (lines 381-401) with:

```go
// pickExpiry finds the expiry the hedge should trade inside [DTEMin, DTEMax].
//
// It queries the whole band, not a single date. The previous implementation
// probed one exact date (now + midpoint days) and asked GetOptionChain for it,
// but that endpoint matches an EXACT expiration_date — so the returned chain
// only ever held that one date and the band loop below could never scan. At
// 45-60 DTE only monthlies are listed, so the probe date almost never matched
// a real expiry and the hedge skipped every day.
//
// Monthlies (third Fridays) are preferred over an earlier in-band weekly:
// they carry the open interest at this horizon, and the trade guard only
// checks the LONG leg's spread, so a thin short leg would go unchecked.
func (e *ProphetHedgeExecutor) pickExpiry(ctx context.Context, p SpreadProfile, now time.Time) (time.Time, bool) {
	gte := now.AddDate(0, 0, p.DTEMin)
	lte := now.AddDate(0, 0, p.DTEMax)
	chain, err := e.chain.GetOptionChainRange(ctx, "QQQ", gte, lte)
	if err != nil || len(chain) == 0 {
		return time.Time{}, false
	}

	// Calendar-day DTE: contract expirations land on midnight UTC while `now`
	// carries a time of day, so an instant-based subtraction truncates a
	// boundary expiry out of the band.
	today := now.UTC().Truncate(24 * time.Hour)

	var bestMonthly, bestAny time.Time
	bestMonthlyDTE, bestAnyDTE := -1, -1
	for _, c := range chain {
		dte := int(c.ExpirationDate.UTC().Truncate(24*time.Hour).Sub(today).Hours() / 24)
		if dte < p.DTEMin || dte > p.DTEMax {
			continue
		}
		if bestAnyDTE == -1 || dte < bestAnyDTE {
			bestAnyDTE, bestAny = dte, c.ExpirationDate
		}
		if isThirdFriday(c.ExpirationDate) && (bestMonthlyDTE == -1 || dte < bestMonthlyDTE) {
			bestMonthlyDTE, bestMonthly = dte, c.ExpirationDate
		}
	}

	if bestMonthlyDTE != -1 {
		return bestMonthly, true
	}
	if bestAnyDTE != -1 {
		return bestAny, true
	}
	return time.Time{}, false
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go build ./... && go test ./services/... -v`
Expected: PASS — the four new `TestPickExpiry_*` tests plus every pre-existing hedge test (`TestOpenNew_ArmedPlacesSpread` and friends use a single `exp` at `time.Now()+50d`, which stays in band and resolves identically under both branches).

- [ ] **Step 6: Commit**

```bash
git add services/prophet_hedge_executor.go services/prophet_hedge_executor_test.go
git commit -m "fix(hedge): query the whole DTE band for expiries, preferring monthlies"
```

---

### Task 7: Full verification and deploy

**Files:**
- No source changes. Verification only.

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: a row in `prophet_hedge_spreads` — the acceptance criterion.

- [ ] **Step 1: Run the full test suite**

Run: `go test ./... 2>&1 | tail -40`
Expected: PASS across all packages. Investigate any failure before proceeding — do not deploy on a red suite.

- [ ] **Step 2: Run go vet**

Run: `go vet ./services/... ./cmd/...`
Expected: no output.

- [ ] **Step 3: Force-rebuild the Go binary**

```bash
go build -o prophet_bot.exe ./cmd/bot
```

This step is mandatory and easy to skip. Restarting Node alone will NOT rebuild: `_ensureBinary` only builds when `prophet_bot.exe` is absent, so a stale binary silently redeploys the broken code.

- [ ] **Step 4: Restart Node and confirm the scheduler boots**

Restart the Node orchestrator so it re-spawns the DefensiveProphet sandbox bot. Confirm this line appears in the bot's boot log:

```
Defensive-Prophet hedge scheduler started (ENABLE_PROPHET_DEFENSIVE=true)
```

- [ ] **Step 5: Confirm the hedge actually places a spread**

After the next 17:00 ET heartbeat, check the ledger:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/sandboxes/sbx_565f5239/prophet_trader.db', {readonly:true});
console.log('spreads:', db.prepare('select count(*) c from prophet_hedge_spreads').get().c);
console.log(JSON.stringify(db.prepare('select * from prophet_hedge_spreads order by rowid desc limit 3').all(), null, 2));
console.log('session:', JSON.stringify(db.prepare('select * from prophet_hedge_session').all()));
"
```

Expected: at least one row, with a long put ~5% OTM and a short put ~15% OTM on a third-Friday expiry 45-60 days out.

**If the count is still 0**, the heartbeat is emitting a skip. Every one of the four defects produced a confident-looking skip message rather than an error, so do not assume success from a clean log — read the actual skip reason before concluding the repair worked.

- [ ] **Step 6: Commit nothing; report the outcome**

No code change in this task. Report: full-suite result, the boot-log line, and the row count with the spread's strikes and expiry.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Defect 1 — wrong host for contracts | Task 1 |
| Defect 2 — `pickExpiry` exact-date probe | Tasks 4 + 6 |
| Defect 3 — string-typed numerics | Task 2 |
| Defect 4 — pagination ignored / page 1 all calls | Task 3 |
| `GetOptionSnapshot` stays on the data host | Task 1 Steps 4, 6 (asserts the pre-existing snapshot test still passes) |
| Constructor takes `cfg.AlpacaBaseURL`; empty falls back | Task 1 Steps 3, 5 + fallback/trim tests |
| Per-contract malformed tolerance (strike drops, OI keeps) | Task 2 |
| No `type=put` filter added to `GetOptionChain` | Honored — Task 2/3/4 params never set `type` except in `FindOptionsNearDTE`, which is call-only by its own contract |
| Monthly preference in `pickExpiry` (flagged, vetoable) | Tasks 5 + 6 |
| Page cap prevents a hung heartbeat | Task 3 (errors rather than returning partial) |
| `hedgeStubChain` gains the new method; suite stays green | Task 6 Step 1 (defaults `rangeChain` to `chain`) |
| Forced `go build` before restart | Task 7 Step 3 |
| Acceptance = a row in `prophet_hedge_spreads` | Task 7 Step 5 |

No spec requirement is unimplemented. Two spec items are deliberately **not** tasks, matching the spec's non-goals: `hedgeDebitCapPct` headroom is a flagged watch item, not a change; the four morning regime skills stay as-is.

**Placeholder scan:** none — every step carries runnable code or an exact command.

**Type consistency:** `fetchContracts(ctx, neturl.Values) (map[string]*interfaces.OptionContract, error)` is defined in Task 2 and used unchanged in Tasks 3 and 4. `toOptionContract(AlpacaOptionChainContract) (*interfaces.OptionContract, bool)` — defined Task 2, used Tasks 2-3. `GetOptionChainRange(ctx, string, time.Time, time.Time)` — defined Task 4, added to the interface and called in Task 6 with matching arity. `isThirdFriday(time.Time) bool` — defined Task 5, called Task 6. `hedgeChainFetcher` is the real interface name (the spec's prose said `hedgeChainProvider`; the code is `hedgeChainFetcher` and this plan uses the code's name throughout).
