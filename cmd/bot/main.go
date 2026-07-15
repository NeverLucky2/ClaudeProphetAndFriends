package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"prophet-trader/config"
	"prophet-trader/controllers"
	"prophet-trader/database"
	"prophet-trader/interfaces"
	"prophet-trader/models"
	"prophet-trader/services"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

func main() {
	// Load configuration
	if err := config.Load(); err != nil {
		log.Fatal("Failed to load configuration:", err)
	}

	cfg := config.AppConfig

	// Initialize logger
	logger := logrus.New()
	logger.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})

	if cfg.EnableLogging {
		level, _ := logrus.ParseLevel(cfg.LogLevel)
		logger.SetLevel(level)
	}

	logger.Info("Starting Prophet Trader Bot...")

	// Validate required configuration
	if cfg.AlpacaAPIKey == "" || cfg.AlpacaSecretKey == "" {
		logger.Fatal("Alpaca API credentials not configured. Please set ALPACA_API_KEY (or ALPACA_PUBLIC_KEY) and ALPACA_SECRET_KEY")
	}

	// Initialize services
	logger.Debug("Initializing services...")

	// One shared Alpaca data-API admission limiter governs both the bar-fetch
	// path and the options-chain path so they stop colliding on the account-wide
	// rate budget. The intraday client is deliberately left ungated to preserve
	// its latency isolation (see services/alpaca_data.go SetRateLimiter doc).
	const alpacaDataBurst = 10
	alpacaDataLimiter := services.NewAlpacaDataRateLimiter(cfg.AlpacaDataRatePerMin, alpacaDataBurst)

	// Create trading service. A mode mismatch (ALPACA_PAPER vs ALPACA_BASE_URL)
	// is FATAL, not a warning: it is the one misconfiguration that can trade real
	// money while every log line reports "paper". Other construction failures stay
	// non-fatal (the service retries on request).
	tradingService, err := services.NewAlpacaTradingService(
		cfg.AlpacaAPIKey,
		cfg.AlpacaSecretKey,
		cfg.AlpacaBaseURL,
		cfg.AlpacaPaper,
	)
	if err != nil {
		logger.Fatalf("FATAL: Alpaca trading service refused to start: %v", err)
	}

	// Announce the resolved mode from the URL — the authoritative source — not
	// from the flag.
	urlIsPaper, _ := services.IsPaperBaseURL(cfg.AlpacaBaseURL)
	mode := "LIVE — REAL MONEY"
	if urlIsPaper {
		mode = "paper"
	}
	logger.WithFields(logrus.Fields{
		"alpaca_mode":     mode,
		"alpaca_base_url": cfg.AlpacaBaseURL,
	}).Warn("Alpaca trading mode resolved")

	tradingService.SetRateLimiter(alpacaDataLimiter)

	// Create the raw Alpaca data service + shared rate limiter, then wrap it in
	// the cross-agent shared bar cache. Every non-intraday consumer reads through
	// `dataService` (now a MarketDataProvider); the intraday service constructed
	// later is built separately and never wrapped (latency isolation, 1ec6b6a).
	rawDataService := services.NewAlpacaDataService(
		cfg.AlpacaAPIKey,
		cfg.AlpacaSecretKey,
	)
	rawDataService.SetRateLimiter(alpacaDataLimiter)

	var dataService services.MarketDataProvider = rawDataService
	if cfg.BarCacheEnabled {
		absCacheDir, err := filepath.Abs(cfg.BarCacheDir)
		if err != nil {
			absCacheDir = cfg.BarCacheDir
		}
		if err := os.MkdirAll(absCacheDir, 0o755); err != nil {
			logger.WithError(err).Warn("bar cache dir create failed — running without cache this session")
		} else {
			dataService = services.NewSharedBarCache(rawDataService, absCacheDir, cfg.BarCacheTTL, logger)
			logger.WithFields(logrus.Fields{
				"bar_cache_dir": absCacheDir, // operators: confirm every bot logs the SAME absolute path
				"bar_cache_ttl": cfg.BarCacheTTL,
			}).Info("Shared bar cache enabled")
		}
	} else {
		logger.Info("Shared bar cache disabled (BAR_CACHE_ENABLED != true)")
	}

	// Create storage service
	storageService, err := database.NewLocalStorage(cfg.DatabasePath)
	if err != nil {
		logger.Fatal("Failed to create storage service:", err)
	}

	// Create order controller
	orderController := controllers.NewOrderController(
		tradingService,
		dataService,
		storageService,
	)

	// Create news service and controller
	newsService := services.NewNewsService()
	newsController := controllers.NewNewsController(newsService)

	// Create economic feeds service and controller.
	// EconCalendarService is optional: when FMP_API_KEY is unset, the
	// /api/v1/econ/blackout endpoint returns 503 and preflight fails open.
	economicFeedsService := services.NewEconomicFeedsService()
	var econCalendarService *services.EconCalendarService
	if cfg.FMPAPIKey != "" {
		econCalendarService = services.NewEconCalendarService(cfg.FMPAPIKey)
	} else {
		logger.Warn("FMP_API_KEY unset — econ blackout endpoint will return 503 and preflight will fail open")
	}
	economicFeedsController := controllers.NewEconomicFeedsController(economicFeedsService, econCalendarService)

	// Create AI news cleaner (provider selected via AI_PROVIDER env var or auto-detected)
	var aiService services.NewsCleanerService
	switch cfg.AIProvider {
	case "xai":
		aiService = services.NewXAIService(cfg.XAIAPIKey)
		logger.Info("AI news cleaning: using xAI (Grok)")
	default:
		aiService = services.NewClaudeService(cfg.ClaudeAPIKey)
		logger.Info("AI news cleaning: using Claude")
	}
	analysisService := services.NewTechnicalAnalysisService(dataService)
	stockAnalysisService := services.NewStockAnalysisService(dataService, newsService, aiService)
	intelligenceController := controllers.NewIntelligenceController(newsService, aiService, analysisService, stockAnalysisService, dataService)

	// Test account connection
	logger.Debug("Testing Alpaca connection...")
	if tradingService != nil {
		if account, err := orderController.GetAccount(); err != nil {
			logger.Warn("Failed to connect to Alpaca (trading will be unavailable):", err)
		} else {
			logger.WithFields(logrus.Fields{
				"cash":            account.Cash,
				"buying_power":    account.BuyingPower,
				"portfolio_value": account.PortfolioValue,
			}).Info("Successfully connected to Alpaca")
		}
	} else {
		logger.Warn("Trading service unavailable - API credentials may be invalid")
	}

	// Start background tasks
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Create position manager
	positionManager := services.NewPositionManager(tradingService, dataService, storageService)
	positionManager.EnableSingleLegAttribution(cfg.EnableProphetSingleLegAttribution)
	positionController := controllers.NewPositionManagementController(positionManager)

	// Cross-agent sector concentration caps. Values are fractions of portfolio value.
	// Buckets not listed here fall back to cfg.SectorDefaultMaxPct.
	sectorCaps := map[string]float64{
		"TECH":                   0.20,
		"INDEX_BETA":             0.25,
		"ENERGY":                 0.15,
		"FINANCIALS":             0.15,
		"HEALTHCARE":             0.15,
		"CONSUMER_DISCRETIONARY": 0.15,
		"STAPLES":                0.15,
		"INDUSTRIALS":            0.15,
		"UTILITIES":              0.15,
		"MATERIALS":              0.15,
		"REAL_ESTATE":            0.15,
		"COMMUNICATIONS":         0.15,
		"OTHER":                  0.15,
	}

	tradableUniverse, err := services.LoadTradableUniverse(cfg.TradableUniversePath)
	if err != nil {
		logger.WithError(err).Warn("Failed to load tradable universe floor — universe gate will fail open")
		tradableUniverse = map[string]bool{}
	}

	// Per-agent equity universes for the agent-universe gate (Coil/Drift/Trend).
	// Built from the same Go-constant lists the runtime iterates, so the
	// order-time guard and the candidate/entry feed can never diverge:
	// MeanRev/Drift from their scanner constants, Trend from the centralized
	// models.TrendUniverse (the single source of truth the executor iterates).
	// Agents absent here (Main) fail open — the gate never blocks them.
	agentUniverses := map[services.AgentSource]map[string]bool{
		services.AgentMeanRev: services.SymbolSet(services.MeanRevUniverse),
		services.AgentDrift:   services.SymbolSet(services.DriftUniverse),
		services.AgentTrend:   services.SymbolSet(models.TrendUniverseTickers()),
	}

	// Create trade guard and wire into both controllers
	tradeGuard := services.NewTradeGuard(
		positionManager,
		tradingService,
		services.TradeGuardConfig{
			MaxDailyLossPct:         cfg.MaxDailyLossPct,
			EnableSectorAggregation: cfg.EnableSectorAggregation,
			SectorMaxExposurePct:    sectorCaps,
			DefaultSectorMaxPct:     cfg.SectorDefaultMaxPct,
			EnablePositionCaps:      cfg.EnablePositionCaps,
			MaxPositionPct:          cfg.MaxPositionPct,
			MaxDeployedPct:          cfg.MaxDeployedPct,
			EnableAgentUniverseGate: cfg.EnableAgentUniverseGate,
			AgentUniverses:          agentUniverses,
			EnableUniverseGate:      cfg.EnableUniverseGate,
			TradableUnderlyings:     tradableUniverse,
			EnableOptionsSpreadGate: cfg.EnableProphetOptionsSpread,
			SpreadMaxPct:            cfg.ProphetSpreadMaxPct,
			OptionsQuoteMaxAge:      time.Duration(cfg.ProphetQuoteMaxAgeSec) * time.Second,
		},
	)
	positionManager.SetGuard(tradeGuard)
	orderController.SetGuard(tradeGuard)
	guardController := controllers.NewGuardController(tradeGuard)

	// Prophet fun-sleeve real-money safety gate (live). Default OFF; flag-gated.
	sleeveDisarmDir := cfg.ProphetSleeveDisarmDir
	if sleeveDisarmDir == "" {
		sleeveDisarmDir = filepath.Dir(cfg.DatabasePath)
	}
	sleeveGuard := services.NewProphetSleeveGuard(
		services.ProphetSleeveConfig{
			Enabled:         cfg.EnableProphetSleeve,
			BaselineUSD:     cfg.ProphetSleeveBaselineUSD,
			MaxPositionFrac: cfg.ProphetSleeveMaxPositionFrac,
			MaxPositions:    cfg.ProphetSleeveMaxPositions,
			LossBudgetFrac:  cfg.ProphetSleeveLossBudgetFrac,
			Deadline:        cfg.ProphetSleeveDeadline,
			DisarmDir:       sleeveDisarmDir,
		},
		tradingService,
	)
	orderController.SetSleeveGuard(sleeveGuard)
	sleeveController := controllers.NewSleeveController(sleeveGuard)

	// Orphan / auto-flatten read-only snapshot (Layer A surfacing).
	orphanController := controllers.NewOrphanController(positionManager)

	// Coil live drawdown halt. Default OFF; the live Coil bot sets
	// ENABLE_COIL_LIVE_HALT=true. Shares the sleeve's state-dir convention.
	coilHaltStateDir := cfg.CoilLiveStateDir
	if coilHaltStateDir == "" {
		coilHaltStateDir = filepath.Dir(cfg.DatabasePath)
	}
	if cfg.EnableCoilLiveHalt {
		// Validate BEFORE constructing the guard: a non-default
		// COIL_LIVE_STATE_DIR pointing at a directory that does not exist, or
		// one that stats fine but is not actually writable (full disk,
		// read-only remount, ACL change), would otherwise let the bot boot and
		// either block 100% of live entries with nothing but a log line to
		// explain it, or — worse, for the unwritable-but-statable case —
		// silently resume measuring drawdown against a stale, no-longer-
		// ratcheting high-water mark (see CoilStateDirWritable's doc comment
		// for the exact restart failure loop this closes). Deliberately does
		// NOT MkdirAll the directory here: see CoilStateDirWritable's doc
		// comment for why that would resurrect a vanished dir and drop a
		// latch across a restart.
		if err := services.CoilStateDirWritable(coilHaltStateDir, logger); err != nil {
			logger.Fatalf("Coil live drawdown halt: COIL_LIVE_STATE_DIR %q is not usable (fail closed at startup rather than booting into stale drawdown state): %v", coilHaltStateDir, err)
		}
		coilHalt := services.NewCoilLiveHaltGuard(
			services.CoilLiveHaltConfig{
				Enabled:     true,
				DrawdownPct: cfg.CoilLiveDrawdownPct,
				BaselineUSD: cfg.CoilLiveBaselineUSD,
				StateDir:    coilHaltStateDir,
			},
			tradingService,
		)
		tradeGuard.SetHaltGuard(coilHalt)
		logger.WithFields(logrus.Fields{
			"coil_live_halt_enabled": true,
			"drawdown_pct":           cfg.CoilLiveDrawdownPct,
			"baseline_usd":           cfg.CoilLiveBaselineUSD,
			"state_dir":              coilHaltStateDir,
		}).Warn("Coil live drawdown halt ARMED")
	}

	logger.WithFields(logrus.Fields{
		"max_daily_loss_pct":          cfg.MaxDailyLossPct,
		"sector_aggregation_enabled":  cfg.EnableSectorAggregation,
		"sector_default_max_pct":      cfg.SectorDefaultMaxPct,
		"position_caps_enabled":       cfg.EnablePositionCaps,
		"max_position_pct":            cfg.MaxPositionPct,
		"max_deployed_pct":            cfg.MaxDeployedPct,
		"universe_gate_enabled":       cfg.EnableUniverseGate,
		"tradable_universe_count":     len(tradableUniverse),
		"agent_universe_gate_enabled": cfg.EnableAgentUniverseGate,
		"meanrev_universe_count":      len(agentUniverses[services.AgentMeanRev]),
		"drift_universe_count":        len(agentUniverses[services.AgentDrift]),
		"trend_universe_count":        len(agentUniverses[services.AgentTrend]),
		"options_spread_gate_enabled": cfg.EnableProphetOptionsSpread,
		"spread_max_pct":              cfg.ProphetSpreadMaxPct,
		"quote_max_age_sec":           cfg.ProphetQuoteMaxAgeSec,
	}).Info("Trade guard initialized")

	// Regime gate service. Reads the daily-computed regime_gate.json snapshot;
	// when EnableRegimeGate is false the service still loads and reports the
	// underlying tier (for observation), but sizing/block stay neutral. The
	// Python writer (scripts/compute_daily_regime_score.py) is wired in a
	// follow-up commit; until then GetStatus returns the fail-open neutral
	// status (tier=UNKNOWN, sizing=1.0, block=false).
	regimeGate := services.NewRegimeGateService(services.RegimeGateConfig{
		EnableRegimeGate: cfg.EnableRegimeGate,
		ReportPath:       cfg.RegimeReportPath,
	})
	regimeGateController := controllers.NewRegimeGateController(regimeGate)
	logger.WithFields(logrus.Fields{
		"regime_gate_enabled": cfg.EnableRegimeGate,
		"regime_report_path":  cfg.RegimeReportPath,
	}).Info("Regime gate service initialized")

	// Create activity logger
	activityLogDir := os.Getenv("ACTIVITY_LOG_DIR")
	if activityLogDir == "" {
		activityLogDir = "./activity_logs"
	}
	activityLogger := services.NewActivityLogger(activityLogDir)
	activityController := controllers.NewActivityController(activityLogger)

	// Start trading session automatically
	if account, err := orderController.GetAccount(); err == nil {
		activityLogger.StartSession(ctx, account.PortfolioValue)
		logger.Debug("Activity logging session started")
	}

	earningsService := services.NewEarningsCalendarService(cfg.FMPAPIKey, cfg.AlpacaAPIKey, cfg.AlpacaSecretKey, cfg.AlpacaBaseURL, nil)
	go earningsService.Start(ctx)
	if !earningsService.WaitForFirstRefresh(services.FirstRefreshWaitTimeout) {
		logger.Warn("earnings calendar first refresh did not complete within timeout — universe will start in fail-open mode")
	}

	// IV-rank service (shared infra — Prophet's options-entry gate). Collects ATM
	// IV daily for SPY/QQQ + Prophet's mega-caps; persists to harvest_iv_snapshots.
	ivRankSvc := services.NewIVRankService(storageService)

	// Wire the IV provider into StockAnalysisService so analyze_stocks
	// responses include per-symbol IV rank / percentile / days_of_history.
	// Safe to set after construction; the field is read inside AnalyzeStock.
	stockAnalysisService.SetIVProvider(ivRankSvc)

	// Realized-vol service: computes the IV–RV spread for IVController
	// (the generic /api/v1/iv/:symbol route consumed by Prophet).
	realizedVolSvc := services.NewRealizedVolService(dataService)

	// Start the daily IV collection goroutine (feeds Prophet's IV-rank gate).
	go startIVCollection(ctx, ivRankSvc, tradingService, logger)

	// Initialize Trend signal service (used by TrendProphet for daily-bar signals)
	trendSignalSvc := services.NewTrendSignalService(dataService)
	trendController := controllers.NewTrendController(trendSignalSvc)
	logger.Debug("Trend signal service initialized")

	// Initialize Mean Reversion signal pipeline (used by Coil for RSI(2)-based
	// pullback entries on S&P 500 large-caps). Universe is curated in the
	// services package; the candidates service applies entry filters and
	// surfaces the SPY-based bear-regime flag. Earnings filter is wired only
	// when the FMP-backed earnings calendar is available — otherwise the
	// service runs fail-open (no earnings exclusion).
	meanRevSignalSvc := services.NewMeanRevSignalService(dataService)
	var meanRevEarningsChecker services.EarningsHorizonChecker
	if earningsService != nil {
		meanRevEarningsChecker = earningsService
	}
	meanRevCandidatesSvc := services.NewMeanRevCandidatesService(
		meanRevSignalSvc,
		meanRevEarningsChecker,
		nil, // nil universe = use services.MeanRevUniverse default
		os.Getenv("MEANREV_BEAR_MODE"),
	)
	meanRevController := controllers.NewMeanRevController(meanRevCandidatesSvc)
	logger.Debug("Mean reversion signal service initialized")

	// Initialize Drift signal pipeline (used by Drift for PEAD post-earnings
	// drift on S&P 500 large-caps). Pulls recent earnings from
	// EarningsCalendarService via FetchRecentReports and computes the 5-factor
	// scorecard + PEAD weekly-candle pattern in Go (no Python skill
	// dependency). Earnings source is wired only when the FMP-backed
	// earnings calendar is available — otherwise the candidates endpoint
	// returns an "no earnings source configured" error in resp.Errors.
	driftSignalSvc := services.NewDriftSignalService(dataService)
	driftSignalSvc.SetInferTimingEnabled(cfg.EnableDriftInferTiming)
	logger.WithField("mode", map[bool]string{true: "on", false: "off (legacy amc-default)"}[cfg.EnableDriftInferTiming]).
		Info("Drift earnings-timing inference")
	var driftRecentReporter services.RecentReporterFetcher
	if earningsService != nil {
		driftRecentReporter = earningsService
	}
	driftCandidatesSvc := services.NewDriftCandidatesService(
		driftSignalSvc,
		driftRecentReporter,
		nil, // nil universe = use services.DriftUniverse default
	)
	driftCandidatesSvc.SetContinuationEnabled(cfg.EnableDriftContinuation)
	logger.WithField("mode", map[bool]string{true: "enforce", false: "shadow"}[cfg.EnableDriftContinuation]).
		Info("Drift continuation entry path")
	driftController := controllers.NewDriftController(driftCandidatesSvc)
	logger.Debug("Drift signal service initialized")

	// Initialize Segment P&L service (used by segment-scoped circuit breakers)
	segmentPnLSvc := services.NewSegmentPnLService(storageService, tradingService)
	segmentPnLController := controllers.NewSegmentPnLController(segmentPnLSvc)
	logger.Debug("Segment P&L service initialized")

	// Wire the EOD daily-mark writer into the position monitor: once per trading
	// day after close it persists a DBSegmentPnL row per strategy (Foundation B).
	positionManager.SetSegmentWriter(services.NewSegmentPnLWriter(storageService, segmentPnLSvc, logger))

	// Wire the report-only orphan detector's reporter. Detected orphans (ledger
	// marked terminal while the broker still holds the shares) are written to
	// <db-dir>/reports/orphans.json next to this sandbox's database.
	positionManager.SetOrphanReporter(services.NewOrphanReporter(filepath.Join(filepath.Dir(cfg.DatabasePath), "reports")))

	// Orphan auto-flatten (Layer B). Default off; acts only when BOTH the enable
	// flag and the dedicated-account affirmation are set.
	nyLocOrphan, _ := time.LoadLocation("America/New_York")
	positionManager.SetOrphanAutoFlatten(services.OrphanAutoFlattenConfig{
		Enabled:            cfg.EnableOrphanAutoFlatten,
		AccountIsDedicated: cfg.OrphanAutoFlattenAccountIsDedicated,
		Streak:             cfg.OrphanAutoFlattenStreak,
		MarketIsOpen:       func() bool { return services.StaticMarketPhase(time.Now().UTC(), nyLocOrphan) == "open" },
	})
	if cfg.EnableOrphanAutoFlatten && !cfg.OrphanAutoFlattenAccountIsDedicated {
		logger.Warn("orphan auto-flatten ENABLED but account NOT affirmed dedicated (ORPHAN_AUTOFLATTEN_ACCOUNT_IS_DEDICATED) — refusing to act; Layer A detection/surfacing still runs")
	} else if cfg.EnableOrphanAutoFlatten {
		logger.WithField("streak", cfg.OrphanAutoFlattenStreak).Warn("orphan auto-flatten ARMED (account affirmed dedicated)")
	}

	// Turtle Go scheduler (TURTLE_SCHEDULER_ENABLED=false by default).
	// When enabled, the daily 17:00 ET TRADING_RULES_TREND.md heartbeat
	// sequence runs in this Go service instead of the LLM. The trend agent's
	// preflight then skips every beat — the LLM is retained only for the
	// quarterly trend_parameter_review skill (operator-triggered).
	//
	// Dark-launch lifecycle: when the env flag is unset/false, no scheduler
	// is constructed and no /api/v1/turtle/status endpoint is registered.
	// agent/preflight.js's kill-switch check then 404s and falls through to
	// the existing trendPreflight behavior.
	var turtleController *controllers.TurtleController
	if os.Getenv("TURTLE_SCHEDULER_ENABLED") == "true" && tradingService != nil {
		turtleLedger := services.NewTurtleLedger(storageService)
		turtleExecutor := services.NewTurtleExecutor(
			turtleLedger,
			trendSignalSvc,
			dataService,
			tradingService,
			segmentPnLSvc,
			regimeGate,
			tradeGuard,
			logger,
		)
		turtleScheduler := services.NewTurtleScheduler(turtleExecutor, logger)
		turtleController = controllers.NewTurtleController(turtleScheduler)
		go turtleScheduler.Start(ctx)
		logger.Info("Turtle Go scheduler started (TURTLE_SCHEDULER_ENABLED=true)")
	} else if os.Getenv("TURTLE_SCHEDULER_ENABLED") == "true" {
		logger.Warn("Turtle Go scheduler requested but trading service unavailable — scheduler not started")
	}

	// Defensive-Prophet hedge scheduler (ENABLE_PROPHET_DEFENSIVE=false by default).
	// Triggered, defined-risk QQQ put-spread hedge — a mechanical daily 17:00 ET
	// beat like Turtle. When the flag is off, nothing is constructed.
	if cfg.EnableProphetDefensive && tradingService != nil {
		hedgeLedger := services.NewProphetHedgeLedger(storageService)
		hedgeOptionsData := services.NewAlpacaOptionsDataService(cfg.AlpacaAPIKey, cfg.AlpacaSecretKey)
		hedgeExecutor := services.NewProphetHedgeExecutor(
			hedgeLedger,
			regimeGate,
			hedgeOptionsData,
			tradingService,
			services.NewHedgeAccountFetcher(tradingService, dataService),
			tradeGuard,
			logger,
		)
		hedgeScheduler := services.NewProphetHedgeScheduler(hedgeExecutor, logger)
		go hedgeScheduler.Start(ctx)
		logger.Info("Defensive-Prophet hedge scheduler started (ENABLE_PROPHET_DEFENSIVE=true)")
	} else if cfg.EnableProphetDefensive {
		logger.Warn("Defensive-Prophet hedge requested but trading service unavailable — scheduler not started")
	}

	// Prophet debit-vertical manage loop (ENABLE_PROPHET_DEBIT_VERTICALS=false
	// by default). LLM-triggered opens arrive via the Phase-3 tools; this
	// intraday loop only reconciles fills and fires the deterministic backstops,
	// so with no verticals it is a no-op. Distinct "v2-vertical" strategy tag
	// keeps the options stop monitor away from vertical legs.
	// Build the vertical engine unconditionally (inert when unused); start the
	// scheduler only when the flag is enabled.
	var verticalExecutor *services.ProphetVerticalExecutor
	var verticalProposer *services.VerticalProposer
	if tradingService != nil {
		verticalLedger := services.NewProphetVerticalLedger(storageService)
		verticalOptionsData := services.NewAlpacaOptionsDataService(cfg.AlpacaAPIKey, cfg.AlpacaSecretKey)
		verticalExecutor = services.NewProphetVerticalExecutor(
			verticalLedger,
			verticalOptionsData,
			services.NewHedgeAccountFetcher(tradingService, dataService), // GetLatestBar provider
			tradingService,
			tradeGuard,
			logger,
		)
		verticalProposer = services.NewVerticalProposerForBot(tradingService, dataService, tradeGuard, realizedVolSvc)
		orderController.SetVerticals(verticalProposer, verticalExecutor, cfg.EnableProphetDebitVerticals)

		if cfg.EnableProphetDebitVerticals {
			nyLocVert, _ := time.LoadLocation("America/New_York")
			verticalMarketOpen := func() bool { return services.StaticMarketPhase(time.Now().UTC(), nyLocVert) == "open" }
			verticalScheduler := services.NewProphetVerticalScheduler(verticalExecutor, services.VerticalTickInterval(), services.VerticalIdleInterval(), verticalMarketOpen, logger)
			go verticalScheduler.Start(ctx)
			logger.Info("Prophet debit-vertical scheduler started (ENABLE_PROPHET_DEBIT_VERTICALS=true)")
		}
	} else if cfg.EnableProphetDebitVerticals {
		logger.Warn("Prophet debit-verticals requested but trading service unavailable — scheduler not started")
	}

	// Beat-context aggregator endpoint. Bundles account, positions, econ
	// blackout, regime gate, and segment P&L into a single response so the
	// harness can inject one read-only block per beat instead of the LLM
	// making 4-5 separate MCP tool calls. Soft-fails on any downstream
	// error (200 with errors[]); the agent's per-tool fail-closed policy
	// (TRADING_RULES_*.md) takes over from there.
	beatCtxController := controllers.NewBeatContextController(
		&accountFetcherAdapter{orderController: orderController},
		&positionsFetcherAdapter{orderController: orderController},
		&blackoutFetcherAdapter{econCalendarSvc: econCalendarService},
		&regimeFetcherAdapter{regimeGate: regimeGate},
		&segmentPnLFetcherAdapter{svc: segmentPnLSvc},
	)
	logger.Debug("Beat-context controller initialized")

	// Prophet options auto-stop monitor (default OFF; operator opts in).
	// A deep catastrophic loss floor on Prophet's long single-leg options that
	// the LLM heartbeat can't react to fast enough (esp. an overnight gap at the
	// open). Scoped to v2-options long positions.
	if cfg.EnableProphetOptionsStop {
		prophetBeatObserver := services.NewProphetBeatObserver()
		beatCtxController.SetProphetBeatRecorder(prophetBeatObserver)
		optDataSvc := services.NewAlpacaOptionsDataService(cfg.AlpacaAPIKey, cfg.AlpacaSecretKey)
		stopMonitor := services.NewProphetOptionsStopMonitor(
			tradingService, // ListOptionsPositions
			optDataSvc,     // GetOptionSnapshot
			tradingService, // PlaceOptionsOrder / ListOrders / GetOrder / CancelOrder
			services.ProphetOptionsStopConfig{
				StopPct:              cfg.ProphetOptionsStopPct,
				Cooloff:              time.Duration(cfg.ProphetOptionsStopCooloffMin) * time.Minute,
				Escalation:           time.Duration(cfg.ProphetOptionsStopEscalationSec) * time.Second,
				SanityFloorFrac:      cfg.ProphetOptionsStopSanityFloorFrac,
				StuckExitEnabled:     cfg.ProphetStuckExitEnabled,
				StuckExitWindow:      time.Duration(cfg.ProphetStuckExitWindowMin) * time.Minute,
				StuckExitMinReprices: cfg.ProphetStuckExitMinReprices,
			},
		)
		stopMonitor.SetRawOwnershipChecker(tradeGuard)
		stopMonitor.SetBeatObserver(prophetBeatObserver)
		nyLocStop, _ := time.LoadLocation("America/New_York")
		stopMarketOpen := func() bool { return services.StaticMarketPhase(time.Now().UTC(), nyLocStop) == "open" }
		go stopMonitor.Start(ctx, 1*time.Minute, 5*time.Minute, stopMarketOpen)
		logger.WithField("stuck_exit_escalation", cfg.ProphetStuckExitEnabled).
			Info("Prophet options stop monitor started (ENABLE_PROPHET_OPTIONS_STOP=true)")
	} else {
		logger.Info("Prophet options stop monitor disabled (ENABLE_PROPHET_OPTIONS_STOP!=true)")
	}

	// Generic IV-rank controller (Prophet, via /api/v1/iv/:symbol).
	// rvSvc enriches the response with realized_vol_20d + iv_minus_rv.
	ivController := controllers.NewIVController(ivRankSvc, realizedVolSvc)
	logger.Debug("IV controller initialized")

	// Intraday signal service + controller (auto-pushed into Prophet beats,
	// also available on-demand via the get_intraday_signals MCP tool). Uses a
	// dedicated tightly-bounded Alpaca client so its per-beat fetch budget is
	// isolated from heavy batch callers on the shared client.
	intradayDataService := services.NewIntradayAlpacaDataService(
		cfg.AlpacaAPIKey,
		cfg.AlpacaSecretKey,
	)
	intradaySignalSvc := services.NewIntradaySignalService(intradayDataService)
	intradayController := controllers.NewIntradayController(intradaySignalSvc)
	logger.Debug("Intraday signal service initialized")

	// Setup HTTP server
	router := setupRouter(
		orderController,
		newsController,
		intelligenceController,
		positionController,
		activityController,
		economicFeedsController,
		guardController,
		sleeveController,
		orphanController,
		trendController,
		meanRevController,
		driftController,
		segmentPnLController,
		ivController,
		intradayController,
		regimeGateController,
		beatCtxController,
		turtleController,
	)

	// Start data cleanup routine
	go startDataCleanup(ctx, storageService, cfg.DataRetentionDays, logger)

	// Start position monitor
	go startPositionMonitor(ctx, orderController, storageService, logger)

	// Start managed position monitoring
	go positionManager.MonitorPositions(ctx)

	// Keep the Coil/Drift candidate caches hot during their weekday ET beat
	// windows, but gate per-agent: only the bot whose agent reads a cache warms
	// it (Coil→meanrev, Drift→drift), set via ENABLE_MEANREV_WARMER /
	// ENABLE_DRIFT_WARMER by the orchestrator. The other four bots previously
	// warmed caches nothing reads — the dominant source of redundant cross-agent
	// daily-bar fetches. Gating only ever degrades to a slower on-demand cold
	// scan (fail-open), never to wrong/empty candidates.
	var candidateWarmers []services.CandidateRefresher
	if os.Getenv("ENABLE_MEANREV_WARMER") == "true" {
		candidateWarmers = append(candidateWarmers, meanRevCandidatesSvc)
	}
	if os.Getenv("ENABLE_DRIFT_WARMER") == "true" {
		candidateWarmers = append(candidateWarmers, driftCandidatesSvc)
	}
	if len(candidateWarmers) > 0 {
		go services.RunCandidateCacheWarmer(ctx, services.CandidateCacheWarmInterval, logger, candidateWarmers...)
		logger.WithField("warmers", len(candidateWarmers)).Info("Candidate cache warmer started")
	} else {
		logger.Info("Candidate cache warmer disabled (no ENABLE_MEANREV_WARMER/ENABLE_DRIFT_WARMER)")
	}

	// Setup graceful shutdown
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-shutdown
		logger.Info("Shutting down gracefully...")
		cancel()
		time.Sleep(2 * time.Second)
		os.Exit(0)
	}()

	// Start HTTP server
	logger.WithField("port", cfg.ServerPort).Info("Starting HTTP server...")
	if err := router.Run(":" + cfg.ServerPort); err != nil {
		logger.Fatal("Failed to start server:", err)
	}
}

