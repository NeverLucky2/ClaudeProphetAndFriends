package controllers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"

	"prophet-trader/services"
)

func newTestTurtleRouter(t *testing.T, exec *services.TurtleExecutor) (*gin.Engine, *services.TurtleScheduler) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	sched := services.NewTurtleScheduler(exec, logrus.New())
	tc := NewTurtleController(sched)
	r := gin.New()
	r.GET("/api/v1/turtle/status", tc.HandleGetStatus)
	return r, sched
}

func TestTurtleController_StatusReportsEnabled(t *testing.T) {
	r, _ := newTestTurtleRouter(t, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/turtle/status", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status=%d, body=%s", w.Code, w.Body.String())
	}
	var body map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["scheduler_enabled"] != true {
		t.Errorf("scheduler_enabled: got %v, want true", body["scheduler_enabled"])
	}
}

func TestTurtleController_LastRunNullBeforeAnyHeartbeat(t *testing.T) {
	r, _ := newTestTurtleRouter(t, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/turtle/status", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	var body map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &body)
	if body["last_run"] != nil {
		t.Errorf("last_run before any heartbeat: got %v, want nil", body["last_run"])
	}
}
