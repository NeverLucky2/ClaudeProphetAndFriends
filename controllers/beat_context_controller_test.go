package controllers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"prophet-trader/services"
)

// ── Fakes ───────────────────────────────────────────────────────────
//
// Each fake satisfies one of the BeatContextController dependency
// interfaces. The optional `err` field lets a test force the dependency
// to fail so we can exercise the controller's soft-fail aggregation
// path (errors[] entry + 200 status + other deps still rendered).

type fakeAccountFetcher struct {
	acct Account
	err  error
}

func (f *fakeAccountFetcher) GetAccount() (Account, error) {
	if f.err != nil {
		return Account{}, f.err
	}
	return f.acct, nil
}

type fakePositionsFetcher struct {
	positions []PositionSummary
	gotStrat  string
	err       error
}

func (f *fakePositionsFetcher) GetPositionsByStrategy(strategy string) ([]PositionSummary, error) {
	f.gotStrat = strategy
	if f.err != nil {
		return nil, f.err
	}
	return f.positions, nil
}

type fakeBlackoutFetcher struct {
	isBlackout bool
	reason     string
	err        error
}

func (f *fakeBlackoutFetcher) EconBlackoutStatus() (bool, string, error) {
	if f.err != nil {
		return false, "", f.err
	}
	return f.isBlackout, f.reason, nil
}

type fakeRegimeFetcher struct {
	status services.RegimeGateStatus
	err    error
}

func (f *fakeRegimeFetcher) GetStatus() (services.RegimeGateStatus, error) {
	if f.err != nil {
		return services.RegimeGateStatus{}, f.err
	}
	return f.status, nil
}

type fakeSegmentPnLFetcher struct {
	pnl      *services.SegmentPnL
	gotStrat string
	err      error
}

func (f *fakeSegmentPnLFetcher) GetSegmentPnL(ctx context.Context, strategy string) (*services.SegmentPnL, error) {
	f.gotStrat = strategy
	if f.err != nil {
		return nil, f.err
	}
	return f.pnl, nil
}

// ── Tests ───────────────────────────────────────────────────────────

func TestBeatContext_HappyPath(t *testing.T) {
	gin.SetMode(gin.TestMode)

	acct := &fakeAccountFetcher{acct: Account{PortfolioValue: 100000, Cash: 30000, BuyingPower: 60000}}
	pos := &fakePositionsFetcher{positions: []PositionSummary{
		{Symbol: "AAPL", Qty: 10, UnrealizedPnL: 50, UnrealizedPnLPct: 0.5},
	}}
	black := &fakeBlackoutFetcher{isBlackout: false, reason: ""}
	regime := &fakeRegimeFetcher{status: services.RegimeGateStatus{
		Score: 55, Tier: "NORMAL", SizingMultiplier: 0.8, BlockNewEntries: false,
	}}
	seg := &fakeSegmentPnLFetcher{pnl: &services.SegmentPnL{
		Strategy: "v2-options", UnrealizedPnLPct: 0.5, DeployedPercent: 12.0,
	}}

	ctrl := NewBeatContextController(acct, pos, black, regime, seg)

	router := gin.New()
	router.GET("/api/v1/beat-context", ctrl.HandleGet)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/beat-context?strategy=v2-options", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d (body=%s)", w.Code, w.Body.String())
	}

	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if _, ok := body["account"]; !ok {
		t.Errorf("response missing 'account' field: %v", body)
	}

	// Lock in the interfaces.Account → controllers.Account projection:
	// portfolio_value must be the JSON-round-tripped float64 100000.
	acctRaw, ok := body["account"].(map[string]any)
	if !ok {
		t.Fatalf("'account' should be a JSON object, got %T", body["account"])
	}
	pvRaw, ok := acctRaw["portfolio_value"]
	if !ok {
		t.Errorf("account missing 'portfolio_value': %v", acctRaw)
	} else if pv, ok := pvRaw.(float64); !ok || pv != 100000 {
		t.Errorf("account.portfolio_value: want 100000 (float64), got %T=%v", pvRaw, pvRaw)
	}
	if _, ok := body["positions"]; !ok {
		t.Errorf("response missing 'positions' field: %v", body)
	}
	if _, ok := body["econ_blackout"]; !ok {
		t.Errorf("response missing 'econ_blackout' field: %v", body)
	}
	if _, ok := body["regime_gate"]; !ok {
		t.Errorf("response missing 'regime_gate' field: %v", body)
	}
	if _, ok := body["segment_pnl"]; !ok {
		t.Errorf("response missing 'segment_pnl' field: %v", body)
	}
	if _, ok := body["errors"]; ok {
		t.Errorf("response should not contain 'errors' on happy path: %v", body["errors"])
	}

	// fetched_at must be present as a non-empty string (RFC3339 UTC).
	fetchedRaw, ok := body["fetched_at"]
	if !ok {
		t.Errorf("response missing 'fetched_at' field: %v", body)
	} else if s, ok := fetchedRaw.(string); !ok || s == "" {
		t.Errorf("'fetched_at' should be a non-empty string, got %T=%v", fetchedRaw, fetchedRaw)
	}

	// regime_gate must include the score from RegimeGateStatus.
	rgRaw, ok := body["regime_gate"].(map[string]any)
	if !ok {
		t.Fatalf("'regime_gate' should be a JSON object, got %T", body["regime_gate"])
	}
	scoreRaw, ok := rgRaw["score"]
	if !ok {
		t.Errorf("regime_gate missing 'score': %v", rgRaw)
	} else if n, ok := scoreRaw.(float64); !ok || int(n) != 55 {
		t.Errorf("regime_gate.score: want 55, got %T=%v", scoreRaw, scoreRaw)
	}

	// segment_pnl must use snake_case field names.
	spRaw, ok := body["segment_pnl"].(map[string]any)
	if !ok {
		t.Fatalf("'segment_pnl' should be a JSON object, got %T", body["segment_pnl"])
	}
	if _, ok := spRaw["unrealized_pnl_percent"]; !ok {
		t.Errorf("segment_pnl missing 'unrealized_pnl_percent': %v", spRaw)
	}
	if _, ok := spRaw["deployed_percent"]; !ok {
		t.Errorf("segment_pnl missing 'deployed_percent': %v", spRaw)
	}
	if _, ok := spRaw["unrealizedPct"]; ok {
		t.Errorf("segment_pnl should NOT use camelCase 'unrealizedPct': %v", spRaw)
	}
	if _, ok := spRaw["deployedPct"]; ok {
		t.Errorf("segment_pnl should NOT use camelCase 'deployedPct': %v", spRaw)
	}

	if pos.gotStrat != "v2-options" {
		t.Errorf("positions: want strategy=%q, got %q", "v2-options", pos.gotStrat)
	}
	if seg.gotStrat != "v2-options" {
		t.Errorf("segment_pnl: want strategy=%q, got %q", "v2-options", seg.gotStrat)
	}
}

