package controllers

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"prophet-trader/interfaces"
	"prophet-trader/services"
)

type stubDriftBarFetcher struct {
	bars map[string][]*interfaces.Bar
}

func (f *stubDriftBarFetcher) GetHistoricalBars(ctx context.Context, symbol string, start, end time.Time, timeframe string) ([]*interfaces.Bar, error) {
	if b, ok := f.bars[symbol]; ok {
		return b, nil
	}
	return nil, nil
}

type stubDriftEarnings struct{ reports []services.RecentReport }

func (s *stubDriftEarnings) FetchRecentReports(ctx context.Context, now time.Time, days int) ([]services.RecentReport, error) {
	return s.reports, nil
}

// makeMonFriBarsCtl is the controller-side copy of makeMonFriBars (services
// keeps its own copy so test types don't leak across packages).
func makeMonFriBarsCtl(rows []struct {
	Open, High, Low, Close float64
	Vol                    int
}) []*interfaces.Bar {
	start := time.Date(2026, 1, 5, 16, 0, 0, 0, time.UTC) // Mon
	bars := make([]*interfaces.Bar, 0, len(rows))
	day := start
	added := 0
	for added < len(rows) {
		wd := day.Weekday()
		if wd == time.Saturday || wd == time.Sunday {
			day = day.AddDate(0, 0, 1)
			continue
		}
		r := rows[added]
		bars = append(bars, &interfaces.Bar{
			Symbol:    "AAA",
			Timestamp: day,
			Open:      r.Open,
			High:      r.High,
			Low:       r.Low,
			Close:     r.Close,
			Volume:    int64(r.Vol),
		})
		added++
		day = day.AddDate(0, 0, 1)
	}
	return bars
}

func makeAAALikeBars() []*interfaces.Bar {
	rows := make([]struct {
		Open, High, Low, Close float64
		Vol                    int
	}, 220)
	for i := 0; i < 200; i++ {
		rows[i] = struct {
			Open, High, Low, Close float64
			Vol                    int
		}{Open: 100, High: 100.5, Low: 99.5, Close: 100, Vol: 100_000}
	}
	for i := 200; i < 215; i++ {
		c := 100 + 0.4*float64(i-199)
		rows[i] = struct {
			Open, High, Low, Close float64
			Vol                    int
		}{Open: c - 0.2, High: c + 0.2, Low: c - 0.3, Close: c, Vol: 100_000}
	}
	prev := rows[214].Close
	rows[215] = struct {
		Open, High, Low, Close float64
		Vol                    int
	}{Open: prev * 1.06, High: prev*1.06 + 1, Low: prev * 1.05, Close: prev*1.06 + 0.5, Vol: 200_000}
	for i := 216; i < 220; i++ {
		c := rows[i-1].Close + 0.3
		rows[i] = struct {
			Open, High, Low, Close float64
			Vol                    int
		}{Open: c - 0.1, High: c + 0.5, Low: c - 0.2, Close: c, Vol: 200_000}
	}
	bars := makeMonFriBarsCtl(rows)
	// Sanity check: 220 trading days landed.
	if len(bars) != 220 {
		panic("setup: expected 220 bars")
	}
	_ = math.Abs // silence unused-import warning across tests
	return bars
}

func newTestDriftController() *DriftController {
	bars := map[string][]*interfaces.Bar{"AAA": makeAAALikeBars()}
	earningsIdx := len(bars["AAA"]) - 5
	earningsTime := bars["AAA"][earningsIdx].Timestamp
	sigSvc := services.NewDriftSignalService(&stubDriftBarFetcher{bars: bars})
	reports := []services.RecentReport{
		{Ticker: "AAA", Date: earningsTime, Timing: "bmo"},
	}
	cs := services.NewDriftCandidatesService(sigSvc, &stubDriftEarnings{reports: reports}, []string{"AAA"})
	cs.SetRefreshInterval(-1)
	return NewDriftController(cs)
}

func TestDriftController_HandleGetCandidates(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mc := newTestDriftController()
	router := gin.New()
	router.GET("/candidates", mc.HandleGetCandidates)

	req := httptest.NewRequest(http.MethodGet, "/candidates", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	var resp services.DriftCandidatesResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v; body=%s", err, w.Body.String())
	}
	if resp.Count != 1 || resp.Candidates[0].Ticker != "AAA" {
		t.Fatalf("expected AAA candidate; got count=%d candidates=%+v", resp.Count, resp.Candidates)
	}
}

func TestDriftController_HandleGetSignal_OK(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mc := newTestDriftController()
	router := gin.New()
	router.GET("/signal/:symbol", mc.HandleGetSignal)

	bars := makeAAALikeBars()
	dateStr := bars[len(bars)-5].Timestamp.Format("2006-01-02")
	req := httptest.NewRequest(http.MethodGet, "/signal/aaa?earnings_date="+dateStr+"&timing=bmo", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	var sig services.DriftSignal
	if err := json.Unmarshal(w.Body.Bytes(), &sig); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if sig.Ticker != "AAA" {
		t.Errorf("Ticker = %q, want AAA", sig.Ticker)
	}
}

func TestDriftController_HandleGetSignal_MissingEarningsDate(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mc := newTestDriftController()
	router := gin.New()
	router.GET("/signal/:symbol", mc.HandleGetSignal)

	req := httptest.NewRequest(http.MethodGet, "/signal/AAA", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", w.Code, w.Body.String())
	}
}

func TestDriftController_HandleGetSignal_InsufficientHistory(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mc := newTestDriftController()
	router := gin.New()
	router.GET("/signal/:symbol", mc.HandleGetSignal)

	// MISSING returns nil bars from stub → ErrInsufficientDriftHistory.
	req := httptest.NewRequest(http.MethodGet, "/signal/MISSING?earnings_date=2026-05-15&timing=bmo", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422; body=%s", w.Code, w.Body.String())
	}
}

func TestDriftController_HandleGetUniverse(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mc := newTestDriftController()
	router := gin.New()
	router.GET("/universe", mc.HandleGetUniverse)

	req := httptest.NewRequest(http.MethodGet, "/universe", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var resp struct {
		Count    int      `json:"count"`
		Universe []string `json:"universe"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.Count != 1 || resp.Universe[0] != "AAA" {
		t.Fatalf("unexpected universe: %+v", resp)
	}
}