func setupRouter(
	orderController *controllers.OrderController,
	newsController *controllers.NewsController,
	intelligenceController *controllers.IntelligenceController,
	positionController *controllers.PositionManagementController,
	activityController *controllers.ActivityController,
	economicFeedsController *controllers.EconomicFeedsController,
	guardController *controllers.GuardController,
	sleeveController *controllers.SleeveController,
	orphanController *controllers.OrphanController,
	trendController *controllers.TrendController,
	meanRevController *controllers.MeanRevController,
	driftController *controllers.DriftController,
	segmentPnLController *controllers.SegmentPnLController,
	ivController *controllers.IVController,
	intradayController *controllers.IntradayController,
	regimeGateController *controllers.RegimeGateController,
	beatCtxController *controllers.BeatContextController,
	turtleController *controllers.TurtleController,
) *gin.Engine {
	router := gin.Default()
	router.SetTrustedProxies([]string{"127.0.0.1"})

	// Enable CORS
	router.Use(func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})

	// Health check
	router.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "healthy"})
	})

	// Trading endpoints
	api := router.Group("/api/v1")
	{
		// Order endpoints
		api.POST("/orders/buy", orderController.HandleBuy)
		api.POST("/orders/sell", orderController.HandleSell)
		api.DELETE("/orders/:id", orderController.HandleCancelOrder)
		api.GET("/orders", orderController.HandleGetOrders)
		api.GET("/fills/summary", orderController.HandleFillsSummary)

		// Position and account endpoints
		api.GET("/positions", orderController.HandleGetPositions)
		api.GET("/account", orderController.HandleGetAccount)

		// Market data endpoints
		api.GET("/market/quote/:symbol", orderController.HandleGetQuote)
		api.GET("/market/bar/:symbol", orderController.HandleGetBar)
		api.GET("/market/bars/:symbol", orderController.HandleGetBars)

		// Options trading endpoints
		api.POST("/options/order", orderController.PlaceOptionsOrder)
		api.GET("/options/positions", orderController.ListOptionsPositions)
		api.GET("/options/position/:symbol", orderController.GetOptionsPosition)
		api.GET("/options/chain/:symbol", orderController.GetOptionsChain)

		// Debit vertical endpoints (Phase 3a — flag-gated)
		api.POST("/options/verticals/propose", orderController.ProposeVertical)
		api.POST("/options/verticals/place", orderController.PlaceVertical)
		api.GET("/options/verticals", orderController.ListVerticals)
		api.POST("/options/verticals/close", orderController.CloseVertical)

		// News endpoints
		api.GET("/news", newsController.HandleGetNews)
		api.GET("/news/topic/:topic", newsController.HandleGetNewsByTopic)
		api.GET("/news/search", newsController.HandleSearchNews)
		api.GET("/news/market", newsController.HandleGetMarketNews)

		// MarketWatch endpoints
		api.GET("/news/marketwatch/topstories", newsController.HandleGetMarketWatchTopStories)
		api.GET("/news/marketwatch/realtime", newsController.HandleGetMarketWatchRealtimeHeadlines)
		api.GET("/news/marketwatch/bulletins", newsController.HandleGetMarketWatchBulletins)
		api.GET("/news/marketwatch/marketpulse", newsController.HandleGetMarketWatchMarketPulse)
		api.GET("/news/marketwatch/all", newsController.HandleGetAllMarketWatchNews)

		// Intelligence endpoints (AI-powered)
		api.POST("/intelligence/cleaned-news", intelligenceController.HandleGetCleanedNews)
		api.GET("/intelligence/quick-market", intelligenceController.HandleGetQuickMarketIntelligence)
		api.GET("/intelligence/analyze/:symbol", intelligenceController.HandleAnalyzeStock)
		api.POST("/intelligence/analyze-multiple", intelligenceController.HandleAnalyzeMultipleStocks)

		// Position management endpoints
		api.POST("/positions/managed", positionController.HandlePlaceManagedPosition)
		api.GET("/positions/managed", positionController.HandleListManagedPositions)
		api.GET("/positions/managed/:id", positionController.HandleGetManagedPosition)
		api.DELETE("/positions/managed/:id", positionController.HandleCloseManagedPosition)

		// Activity logging endpoints
		// Economic intelligence feeds (free, no API key required)
		api.GET("/feeds/treasury", economicFeedsController.HandleGetTreasury)
		api.GET("/feeds/gdelt", economicFeedsController.HandleGetGDELT)
		api.GET("/feeds/bls", economicFeedsController.HandleGetBLS)
		api.GET("/feeds/yfinance", economicFeedsController.HandleGetYFinance)
		api.GET("/feeds/usaspending", economicFeedsController.HandleGetUSASpending)
		api.GET("/feeds/comtrade", economicFeedsController.HandleGetComtrade)

		// US-economic-release blackout window (shared across all four agents)
		api.GET("/econ/blackout", economicFeedsController.HandleGetEconBlackout)

		// Generic IV rank/percentile lookup (latest stored snapshot per symbol)
		api.GET("/iv/:symbol", ivController.HandleGetIV)

		// Intraday signals (compact per-symbol blob; cached 60s)
		api.GET("/intraday/signals", intradayController.HandleGetSignals)

		api.GET("/activity/current", activityController.HandleGetCurrentActivity)
		api.GET("/activity/:date", activityController.HandleGetActivityByDate)
		api.GET("/activity", activityController.HandleListActivityLogs)
		api.POST("/activity/session/start", activityController.HandleStartSession)
		api.POST("/activity/session/end", activityController.HandleEndSession)
		api.POST("/activity/log", activityController.HandleLogActivity)

		// Trade guard endpoint
		api.GET("/guard/status", guardController.HandleGetStatus)

		// Prophet fun-sleeve gate: status + independent manual kill switch.
		api.GET("/sleeve/status", sleeveController.HandleGetStatus)
		api.POST("/sleeve/kill", sleeveController.HandleKill)

		// Orphan / auto-flatten read-only snapshot (Layer A surfacing).
		api.GET("/orphans/status", orphanController.HandleGetStatus)

		// Regime gate endpoint (Item 2). Returns the daily-computed regime
		// status; agents consume tier/sizing_multiplier/block_new_entries.
		api.GET("/regime-gate/status", regimeGateController.HandleGetStatus)

		trend := api.Group("/trend")
		{
			trend.GET("/signal/:symbol", trendController.HandleGetSignal)
		}

		// Coil mean-reversion endpoints (RSI(2) + SMA(200) + SMA(5)).
		// /candidates: pre-filtered, RSI-sorted list for the daily 15:45 ET beat.
		// /signal/:symbol: ad-hoc per-symbol lookup for operator inspection.
		// /universe: introspection of the curated S&P 500 large-cap list.
		meanrev := api.Group("/meanrev")
		{
			meanrev.GET("/candidates", meanRevController.HandleGetCandidates)
			meanrev.GET("/signal/:symbol", meanRevController.HandleGetSignal)
			meanrev.GET("/universe", meanRevController.HandleGetUniverse)
		}

		// Drift PEAD endpoints (5-factor scorecard + weekly-candle pattern).
		// /candidates: ranked list of grade-A/B post-earnings tickers in the
		//   curated universe whose earnings landed in the last 5 trading days.
		// /signal/:symbol: ad-hoc per-symbol lookup (operator + agent exit-side
		//   checks). Requires earnings_date + timing query params.
		// /universe: introspection of the curated universe.
		drift := api.Group("/drift")
		{
			drift.GET("/candidates", driftController.HandleGetCandidates)
			drift.GET("/signal/:symbol", driftController.HandleGetSignal)
			drift.GET("/universe", driftController.HandleGetUniverse)
		}

		// Turtle scheduler status endpoint — only registered when the env flag
		// enabled construction in main(). When nil, the route is absent and
		// preflight.js correctly 404s and falls through to the LLM-beat logic.
		if turtleController != nil {
			api.GET("/turtle/status", turtleController.HandleGetStatus)
		}

		api.GET("/segment-pnl/:strategy", segmentPnLController.HandleGetSegmentPnL)

		// Beat-context aggregator. The harness calls this once per beat
		// (when BEAT_CONTEXT_ENABLED=true) and injects the response as a
		// single read-only block, replacing 4-5 separate MCP tool calls.
		api.GET("/beat-context", beatCtxController.HandleGet)
	}

	// Serve dashboard
	router.Static("/dashboard", "./web")

	return router
}

