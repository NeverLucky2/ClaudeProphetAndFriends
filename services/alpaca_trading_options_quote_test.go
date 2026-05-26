package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/sirupsen/logrus"
)

// TestGetOptionsQuote_UsesSymbolsQueryParam locks in the correct Alpaca
// options-snapshot request shape. The single-contract snapshot must be fetched
// via the `?symbols=<OCC symbol>` QUERY parameter — NOT by placing the OCC
// symbol in the path (that path segment is the UNDERLYING ticker, and Alpaca
// rejects a full option symbol there with HTTP 400 "invalid underlying
// symbol"). The path-form bug caused GetOptionsQuote to always error, which
// made the Prophet options spread gate fail closed on every open.
func TestGetOptionsQuote_UsesSymbolsQueryParam(t *testing.T) {
	const symbol = "QQQ260717C00730000"

	var gotPath, gotSymbols string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotSymbols = r.URL.Query().Get("symbols")
		w.Header().Set("Content-Type", "application/json")
		// Mirror Alpaca's real snapshots response (keyed by the OCC symbol).
		_, _ = w.Write([]byte(`{"snapshots":{"` + symbol + `":{` +
			`"latestQuote":{"bp":24.67,"ap":24.75,"bs":17,"as":5,"t":"2026-05-26T14:14:47.676693316Z"},` +
			`"latestTrade":{"p":24.14,"t":"2026-05-26T13:59:21.895840496Z"}}}}`))
	}))
	defer srv.Close()

	s := &AlpacaTradingService{
		logger:         logrus.New(),
		httpClient:     srv.Client(),
		optionsDataURL: srv.URL,
	}

	quote, err := s.GetOptionsQuote(context.Background(), symbol)
	if err != nil {
		t.Fatalf("GetOptionsQuote returned error: %v", err)
	}

	if gotPath != "/v1beta1/options/snapshots" {
		t.Errorf("request path = %q, want %q (OCC symbol must not be in the path)", gotPath, "/v1beta1/options/snapshots")
	}
	if gotSymbols != symbol {
		t.Errorf("symbols query param = %q, want %q", gotSymbols, symbol)
	}

	if quote.BidPrice != 24.67 || quote.AskPrice != 24.75 {
		t.Errorf("parsed quote bid/ask = %v/%v, want 24.67/24.75", quote.BidPrice, quote.AskPrice)
	}
	if quote.Timestamp.IsZero() {
		t.Error("parsed quote timestamp is zero; staleness check would fail closed")
	}
	if want := time.Date(2026, 5, 26, 14, 14, 47, 676693316, time.UTC); !quote.Timestamp.Equal(want) {
		t.Errorf("parsed quote timestamp = %v, want %v", quote.Timestamp, want)
	}
}
