package controllers

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"prophet-trader/services"
)

// TurtleController exposes /api/v1/turtle/* HTTP endpoints. Currently only
// the status endpoint, used by:
//   - agent/preflight.js to detect that the Go scheduler is enabled and skip
//     the LLM heartbeat entirely (the kill switch)
//   - operators inspecting the most recent heartbeat result
//
// The controller is only constructed in cmd/bot/main.go inside the
// TURTLE_SCHEDULER_ENABLED=true branch. When the flag is off, no controller
// is created and the endpoint returns 404 — which preflight catches and
// falls through to the existing LLM-driven behavior.
type TurtleController struct {
	scheduler *services.TurtleScheduler
}

// NewTurtleController constructs the controller. Both args are required;
// no nil-guard (caller in main.go owns lifetime).
func NewTurtleController(scheduler *services.TurtleScheduler) *TurtleController {
	return &TurtleController{scheduler: scheduler}
}

// HandleGetStatus serves GET /api/v1/turtle/status.
//
// Response shape:
//
//	{
//	  "scheduler_enabled": true,
//	  "last_run": <HeartbeatResult or null>
//	}
//
// `scheduler_enabled` is always true when this handler is reachable (the
// controller is only constructed when the env flag is on). `last_run` is
// null until the scheduler has completed its first heartbeat this process.
func (tc *TurtleController) HandleGetStatus(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"scheduler_enabled": true,
		"last_run":          tc.scheduler.LastResult(),
	})
}