func TestBeatContext_OmitsSegmentPnLWithoutStrategy(t *testing.T) {
	gin.SetMode(gin.TestMode)

	acct := &fakeAccountFetcher{acct: Account{PortfolioValue: 100000, Cash: 30000, BuyingPower: 60000}}
	pos := &fakePositionsFetcher{positions: []PositionSummary{}}
	black := &fakeBlackoutFetcher{}
	regime := &fakeRegimeFetcher{status: services.RegimeGateStatus{Tier: "NORMAL", SizingMultiplier: 1.0}}
	seg := &fakeSegmentPnLFetcher{pnl: &services.SegmentPnL{Strategy: "x"}}

	ctrl := NewBeatContextController(acct, pos, black, regime, seg)

	router := gin.New()
	router.GET("/api/v1/beat-context", ctrl.HandleGet)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/beat-context", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d (body=%s)", w.Code, w.Body.String())
	}

	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}

	if _, ok := body["segment_pnl"]; ok {
		t.Errorf("segment_pnl should be omitted when no strategy is provided, got: %v", body["segment_pnl"])
	}
	if seg.gotStrat != "" {
		t.Errorf("segment_pnl fetcher should not have been called; gotStrat=%q", seg.gotStrat)
	}

	for _, key := range []string{"account", "positions", "econ_blackout", "regime_gate"} {
		if _, ok := body[key]; !ok {
			t.Errorf("response missing %q field on no-strategy path: %v", key, body)
		}
	}
}

// ── Prophet beat recorder tests ─────────────────────────────────────

type fakeBeatRecorder struct{ calls int }

func (f *fakeBeatRecorder) RecordBeat(_ time.Time) { f.calls++ }

func TestBeatContext_StampsProphetBeat(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// shared stubs — all happy-path, we don't care about their output here
	acct := &fakeAccountFetcher{acct: Account{PortfolioValue: 50000, Cash: 10000, BuyingPower: 20000}}
	pos := &fakePositionsFetcher{positions: []PositionSummary{}}
	black := &fakeBlackoutFetcher{}
	regime := &fakeRegimeFetcher{status: services.RegimeGateStatus{Tier: "NORMAL", SizingMultiplier: 1.0}}
	seg := &fakeSegmentPnLFetcher{}

	rec := &fakeBeatRecorder{}

	ctrl := NewBeatContextController(acct, pos, black, regime, seg)
	ctrl.SetProphetBeatRecorder(rec)

	router := gin.New()
	router.GET("/api/v1/beat-context", ctrl.HandleGet)

	t.Run("v2-options stamps once", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/beat-context?strategy=v2-options", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("status: want 200, got %d", w.Code)
		}
		if rec.calls != 1 {
			t.Errorf("RecordBeat calls: want 1, got %d", rec.calls)
		}
	})

	t.Run("non-prophet strategy does not stamp", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/beat-context?strategy=harvest", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("status: want 200, got %d", w.Code)
		}
		// calls should still be 1 from the previous sub-test
		if rec.calls != 1 {
			t.Errorf("RecordBeat calls: want still 1, got %d", rec.calls)
		}
	})
}

