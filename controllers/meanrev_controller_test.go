package controllers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"prophet-trader/interfaces"
	"prophet-trader/services"
)

// stubMeanRevBarFetcher is a per-symbol map-backed BarFetcher for controller
// tests. Kept separate from the services-package stub to avoid cross-package
// test-symbol leaks.
type stubMeanRevBarFetcher struct {
	bars map[string][]*interfaces.Bar
}

func (f *stubMeanRevBarFetcher) GetHistoricalBars(ctx context.Context, symbol string, start, end time.Time, timeframe string) ([]*interfaces.Bar, error) {
	if b, ok := f.bars[symbol]; ok {
		return b, nil
	}
	return nil, nil // empty bars → ErrInsufficientMeanRevHistory at service layer
}

func makeBarsForController(closes []float64) []*interfaces.Bar {
	start := time.Date(2025, 1, 2, 16, 0, 0, 0, time.UTC)
	bars := make([]*interfaces.Bar, len(closes))
	for i, c := range closes {
		bars[i] = &interfaces.Bar{
			Symbol:    "TEST",
			Timestamp: start.AddDate(0, 0, i),
			Open:      c,
			Close:     c,
			High:      c * 1.01,
			Low:       c * 0.99,
			Volume:    1000,
		}
	}
	return bars
}

// pullbackClosesForController duplicates the helper used in the services
// package tests; kept local so controller tests don't depend on services
// test-package symbols.
func pullbackClosesForController() []float64 {
	L := 220
	closes := make([]float64, L)
	for i := 0; i <= L-6; i++ {
		closes[i] = 100.0 + 0.2*float64(i)
	}
	peak := closes[L-6]
	for i := L - 5; i < L; i++ {
		closes[i] = peak - 0.5*float64(i-(L-6))
	}
	return closes
}

func newTestMeanRevController() *MeanRevController {
	bars := map[string][]*interfaces.Bar{
		"AAA": makeBarsForController(pullbackClosesForController()),
		"SPY": makeBarsForController(pullbackClosesForController()),
	}
	sig := services.NewMeanRevSignalService(&stubMeanRevBarFetcher{bars: bars})
	candidates := services.NewMeanRevCandidatesService(sig, nil, []string{"AAA"}, "normal")
	candidates.SetRefreshInterval(-1) // disable cache for deterministic tests
	return NewMeanRevController(candidates)
}

func TestMeanRevController_HandleGetCandidates(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mc := newTestMeanRevController()
	router := gin.New()
	router.GET("/candidates", mc.HandleGetCandidates)

	req := httptest.NewRequest(http.MethodGet, "/candidates", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	var resp services.MeanRevCandidatesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v; body=%s", err, w.Body.String())
	}
	if resp.Count != 1 || resp.Candidates[0].Ticker != "AAA" {
		t.Fatalf("expected AAA candidate; got %+v", resp.Candidates)
	}
	if resp.BearMode != "normal" {
		t.Errorf("bear_mode = %q, want %q", resp.BearMode, "normal")
	}
}

func TestMeanRevController_HandleGetSignal_OK(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mc := newTestMeanRevController()
	router := gin.New()
	router.GET("/signal/:symbol", mc.HandleGetSignal)

	req := httptest.NewRequest(http.MethodGet, "/signal/aaa", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	var sig services.MeanRevSignal
	if err := json.Unmarshal(w.Body.Bytes(), &sig); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if sig.Ticker != "AAA" {
		t.Errorf("Ticker = %q, want AAA (case normalized)", sig.Ticker)
	}
}

func TestMeanRevController_HandleGetSignal_InsufficientHistory(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mc := newTestMeanRevController()
	router := gin.New()
	router.GET("/signal/:symbol", mc.HandleGetSignal)

	// "MISSING" returns empty bars from stub → ErrInsufficientMeanRevHistory.
	req := httptest.NewRequest(http.MethodGet, "/signal/MISSING", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422; body=%s", w.Code, w.Body.String())
	}
}

func TestMeanRevController_HandleGetUniverse(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mc := newTestMeanRevController()
	router := gin.New()
	router.GET("/universe", mc.HandleGetUniverse)

	req := httptest.NewRequest(http.MethodGet, "/universe", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Count    int      `json:"count"`
		Universe []string `json:"universe"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Count != 1 || resp.Universe[0] != "AAA" {
		t.Fatalf("expected universe=[AAA]; got %+v", resp)
	}
}