// Background task to clean up old data
func startDataCleanup(ctx context.Context, storage interfaces.StorageService, retentionDays int, logger *logrus.Logger) {
	ticker := time.NewTicker(24 * time.Hour) // Run daily
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cutoff := time.Now().AddDate(0, 0, -retentionDays)
			logger.WithField("cutoff", cutoff).Info("Running data cleanup")

			if err := storage.CleanupOldData(cutoff); err != nil {
				logger.WithError(err).Error("Failed to cleanup old data")
			}
		}
	}
}

// startIVCollection records ATM IV for Prophet's IV-rank gate every 6h. The
// universe is SPY/QQQ (shared index underlyings) plus Prophet's mega-cap
// watchlist (NVDA/AMD/TSLA/MSTR). The IV data is consumed by
// IVRankService.GetIVRData and StockAnalysisService (Prophet's IV-rank gate).
// The table name (harvest_iv_snapshots) is retained for historical-data
// continuity.
func startIVCollection(ctx context.Context, ivrSvc *services.IVRankService, tradingService *services.AlpacaTradingService, logger *logrus.Logger) {
	ivUniverse := []string{
		"SPY", "QQQ", // shared index underlyings
		"NVDA", "AMD", "TSLA", "MSTR", // Prophet mega-cap watchlist
	}
	ticker := time.NewTicker(6 * time.Hour)
	defer ticker.Stop()

	collectAll := func() {
		for _, symbol := range ivUniverse {
			if tradingService == nil {
				continue
			}
			chain, err := tradingService.GetOptionsChain(ctx, symbol, time.Now().AddDate(0, 0, 30))
			if err != nil {
				logger.WithError(err).Warnf("IV collection: failed to get chain for %s", symbol)
				continue
			}
			atmIV := calcATMIV(chain)
			if atmIV <= 0 {
				continue
			}
			if err := ivrSvc.RecordDailyIV(symbol, atmIV); err != nil {
				logger.WithError(err).Warnf("IV collection: failed to record IV for %s", symbol)
			}
		}
	}

	collectAll() // run immediately on startup

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			collectAll()
		}
	}
}

