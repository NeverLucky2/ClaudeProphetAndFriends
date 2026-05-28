package controllers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"prophet-trader/models"
	"prophet-trader/services"
)

// harvestStorage is the DB interface used by HarvestController.
type harvestStorage interface {
	SaveHarvestCondor(c *models.DBHarvestCondor) error
	UpdateHarvestCondor(condorID string, updates map[string]interface{}) error
	GetHarvestCondorByID(condorID string) (*models.DBHarvestCondor, error)
	ListOpenHarvestCondors() ([]*models.DBHarvestCondor, error)
	GetHarvestClosedPnL(start, end time.Time) (float64, error)
}

// HarvestController handles all /api/v1/harvest/* endpoints.
type HarvestController struct {
	harvestSvc   *services.HarvestService
	ivrSvc       *services.HarvestIVRService
	rvSvc        *services.RealizedVolService // optional; enriches IVR responses with RV/spread
	storage      harvestStorage
	placeMLeg    services.PlaceMultiLegOrderFn
	getPortfolio func() (float64, error)
	closer       *services.HarvestCloser
}

// NewHarvestController creates the controller.
// placeMLeg is injected so tests can stub it without a broker.
// getPortfolio returns the current total account equity.
// rvSvc may be nil; when present, /api/v1/harvest/ivr/:symbol responses
// include RealizedVol20d and IVMinusRV used by the premium-edge gate.
// closer is the shared HarvestCloser service used by HandleCloseCondor
// (and, later, the HarvestExitMonitor) to actually place close orders.
func NewHarvestController(
	harvestSvc *services.HarvestService,
	ivrSvc *services.HarvestIVRService,
	rvSvc *services.RealizedVolService,
	storage harvestStorage,
	placeMLeg services.PlaceMultiLegOrderFn,
	getPortfolio func() (float64, error),
	closer *services.HarvestCloser,
) *HarvestController {
	return &HarvestController{
		harvestSvc:   harvestSvc,
		ivrSvc:       ivrSvc,
		rvSvc:        rvSvc,
		storage:      storage,
		placeMLeg:    placeMLeg,
		getPortfolio: getPortfolio,
		closer:       closer,
	}
}

// HandleGetState handles GET /api/v1/harvest/state
func (hc *HarvestController) HandleGetState(c *gin.Context) {
	pv, err := hc.getPortfolio()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to get portfolio value: " + err.Error()})
		return
	}
	state, err := hc.harvestSvc.GetState(pv)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, state)
}

// HandleGetFOMC handles GET /api/v1/harvest/fomc
func (hc *HarvestController) HandleGetFOMC(c *gin.Context) {
	status := hc.harvestSvc.GetFOMCStatus()
	c.JSON(http.StatusOK, status)
}

// HandleGetExpirations handles GET /api/v1/harvest/expirations/:symbol
func (hc *HarvestController) HandleGetExpirations(c *gin.Context) {
	symbol := c.Param("symbol")
	exp, err := hc.harvestSvc.GetNextMonthlyExpiration(symbol, 35, 55)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error(), "symbol": symbol})
		return
	}
	c.JSON(http.StatusOK, exp)
}

// HandleGetIVR handles GET /api/v1/harvest/ivr/:symbol?current_iv=0.185
func (hc *HarvestController) HandleGetIVR(c *gin.Context) {
	symbol := c.Param("symbol")
	currentIVStr := c.Query("current_iv")
	var currentIV float64
	if _, err := fmt.Sscanf(currentIVStr, "%f", &currentIV); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "current_iv query param required (e.g. ?current_iv=0.185)"})
		return
	}
	data, err := hc.ivrSvc.GetIVRData(symbol, currentIV)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Optional RV enrichment (same pattern as IVController). Fetch failures
	// leave RealizedVol20d=0 and downstream consumers treat that as "no signal".
	if hc.rvSvc != nil && data.CurrentIV > 0 {
		if rv, rvErr := hc.rvSvc.GetAnnualizedRealizedVol(c.Request.Context(), symbol, 20); rvErr == nil && rv > 0 {
			data.RealizedVol20d = rv
			data.IVMinusRV = data.CurrentIV - rv
		}
	}
	c.JSON(http.StatusOK, data)
}

// OpenCondorRequest is the body for POST /api/v1/harvest/condors.
type OpenCondorRequest struct {
	Underlying            string  `json:"underlying" binding:"required"`
	ExpirationDate        string  `json:"expiration_date" binding:"required"` // YYYY-MM-DD
	ShortPutSymbol        string  `json:"short_put_symbol" binding:"required"`
	ShortPutStrike        float64 `json:"short_put_strike" binding:"required"`
	LongPutSymbol         string  `json:"long_put_symbol" binding:"required"`
	LongPutStrike         float64 `json:"long_put_strike" binding:"required"`
	ShortCallSymbol       string  `json:"short_call_symbol" binding:"required"`
	ShortCallStrike       float64 `json:"short_call_strike" binding:"required"`
	LongCallSymbol        string  `json:"long_call_symbol" binding:"required"`
	LongCallStrike        float64 `json:"long_call_strike" binding:"required"`
	Contracts             int     `json:"contracts" binding:"required,min=1"`
	WingWidth             float64 `json:"wing_width" binding:"required"`
	CreditPerContract     float64 `json:"credit_per_contract" binding:"required"`
	IVRAtEntry            float64 `json:"ivr_at_entry"`
	PortfolioValueAtEntry float64 `json:"portfolio_value_at_entry"`
	OverlapLog            string  `json:"overlap_log"` // JSON string
}

