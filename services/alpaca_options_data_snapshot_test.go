package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/sirupsen/logrus"
)

// TestGetOptionSnapshot_UsesSymbolsQueryParam locks the single-contract
// snapshot request shape for AlpacaOptionsDataService (used by the Prophet
// auto-stop monitor). Same constraint as
// GetOptionsQuote: the OCC symbol must go in the `?symbols=` QUERY param, not
// the path (the path segment is the UNDERLYING ticker; Alpaca 400s on a full
// option symbol there). The path-form bug silently disabled the auto-stop
// backstop because every snapshot fetch errored.
func TestGetOptionSnapshot_UsesSymbolsQueryParam(t *testing.T) {
	const symbol = "QQQ260717C00730000"

	var gotPath, gotSymbols string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotSymbols = r.URL.Query().Get("symbols")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"snapshots":{"` + symbol + `":{` +
			`"latestQuote":{"bp":24.67,"ap":24.75},` +
			`"greeks":{"delta":0.53},"impliedVolatility":0.21}}}`))
	}))
	defer srv.Close()

	s := &AlpacaOptionsDataService{
		apiKey:    "k",
		secretKey: "s",
		baseURL:   srv.URL,
		logger:    logrus.New(),
		client:    srv.Client(),
	}

	contract, err := s.GetOptionSnapshot(context.Background(), symbol)
	if err != nil {
		t.Fatalf("GetOptionSnapshot returned error: %v", err)
	}

	if gotPath != "/v1beta1/options/snapshots" {
		t.Errorf("request path = %q, want %q (OCC symbol must not be in the path)", gotPath, "/v1beta1/options/snapshots")
	}
	if gotSymbols != symbol {
		t.Errorf("symbols query param = %q, want %q", gotSymbols, symbol)
	}
	if contract.Bid != 24.67 || contract.Ask != 24.75 {
		t.Errorf("parsed bid/ask = %v/%v, want 24.67/24.75", contract.Bid, contract.Ask)
	}
}
