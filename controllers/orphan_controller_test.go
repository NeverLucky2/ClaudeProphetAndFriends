package controllers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"prophet-trader/services"
	"testing"

	"github.com/gin-gonic/gin"
)

type fakeOrphanProvider struct{ snap services.OrphanStatusSnapshot }

func (f *fakeOrphanProvider) OrphanStatus() services.OrphanStatusSnapshot { return f.snap }

func TestOrphanController_ReturnsStatus(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oc := NewOrphanController(&fakeOrphanProvider{snap: services.OrphanStatusSnapshot{
		Orphans: []services.OrphanAlert{{Symbol: "UNH", BrokerQty: 13}},
	}})
	r := gin.New()
	r.GET("/api/v1/orphans/status", oc.HandleGetStatus)

	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/v1/orphans/status", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200", w.Code)
	}
	var got services.OrphanStatusSnapshot
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	if len(got.Orphans) != 1 || got.Orphans[0].Symbol != "UNH" {
		t.Fatalf("unexpected body: %s", w.Body.String())
	}
}

func TestOrphanController_NilProvider503(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oc := NewOrphanController(nil)
	r := gin.New()
	r.GET("/api/v1/orphans/status", oc.HandleGetStatus)
	w := httptest.NewRecorder()
	req, _ := http.NewRequest("GET", "/api/v1/orphans/status", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("code = %d, want 503", w.Code)
	}
}
