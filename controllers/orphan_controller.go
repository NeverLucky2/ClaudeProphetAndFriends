package controllers

import (
	"net/http"
	"prophet-trader/services"

	"github.com/gin-gonic/gin"
)

// OrphanStatusProvider is the read surface the controller needs.
// *services.PositionManager satisfies it.
type OrphanStatusProvider interface {
	OrphanStatus() services.OrphanStatusSnapshot
}

// OrphanController exposes the read-only orphan / auto-flatten snapshot.
type OrphanController struct {
	provider OrphanStatusProvider
}

// NewOrphanController creates the controller. A nil provider makes the endpoint
// return 503 (feature unavailable) rather than panicking.
func NewOrphanController(p OrphanStatusProvider) *OrphanController {
	return &OrphanController{provider: p}
}

// HandleGetStatus returns the orphan snapshot. GET /api/v1/orphans/status
func (oc *OrphanController) HandleGetStatus(c *gin.Context) {
	if oc.provider == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "orphan status not configured"})
		return
	}
	c.JSON(http.StatusOK, oc.provider.OrphanStatus())
}