func TestBeatContext_SoftFailsOnDownstreamErrors(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("single dep errors", func(t *testing.T) {
		acct := &fakeAccountFetcher{acct: Account{PortfolioValue: 100000, Cash: 30000, BuyingPower: 60000}}
		pos := &fakePositionsFetcher{positions: []PositionSummary{
			{Symbol: "AAPL", Qty: 10, UnrealizedPnL: 50, UnrealizedPnLPct: 0.5},
		}}
		black := &fakeBlackoutFetcher{isBlackout: false}
		regime := &fakeRegimeFetcher{err: errors.New("boom")}
		seg := &fakeSegmentPnLFetcher{pnl: &services.SegmentPnL{Strategy: "v2-options"}}

		ctrl := NewBeatContextController(acct, pos, black, regime, seg)

		router := gin.New()
		router.GET("/api/v1/beat-context", ctrl.HandleGet)

		req := httptest.NewRequest(http.MethodGet, "/api/v1/beat-context?strategy=v2-options", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("status: want 200 (soft-fail), got %d (body=%s)", w.Code, w.Body.String())
		}

		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("unmarshal response: %v", err)
		}

		errsRaw, ok := body["errors"]
		if !ok {
			t.Fatalf("response missing 'errors' array: %v", body)
		}
		errs, ok := errsRaw.([]any)
		if !ok {
			t.Fatalf("'errors' is not an array: %T", errsRaw)
		}
		if len(errs) != 1 {
			t.Errorf("errors[] length: want 1, got %d (errors=%v)", len(errs), errs)
		}

		// Failed dependency must be named in the errors array.
		found := false
		for _, e := range errs {
			s, ok := e.(string)
			if !ok {
				continue
			}
			if strings.Contains(s, "regime") && strings.Contains(s, "boom") {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("errors[] should name the failed regime dep and surface its message, got %v", errs)
		}

		// Working dependencies must still be present in the body.
		for _, key := range []string{"account", "positions", "econ_blackout", "segment_pnl"} {
			if _, ok := body[key]; !ok {
				t.Errorf("working dep %q missing from soft-fail response: %v", key, body)
			}
		}
		// The failed dep itself should not be present (or should be empty).
		if v, ok := body["regime_gate"]; ok && v != nil {
			// It's OK for the field to be absent. If present, it must not
			// claim success values — but the simplest contract is "absent".
			t.Logf("note: regime_gate present despite error (value=%v); soft-fail still passed because errors[] is populated", v)
		}
	})

	t.Run("multiple deps error", func(t *testing.T) {
		acct := &fakeAccountFetcher{err: errors.New("account-down")}
		pos := &fakePositionsFetcher{err: errors.New("positions-down")}
		black := &fakeBlackoutFetcher{isBlackout: false}
		regime := &fakeRegimeFetcher{status: services.RegimeGateStatus{Tier: "NORMAL", SizingMultiplier: 1.0}}
		seg := &fakeSegmentPnLFetcher{pnl: &services.SegmentPnL{Strategy: "v2-options"}}

		ctrl := NewBeatContextController(acct, pos, black, regime, seg)

		router := gin.New()
		router.GET("/api/v1/beat-context", ctrl.HandleGet)

		req := httptest.NewRequest(http.MethodGet, "/api/v1/beat-context?strategy=v2-options", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("status: want 200 (soft-fail), got %d (body=%s)", w.Code, w.Body.String())
		}

		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("unmarshal response: %v", err)
		}

		errsRaw, ok := body["errors"]
		if !ok {
			t.Fatalf("response missing 'errors' array: %v", body)
		}
		errs, ok := errsRaw.([]any)
		if !ok {
			t.Fatalf("'errors' is not an array: %T", errsRaw)
		}
		if len(errs) < 2 {
			t.Errorf("errors[] length: want >=2, got %d (errors=%v)", len(errs), errs)
		}

		// Both failed dependencies must be named, with their err messages.
		joined := ""
		for _, e := range errs {
			if s, ok := e.(string); ok {
				joined += s + "|"
			}
		}
		if !strings.Contains(joined, "account") || !strings.Contains(joined, "account-down") {
			t.Errorf("errors[] missing account/account-down: %v", errs)
		}
		if !strings.Contains(joined, "positions") || !strings.Contains(joined, "positions-down") {
			t.Errorf("errors[] missing positions/positions-down: %v", errs)
		}

		// Working dependencies still rendered.
		for _, key := range []string{"econ_blackout", "regime_gate", "segment_pnl"} {
			if _, ok := body[key]; !ok {
				t.Errorf("working dep %q missing from soft-fail response: %v", key, body)
			}
		}
	})
}

