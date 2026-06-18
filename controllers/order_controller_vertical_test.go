package controllers

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestVerticalEndpoints_FlagOffRejects(t *testing.T) {
	gin.SetMode(gin.TestMode)
	oc := &OrderController{} // enableVerticals defaults false, proposer/exec nil

	tests := []struct {
		name   string
		method string
		path   string
		body   interface{}
	}{
		{"propose off", "POST", "/options/verticals/propose", map[string]interface{}{"underlying": "NVDA", "direction": "call_debit", "expiration": "2026-06-20", "target_width": 10.0}},
		{"place off", "POST", "/options/verticals/place", map[string]interface{}{"proposal_id": "vp-1"}},
		{"list off", "GET", "/options/verticals", nil},
		{"close off", "POST", "/options/verticals/close", map[string]interface{}{"vertical_id": "vertical-123"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)

			var bodyBytes []byte
			if tt.body != nil {
				bodyBytes, _ = json.Marshal(tt.body)
			}
			c.Request = httptest.NewRequest(tt.method, tt.path, bytes.NewReader(bodyBytes))
			c.Request.Header.Set("Content-Type", "application/json")

			switch tt.name {
			case "propose off":
				oc.ProposeVertical(c)
			case "place off":
				oc.PlaceVertical(c)
			case "list off":
				oc.ListVerticals(c)
			case "close off":
				oc.CloseVertical(c)
			}

			if w.Code != 403 {
				t.Fatalf("flag off: want 403, got %d; body: %s", w.Code, w.Body.String())
			}
		})
	}
}
