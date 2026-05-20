package controllers

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"prophet-trader/services"
)

// DriftController exposes /api/v1/drift/* HTTP endpoints. Mirrors the
// MeanRevController pattern: thin wrapper around DriftCandidatesService.
type DriftController struct {
	candidatesSvc *services.DriftCandidatesService
}

func NewDriftController(candidatesSvc *services.DriftCandidatesService) *DriftController {
	return &DriftController{candidatesSvc: candidatesSvc}
}

// HandleGetCandidates returns the ranked candidate list.
// GET /api/v1/drift/candidates
//
// Response shape: services.DriftCandidatesResponse. Per-symbol fetch failures
// land in `errors[]` rather than returning 500.
func (mc *DriftController) HandleGetCandidates(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	resp := mc.candidatesSvc.GetCandidates(ctx, time.Now())
	c.JSON(http.StatusOK, resp)
}

// HandleGetSignal returns the per-symbol drift signal.
// GET /api/v1/drift/signal/:symbol?earnings_date=YYYY-MM-DD&timing=bmo|amc
//
// Response codes:
//
//	200 → DriftSignal payload
//	400 → missing earnings_date query param
//	422 → bars_count < driftMinBars (210)
//	500 → upstream fetch failed
func (mc *DriftController) HandleGetSignal(c *gin.Context) {
	symbol := strings.ToUpper(c.Param("symbol"))
	if symbol == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "symbol path param required"})
		return
	}
	earningsDate := c.Query("earnings_date")
	if earningsDate == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "earnings_date query param required (YYYY-MM-DD)"})
		return
	}
	timing := strings.ToLower(c.Query("timing"))
	if timing != "bmo" && timing != "amc" {
		timing = "" // normalize unknown to empty (treated as AMC in compute path)
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()
	sig, err := mc.candidatesSvc.GetSignalForTicker(ctx, symbol, earningsDate, timing)
	if errors.Is(err, services.ErrInsufficientDriftHistory) {
		c.JSON(http.StatusUnprocessableEntity, gin.H{
			"error":            "insufficient history for " + symbol,
			"minimum_required": 210,
		})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, sig)
}

// HandleGetUniverse returns the configured drift universe.
// GET /api/v1/drift/universe
func (mc *DriftController) HandleGetUniverse(c *gin.Context) {
	universe := mc.candidatesSvc.Universe()
	c.JSON(http.StatusOK, gin.H{
		"count":    len(universe),
		"universe": universe,
	})
}