// HandleOpenCondor handles POST /api/v1/harvest/condors
func (hc *HarvestController) HandleOpenCondor(c *gin.Context) {
	var req OpenCondorRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Underlying allowlist (flag-gated, default off). When enforcement is on,
	// reject before the broker call so an off-universe condor never reaches the
	// market and no condor row is persisted.
	if !hc.harvestSvc.IsUnderlyingAllowed(req.Underlying) {
		c.JSON(http.StatusUnprocessableEntity, gin.H{
			"error": fmt.Sprintf("underlying %q is not in Harvest's tradable universe", req.Underlying),
		})
		return
	}

	expDate, err := time.Parse("2006-01-02", req.ExpirationDate)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid expiration_date format, use YYYY-MM-DD"})
		return
	}

	order := services.MultiLegOrder{
		Underlying:  req.Underlying,
		Contracts:   req.Contracts,
		LimitPrice:  req.CreditPerContract,
		TimeInForce: "day",
		Strategy:    "harvest",
		Legs: []services.MultiLegOrderLeg{
			{Symbol: req.ShortPutSymbol, Side: "sell", PositionIntent: "sell_to_open"},
			{Symbol: req.LongPutSymbol, Side: "buy", PositionIntent: "buy_to_open"},
			{Symbol: req.ShortCallSymbol, Side: "sell", PositionIntent: "sell_to_open"},
			{Symbol: req.LongCallSymbol, Side: "buy", PositionIntent: "buy_to_open"},
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	orderID, err := hc.placeMLeg(ctx, order)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to place iron condor order: " + err.Error()})
		return
	}

	condorID := uuid.New().String()
	maxLoss := req.WingWidth * float64(req.Contracts) * 100.0
	totalCredit := req.CreditPerContract * float64(req.Contracts) * 100.0

	condor := &models.DBHarvestCondor{
		CondorID:              condorID,
		Underlying:            req.Underlying,
		Expiration:            expDate,
		ShortPutSymbol:        req.ShortPutSymbol,
		ShortPutStrike:        req.ShortPutStrike,
		LongPutSymbol:         req.LongPutSymbol,
		LongPutStrike:         req.LongPutStrike,
		ShortCallSymbol:       req.ShortCallSymbol,
		ShortCallStrike:       req.ShortCallStrike,
		LongCallSymbol:        req.LongCallSymbol,
		LongCallStrike:        req.LongCallStrike,
		Contracts:             req.Contracts,
		WingWidth:             req.WingWidth,
		CreditPerContract:     req.CreditPerContract,
		TotalCredit:           totalCredit,
		MaxLoss:               maxLoss,
		PortfolioValueAtEntry: req.PortfolioValueAtEntry,
		EntryOrderID:          orderID,
		Status:                "OPEN",
		IVRAtEntry:            req.IVRAtEntry,
		OverlapLog:            req.OverlapLog,
		OpenedAt:              time.Now(),
	}

	if err := hc.storage.SaveHarvestCondor(condor); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":     "order placed but failed to save condor record: " + err.Error(),
			"order_id":  orderID,
			"condor_id": condorID,
		})
		return
	}

	c.JSON(http.StatusCreated, gin.H{
		"condor_id": condorID,
		"order_id":  orderID,
		"status":    "OPEN",
		"max_loss":  maxLoss,
		"credit":    totalCredit,
	})
}

// HandleCloseCondor handles POST /api/v1/harvest/condors/:id/close.
//
// This endpoint is a thin shim over services.HarvestCloser — the same close
// path the HarvestExitMonitor uses. The controller always sets
// FinalizeImmediately=true and AllowReplaceClosing=false (both hardcoded
// after binding to defend against future schema changes), which preserves
// the pre-monitor behavior: status flips straight to CLOSED with closed_at
// stamped on order placement, and any non-OPEN row is rejected with HTTP 409.
func (hc *HarvestController) HandleCloseCondor(c *gin.Context) {
	condorID := c.Param("id")
	var req services.CloseCondorRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	req.CondorID = condorID
	// Defense in depth: the JSON tags are "-" so binding cannot set these,
	// but pin them explicitly so a future schema change can't silently
	// flip semantics.
	req.FinalizeImmediately = true
	req.AllowReplaceClosing = false

	res, err := hc.closer.CloseCondor(c.Request.Context(), req)
	if err != nil {
		if errors.Is(err, services.ErrCondorNotOpen) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "condor not found: " + condorID})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"condor_id":      res.CondorID,
		"close_order_id": res.CloseOrderID,
		"realized_pnl":   res.RealizedPnL,
		"status":         res.Status,
	})
}

// HandleListCondors handles GET /api/v1/harvest/condors
func (hc *HarvestController) HandleListCondors(c *gin.Context) {
	condors, err := hc.storage.ListOpenHarvestCondors()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"count": len(condors), "condors": condors})
}

// HandleRecordIV handles POST /api/v1/harvest/iv
// Body: { symbol: "SPY", atm_iv: 0.185 }
func (hc *HarvestController) HandleRecordIV(c *gin.Context) {
	var req struct {
		Symbol string  `json:"symbol" binding:"required"`
		ATMIV  float64 `json:"atm_iv" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := hc.ivrSvc.RecordDailyIV(req.Symbol, req.ATMIV); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"recorded": true, "symbol": req.Symbol})
}