// calcATMIV averages the IV of contracts with |delta| in [0.45, 0.55].
func calcATMIV(chain []*interfaces.OptionContract) float64 {
	var sum float64
	var count int
	for _, c := range chain {
		absDelta := c.Delta
		if absDelta < 0 {
			absDelta = -absDelta
		}
		if absDelta >= 0.45 && absDelta <= 0.55 && c.ImpliedVolatility > 0 {
			sum += c.ImpliedVolatility
			count++
		}
	}
	if count == 0 {
		return 0
	}
	return sum / float64(count)
}

// Background task to monitor and save account snapshots.
//
// Position snapshots were previously written here but the DBPosition schema's
// uniqueIndex on Symbol made every save after the first per symbol error with
// `UNIQUE constraint failed: positions.symbol`. Nothing in the codebase reads
// the positions table, so the save was removed rather than fixed. Position
// history is available via DBOrder + Alpaca's live positions endpoint.
func startPositionMonitor(ctx context.Context, orderController *controllers.OrderController, storage *database.LocalStorage, logger *logrus.Logger) {
	ticker := time.NewTicker(5 * time.Minute) // Check every 5 minutes
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if account, err := orderController.GetAccount(); err == nil {
				if err := storage.SaveAccountSnapshot(account); err != nil {
					logger.WithError(err).Error("Failed to save account snapshot")
				}
			}
		}
	}
}

