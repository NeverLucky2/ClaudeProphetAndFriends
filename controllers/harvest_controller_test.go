package controllers

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"prophet-trader/models"
	"prophet-trader/services"
)

// stubHarvestStore satisfies both the controller's harvestStorage interface
// and the service's harvestStateStore interface (identical method sets). It
// records saved condors so a test can assert nothing was persisted on a reject.
type stubHarvestStore struct {
	saved []*models.DBHarvestCondor
}

func (s *stubHarvestStore) SaveHarvestCondor(c *models.DBHarvestCondor) error {
	s.saved = append(s.saved, c)
	return nil
}
func (s *stubHarvestStore) UpdateHarvestCondor(_ string, _ map[string]interface{}) error { return nil }
func (s *stubHarvestStore) GetHarvestCondorByID(_ string) (*models.DBHarvestCondor, error) {
	return nil, nil
}
func (s *stubHarvestStore) ListOpenHarvestCondors() ([]*models.DBHarvestCondor, error) {
	return nil, nil
}
func (s *stubHarvestStore) GetHarvestClosedPnL(_, _ time.Time) (float64, error) { return 0, nil }

// condorBody returns a valid OpenCondorRequest JSON body for the given underlying.
func condorBody(underlying string) string {
	return fmt.Sprintf(`{
		"underlying": %q,
		"expiration_date": "2026-06-19",
		"short_put_symbol": "X260619P00500000",
		"short_put_strike": 500,
		"long_put_symbol": "X260619P00495000",
		"long_put_strike": 495,
		"short_call_symbol": "X260619C00560000",
		"short_call_strike": 560,
		"long_call_symbol": "X260619C00565000",
		"long_call_strike": 565,
		"contracts": 1,
		"wing_width": 5,
		"credit_per_contract": 1.2
	}`, underlying)
}

// newHarvestTestController wires a controller with a recording placeMLeg stub.
// The returned *int is incremented on each broker call.
func newHarvestTestController(t *testing.T, enforce bool) (*HarvestController, *int, *stubHarvestStore) {
	t.Helper()
	store := &stubHarvestStore{}
	svc := services.NewHarvestService(store)
	svc.SetEnforceUniverse(enforce)
	var placeCalls int
	placeMLeg := func(_ context.Context, _ services.MultiLegOrder) (string, error) {
		placeCalls++
		return "order-123", nil
	}
	hc := NewHarvestController(svc, nil, nil, store, placeMLeg, nil, nil)
	return hc, &placeCalls, store
}

func postCondor(hc *HarvestController, body string) *httptest.ResponseRecorder {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/api/v1/harvest/condors", hc.HandleOpenCondor)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/harvest/condors", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestHandleOpenCondor_UniverseGateBlocksOffUniverse(t *testing.T) {
	hc, placeCalls, store := newHarvestTestController(t, true)
	w := postCondor(hc, condorBody("TSLA"))

	if w.Code != http.StatusUnprocessableEntity {
		t.Errorf("off-universe TSLA should be rejected with 422, got %d: %s", w.Code, w.Body.String())
	}
	if *placeCalls != 0 {
		t.Errorf("broker placeMLeg must NOT be called on a universe reject, got %d calls", *placeCalls)
	}
	if len(store.saved) != 0 {
		t.Errorf("no condor should be persisted on a universe reject, got %d", len(store.saved))
	}
}

func TestHandleOpenCondor_UniverseGateAllowsOnUniverse(t *testing.T) {
	hc, placeCalls, _ := newHarvestTestController(t, true)
	w := postCondor(hc, condorBody("SPY"))

	if w.Code != http.StatusCreated {
		t.Errorf("on-universe SPY should be accepted with 201, got %d: %s", w.Code, w.Body.String())
	}
	if *placeCalls != 1 {
		t.Errorf("broker placeMLeg should be called once for an allowed underlying, got %d", *placeCalls)
	}
}

func TestHandleOpenCondor_UniverseGateDisabledAllowsAny(t *testing.T) {
	hc, placeCalls, _ := newHarvestTestController(t, false)
	w := postCondor(hc, condorBody("TSLA"))

	if w.Code != http.StatusCreated {
		t.Errorf("gate disabled: TSLA should be accepted with 201, got %d: %s", w.Code, w.Body.String())
	}
	if *placeCalls != 1 {
		t.Errorf("gate disabled: placeMLeg should be called once, got %d", *placeCalls)
	}
}
