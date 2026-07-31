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
