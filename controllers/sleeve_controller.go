package controllers

import (
	"context"
	"net/http"
	"prophet-trader/services"
	"time"

	"github.com/gin-gonic/gin"
)

// SleeveController exposes the Prophet fun-sleeve guard state + manual kill.
type SleeveController struct {
	guard *services.ProphetSleeveGuard
}

// NewSleeveController creates the controller. guard may be nil (endpoints 503).
func NewSleeveController(guard *services.ProphetSleeveGuard) *SleeveController {
	return &SleeveController{guard: guard}
}

// HandleGetStatus returns the read-only sleeve snapshot. GET /api/v1/sleeve/status
func (sc *SleeveController) HandleGetStatus(c *gin.Context) {
	if sc.guard == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sleeve guard not configured"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()
	c.JSON(http.StatusOK, sc.guard.Status(ctx, time.Now()))
}

// HandleKill engages the independent manual kill switch (writes the kill file).
// POST /api/v1/sleeve/kill   body: {"reason":"..."} (optional)
// Re-arming is intentionally NOT exposed over HTTP — delete the file deliberately.
func (sc *SleeveController) HandleKill(c *gin.Context) {
	if sc.guard == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "sleeve guard not configured"})
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	_ = c.ShouldBindJSON(&body) // body optional
	if err := sc.guard.EngageManualKill(body.Reason); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"killed": true, "reason": body.Reason})
}
