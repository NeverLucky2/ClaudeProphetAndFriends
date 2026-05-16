package controllers

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"prophet-trader/services"
)

// BeatContextController aggregates the per-beat read-only context the LLM
// would otherwise fetch via 4–5 separate MCP tool calls: account, positions,
// econ blackout, regime gate, and (when a strategy is supplied) segment P&L.
//
// The endpoint is purposefully thin: it fans out to the existing services in
// parallel-equivalent sequence and assembles a single JSON response. Each
// dependency is wrapped behind a narrow interface so unit tests can stub them
// without booting Alpaca, FMP, or the regime-gate file watcher.
//
// Fail mode: soft-fail. Any individual dep error is collected into an
// `errors` string array on the response; successful deps are still rendered.
// The endpoint always returns 200 so the per-tool fail-closed policy on the
// agent side (see TRADING_RULES_*.md) takes over — the absence of, say, a
// regime block is treated by the rules as "do not enter new positions".

// Account is the slimmed-down account shape the agent reads per beat.
// Mirrors interfaces.Account but exposes only the three values the rules
// actually consume so we don't ship day-trade flags / pattern-day-trader
// booleans through every beat.
type Account struct {
	PortfolioValue float64 `json:"portfolio_value"`
	Cash           float64 `json:"cash"`
	BuyingPower    float64 `json:"buying_power"`
}

// PositionSummary is the compact per-position projection bundled into the
// beat context. interfaces.Position carries seven additional fields the
// rules don't need; we drop them here to keep the per-beat blob small.
type PositionSummary struct {
	Symbol           string  `json:"symbol"`
	Qty              float64 `json:"qty"`
	UnrealizedPnL    float64 `json:"unrealized_pnl"`
	UnrealizedPnLPct float64 `json:"unrealized_pnl_pct"`
}

// AccountFetcher returns the current Alpaca account snapshot.
type AccountFetcher interface {
	GetAccount() (Account, error)
}

// PositionsFetcher returns broker positions, optionally filtered by the
// requesting agent's strategy tag (empty strategy → all positions).
type PositionsFetcher interface {
	GetPositionsByStrategy(strategy string) ([]PositionSummary, error)
}

// BlackoutFetcher returns the current US-economic-release blackout state.
// The boolean tracks whether we're inside a window, the string is a
// human-readable reason ("FOMC at 14:00 ET" etc.). An error indicates the
// econ calendar service is unavailable (e.g. FMP_API_KEY unset).
type BlackoutFetcher interface {
	EconBlackoutStatus() (isBlackout bool, reason string, err error)
}

// RegimeFetcher returns the current regime-gate status (tier, sizing,
// block flag). The underlying service fails open internally, but the
// interface admits an error for adapters that may genuinely fail (e.g.
// future variants that read a remote source).
type RegimeFetcher interface {
	GetStatus() (services.RegimeGateStatus, error)
}

// SegmentPnLFetcher returns the per-strategy P&L summary. Only called when
// a non-empty strategy is present on the request.
type SegmentPnLFetcher interface {
	GetSegmentPnL(ctx context.Context, strategy string) (*services.SegmentPnL, error)
}

// BeatContextController bundles all five fetchers behind the single
// /api/v1/beat-context endpoint.
type BeatContextController struct {
	account  AccountFetcher
	pos      PositionsFetcher
	blackout BlackoutFetcher
	regime   RegimeFetcher
	segment  SegmentPnLFetcher
}

// NewBeatContextController constructs the controller. All five fetchers are
// required — if any of them is nil the corresponding section will surface
// as an error in the response, but the endpoint will not panic.
func NewBeatContextController(
	account AccountFetcher,
	pos PositionsFetcher,
	blackout BlackoutFetcher,
	regime RegimeFetcher,
	segment SegmentPnLFetcher,
) *BeatContextController {
	return &BeatContextController{
		account:  account,
		pos:      pos,
		blackout: blackout,
		regime:   regime,
		segment:  segment,
	}
}

// HandleGet handles GET /api/v1/beat-context[?strategy=X].
//
// Returns 200 even when individual deps error; failed deps are listed by name
// in the `errors` field. When `strategy` is empty the segment_pnl section is
// omitted entirely (the underlying service requires a strategy and would
// return an error if asked with "").
func (c *BeatContextController) HandleGet(ctx *gin.Context) {
	strategy := ctx.Query("strategy")

	resp := gin.H{}
	var errs []string

	if acct, err := c.account.GetAccount(); err != nil {
		errs = append(errs, fmt.Sprintf("account: %s", err.Error()))
	} else {
		resp["account"] = acct
	}

	if positions, err := c.pos.GetPositionsByStrategy(strategy); err != nil {
		errs = append(errs, fmt.Sprintf("positions: %s", err.Error()))
	} else {
		// Always render a JSON array (empty when no positions) so consumers
		// don't have to special-case null.
		if positions == nil {
			positions = []PositionSummary{}
		}
		resp["positions"] = positions
	}

	if isBlackout, reason, err := c.blackout.EconBlackoutStatus(); err != nil {
		errs = append(errs, fmt.Sprintf("econ_blackout: %s", err.Error()))
	} else {
		resp["econ_blackout"] = gin.H{
			"is_blackout": isBlackout,
			"reason":      reason,
		}
	}

	if status, err := c.regime.GetStatus(); err != nil {
		errs = append(errs, fmt.Sprintf("regime: %s", err.Error()))
	} else {
		resp["regime_gate"] = gin.H{
			"tier":              status.Tier,
			"score":             status.Score,
			"sizing_multiplier": status.SizingMultiplier,
			"block_new_entries": status.BlockNewEntries,
		}
	}

	if strategy != "" {
		// Inherit the request context so any harness-side deadline
		// (the harness aborts the HTTP request at 800ms) propagates to
		// the segment-pnl fetch. An explicit local timeout here would
		// either be redundant or — if longer than the harness budget —
		// actively misleading.
		if pnl, err := c.segment.GetSegmentPnL(ctx.Request.Context(), strategy); err != nil {
			errs = append(errs, fmt.Sprintf("segment_pnl: %s", err.Error()))
		} else if pnl != nil {
			resp["segment_pnl"] = gin.H{
				"strategy":               pnl.Strategy,
				"unrealized_pnl_percent": pnl.UnrealizedPnLPct,
				"deployed_percent":       pnl.DeployedPercent,
			}
		}
	}

	if len(errs) > 0 {
		resp["errors"] = errs
	}

	// Record when the bundle finished assembling (not when the handler
	// started) so downstream staleness checks reflect the freshest piece.
	resp["fetched_at"] = time.Now().UTC().Format(time.RFC3339)

	ctx.JSON(http.StatusOK, resp)
}