// ── Beat-context adapters ───────────────────────────────────────────
//
// These thin wrappers bridge the existing concrete services / controllers
// to the narrow interfaces declared in controllers/beat_context_controller.go.
// Keeping them in main.go (rather than in the controllers package) avoids a
// dependency cycle and keeps the controller test stub-able.

type accountFetcherAdapter struct {
	orderController *controllers.OrderController
}

func (a *accountFetcherAdapter) GetAccount() (controllers.Account, error) {
	acct, err := a.orderController.GetAccount()
	if err != nil {
		return controllers.Account{}, err
	}
	return controllers.Account{
		PortfolioValue: acct.PortfolioValue,
		Cash:           acct.Cash,
		BuyingPower:    acct.BuyingPower,
	}, nil
}

type positionsFetcherAdapter struct {
	orderController *controllers.OrderController
}

func (a *positionsFetcherAdapter) GetPositionsByStrategy(strategy string) ([]controllers.PositionSummary, error) {
	positions, err := a.orderController.GetPositionsByStrategy(strategy)
	if err != nil {
		return nil, err
	}
	out := make([]controllers.PositionSummary, 0, len(positions))
	for _, p := range positions {
		if p == nil {
			continue
		}
		out = append(out, controllers.PositionSummary{
			Symbol:           p.Symbol,
			Qty:              p.Qty,
			UnrealizedPnL:    p.UnrealizedPL,
			UnrealizedPnLPct: p.UnrealizedPLPC,
		})
	}
	return out, nil
}

