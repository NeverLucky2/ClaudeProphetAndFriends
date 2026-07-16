package controllers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"prophet-trader/services"
)

// MeanRevController exposes /api/v1/meanrev/* HTTP endpoints. Mirrors the
// TrendController pattern: thin wrapper around services.MeanRevCandidatesService.
type MeanRevController struct {
	candidatesSvc *services.MeanRevCandidatesService
}

// NewMeanRevController constructs the controller.
func NewMeanRevController(candidatesSvc *services.MeanRevCandidatesService) *MeanRevController {
	return &MeanRevController{candidatesSvc: candidatesSvc}
}

// HandleGetCandidates returns the filtered, RSI(2)-sorted candidate list.
// GET /api/v1/meanrev/candidates
//
// Response shape: services.MeanRevCandidatesResponse. Per-symbol fetch
// failures are surfaced in `errors[]` rather than returning 500 — a partial
// universe scan is still useful to the agent.
func (mc *MeanRevController) HandleGetCandidates(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	defer cancel()
	resp := mc.candidatesSvc.GetCandidates(ctx)
	c.JSON(http.StatusOK, resp)
}

// HandleGetSignal returns the per-symbol signal payload.
// GET /api/v1/meanrev/signal/:symbol
//
// Response codes:
//
//	200 → MeanRevSignal payload
//	422 → bars exist but bars_count < meanRevMinBars
//	500 → upstream fetch failed
//
// Symbols outside MeanRevUniverse are accepted; the agent rules confine the
// universe at the candidates endpoint, but per-symbol lookups remain free
// (mirrors how TrendController scopes the universe but is more permissive
// for ad-hoc operator queries).
func (mc *MeanRevController) HandleGetSignal(c *gin.Context) {
	symbol := strings.ToUpper(c.Param("symbol"))
	if symbol == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "symbol path param required"})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()

	sig, err := mc.candidatesSvc.GetSignalForTicker(ctx, symbol)
	if errors.Is(err, services.ErrInsufficientMeanRevHistory) {
		c.JSON(http.StatusUnprocessableEntity, gin.H{
			"error":            fmt.Sprintf("insufficient history for %s", symbol),
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

// HandleGetSignalSeries returns the per-day signal series for the most recent N
// trading days. GET /api/v1/meanrev/signal-series/:symbol?days=N (default 7,
// range 1..14). Fewer than N days are returned when the name lacks enough
// history for N full-prefix days; `count` reports the actual number.
func (mc *MeanRevController) HandleGetSignalSeries(c *gin.Context) {
	symbol := strings.ToUpper(c.Param("symbol"))
	if symbol == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "symbol path param required"})
		return
	}
	days := 7
	if q := c.Query("days"); q != "" {
		n, err := strconv.Atoi(q)
		if err != nil || n < 1 || n > 14 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "days must be an integer in 1..14"})
			return
		}
		days = n
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
	defer cancel()

	series, err := mc.candidatesSvc.GetSignalSeriesForTicker(ctx, symbol, days)
	if errors.Is(err, services.ErrInsufficientMeanRevHistory) {
		c.JSON(http.StatusUnprocessableEntity, gin.H{
			"error":            fmt.Sprintf("insufficient history for %s", symbol),
			"minimum_required": 210,
		})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"symbol": symbol, "count": len(series), "series": series})
}

// HandleGetUniverse returns the configured universe — operator visibility only.
// GET /api/v1/meanrev/universe
func (mc *MeanRevController) HandleGetUniverse(c *gin.Context) {
	universe := mc.candidatesSvc.Universe()
	c.JSON(http.StatusOK, gin.H{
		"count":    len(universe),
		"universe": universe,
	})
}
