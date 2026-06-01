package controllers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"prophet-trader/models"
	"prophet-trader/services"
)

// TrendController exposes /api/v1/trend/* HTTP endpoints.
type TrendController struct {
	signalSvc *services.TrendSignalService
}

// NewTrendController constructs the controller.
func NewTrendController(signalSvc *services.TrendSignalService) *TrendController {
	return &TrendController{signalSvc: signalSvc}
}

// HandleGetSignal handles GET /api/v1/trend/signal/:symbol.
//
// Response codes:
//   200 → signal payload (see TrendSignal)
//   400 → symbol not in TrendUniverse
//   422 → bars exist but bars_count < 250 (insufficient history)
//   500 → upstream data fetch failed
func (tc *TrendController) HandleGetSignal(c *gin.Context) {
	symbol := strings.ToUpper(c.Param("symbol"))
	if !models.InTrendUniverse(symbol) {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":    fmt.Sprintf("symbol %s not in trend universe", symbol),
			"universe": models.TrendUniverseTickers(),
		})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()

	signal, err := tc.signalSvc.GetSignal(ctx, symbol)
	if errors.Is(err, services.ErrInsufficientHistory) {
		c.JSON(http.StatusUnprocessableEntity, gin.H{
			"error":            fmt.Sprintf("insufficient history for %s", symbol),
			"minimum_required": 250,
		})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, signal)
}