// blackoutFetcherAdapter wraps the econ calendar service directly rather than
// going through the HTTP controller. When FMP_API_KEY is unset the service
// pointer is nil (see main.go FMP_API_KEY check); we surface that as a soft
// error so the beat-context endpoint reports it via errors[] rather than
// pretending blackout is false.
type blackoutFetcherAdapter struct {
	econCalendarSvc *services.EconCalendarService
}

func (a *blackoutFetcherAdapter) EconBlackoutStatus() (bool, string, error) {
	if a.econCalendarSvc == nil {
		return false, "", errors.New("econ calendar not configured")
	}
	status := a.econCalendarSvc.GetBlackoutStatus(context.Background(), time.Now().UTC())
	if status == nil {
		return false, "", errors.New("econ calendar returned nil status")
	}
	if status.Error != "" {
		return status.IsBlackout, status.Reason, errors.New(status.Error)
	}
	return status.IsBlackout, status.Reason, nil
}

// regimeFetcherAdapter wraps the regime gate service. The service's GetStatus
// never errors (it fails open internally to a neutral status), so the adapter
// always returns nil error; the interface admits an error slot to keep the
// controller signature uniform across deps.
type regimeFetcherAdapter struct {
	regimeGate *services.RegimeGateService
}

func (a *regimeFetcherAdapter) GetStatus() (services.RegimeGateStatus, error) {
	return a.regimeGate.GetStatus(), nil
}

type segmentPnLFetcherAdapter struct {
	svc *services.SegmentPnLService
}

func (a *segmentPnLFetcherAdapter) GetSegmentPnL(ctx context.Context, strategy string) (*services.SegmentPnL, error) {
	return a.svc.GetSegmentPnL(ctx, strategy)
}
