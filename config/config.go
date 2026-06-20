package config

import (
	"os"
	"strconv"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	AlpacaAPIKey      string
	AlpacaSecretKey   string
	AlpacaBaseURL     string
	AlpacaPaper       bool
	ClaudeAPIKey      string
	XAIAPIKey         string
	AIProvider        string // "claude" or "xai"; auto-detected from available keys if unset
	FMPAPIKey         string
	DatabasePath      string
	ServerPort        string
	EnableLogging     bool
	LogLevel          string
	DataRetentionDays int

	// AlpacaDataRatePerMin is the shared Alpaca data-API rate cap (requests/min)
	// governing bar + options-chain fetches. Default 180 leaves headroom under
	// the Basic plan's 200/min account limit; raise on higher tiers. <=0 disables.
	AlpacaDataRatePerMin int

	// Trade guard limits
	MaxDailyLossPct float64 // daily loss circuit breaker as positive percent, e.g. 5.0; 0 disables

	EnableSectorAggregation bool    // turn on cross-agent sector concentration cap
	SectorDefaultMaxPct     float64 // fallback cap for buckets without an explicit override

	// Regime gate (Item 2). Flag-gated rollout: while EnableRegimeGate is false
	// the service still loads and reports the underlying tier (for observation
	// in /api/v1/regime-gate/status), but sizing_multiplier and block_new_entries
	// stay neutral so no agent behavior changes until enforcement is turned on.
	EnableRegimeGate bool
	RegimeReportPath string

	// Defensive-Prophet hedge (flag-gated rollout, default OFF). When false the
	// executor/scheduler is never constructed in cmd/bot (mirrors the regime-gate
	// observe-before-enable pattern).
	EnableProphetDefensive bool

	// Prophet debit-vertical teaching sleeve (flag-gated rollout, default OFF).
	// When false the vertical executor/scheduler is never constructed in cmd/bot.
	EnableProphetDebitVerticals bool

	// EnableProphetSingleLegAttribution gates the single-leg P&L attribution
	// hooks in PositionManager (Phase 4 foundation). Default false.
	EnableProphetSingleLegAttribution bool

	// Position caps (hybrid hard backstops). Flag-gated like the regime gate.
	EnablePositionCaps bool
	MaxPositionPct     float64 // per-position cap, fraction of portfolio (0.12 = 12%)
	MaxDeployedPct     float64 // whole-account deployed ceiling (0.50 = 50%)

	// Per-agent (non-Prophet) tradable-universe gate. Flag-gated, default OFF
	// (observe-first). One flag covers Coil/Drift equity buys (via CheckBuy).
	EnableAgentUniverseGate bool

	// Drift continuation entry path. Flag-gated, default OFF (shadow: backend
	// logs would-be continuation entries but the agent does not act). See the
	// 2026-05-29 spec.
	EnableDriftContinuation bool
	EnableDriftInferTiming  bool

	// Prophet tradable-universe gate + options spread gate. Both flag-gated,
	// default OFF (observe-first). See the 2026-05-24 spec.
	EnableUniverseGate         bool
	TradableUniversePath       string
	EnableProphetOptionsSpread bool
	ProphetSpreadMaxPct        float64
	ProphetQuoteMaxAgeSec      int

	// Prophet options auto-stop monitor. Flag-gated, default OFF.
	// Deep catastrophic loss floor on Prophet's long single-leg options.
	EnableProphetOptionsStop          bool
	ProphetOptionsStopPct             float64
	ProphetOptionsStopCooloffMin      float64
	ProphetOptionsStopEscalationSec   float64
	ProphetOptionsStopSanityFloorFrac float64

	// Stuck-exit escalation. Rides on the stop monitor (requires
	// ENABLE_PROPHET_OPTIONS_STOP=true). When the LLM repeatedly cancels unfilled
	// sell limits — a thesis-broken winner it can't exit at mid — the monitor
	// crosses the spread with a marketable flatten. Default OFF.
	ProphetStuckExitEnabled     bool
	ProphetStuckExitWindowMin   float64
	ProphetStuckExitMinReprices int

	// Shared daily-bar cache (cross-agent on-disk read cache for >=1Day bars).
	// Default ON — a pure, soft-failing read optimization. See
	// docs/superpowers/specs/2026-05-22-shared-daily-bar-cache-design.md.
	BarCacheEnabled bool
	BarCacheDir     string
	BarCacheTTL     time.Duration

	// Prophet fun-sleeve real-money safety gate. Flag-gated, default OFF.
	// Unlike the other gates, this one FAILS CLOSED on missing config (a money
	// gate's safe state is "block"). See the 2026-06-03 spec.
	EnableProphetSleeve          bool
	ProphetSleeveBaselineUSD     float64 // funded baseline B; <=0 => fail closed when enabled
	ProphetSleeveMaxPositionFrac float64 // per-position cap as fraction of B (0.25)
	ProphetSleeveMaxPositions    int     // concurrency cap (5)
	ProphetSleeveLossBudgetFrac  float64 // permanent-disarm realized-loss threshold as fraction of B (0.50)
	ProphetSleeveDeadline        string  // off-ramp date YYYY-MM-DD; empty/invalid => fail closed when enabled
	ProphetSleeveDisarmDir       string  // dir for kill/latch files; empty => derive from DatabasePath dir in main.go
}

var AppConfig *Config

func Load() error {
	// Load .env file if it exists (don't override existing env vars)
	_ = godotenv.Load()

	AppConfig = &Config{
		// Accept ALPACA_API_KEY (Go convention) or ALPACA_PUBLIC_KEY (.env.example /
		// README / Node side). Same dual-name fallback as agent/config-store.js.
		AlpacaAPIKey:    firstEnvOrDefault("", "ALPACA_API_KEY", "ALPACA_PUBLIC_KEY"),
		AlpacaSecretKey: os.Getenv("ALPACA_SECRET_KEY"),
		AlpacaBaseURL:   firstEnvOrDefault("https://paper-api.alpaca.markets", "ALPACA_BASE_URL", "ALPACA_ENDPOINT"),
		AlpacaPaper:     getEnvOrDefault("ALPACA_PAPER", "true") == "true",

		AlpacaDataRatePerMin: parseIntOrDefault("ALPACA_DATA_RATE_PER_MIN", 180),
		ClaudeAPIKey:         os.Getenv("CLAUDE_API_KEY"),
		XAIAPIKey:            os.Getenv("XAI_API_KEY"),
		AIProvider:           resolveAIProvider(os.Getenv("AI_PROVIDER"), os.Getenv("CLAUDE_API_KEY"), os.Getenv("XAI_API_KEY")),
		FMPAPIKey:            os.Getenv("FMP_API_KEY"),
		DatabasePath:         getEnvOrDefault("DATABASE_PATH", "./data/prophet_trader.db"),
		ServerPort:           getEnvOrDefault("PORT", getEnvOrDefault("SERVER_PORT", "4534")),
		EnableLogging:        getEnvOrDefault("ENABLE_LOGGING", "true") == "true",
		LogLevel:             getEnvOrDefault("LOG_LEVEL", "info"),
		DataRetentionDays:    90,

		MaxDailyLossPct: parseFloat(getEnvOrDefault("MAX_DAILY_LOSS_PCT", "5")),

		// Flag-gated rollout: defaults to false. Set ENABLE_SECTOR_AGGREGATION=true
		// after a 2-week observation window where Status() reports real bucket exposures.
		EnableSectorAggregation: getEnvOrDefault("ENABLE_SECTOR_AGGREGATION", "false") == "true",
		SectorDefaultMaxPct:     parseFloat(getEnvOrDefault("SECTOR_DEFAULT_MAX_PCT", "0.15")),

		// Regime gate defaults: enforcement off, canonical report path. Mirrors
		// EnableSectorAggregation — observe production output for ~2 weeks, then
		// flip ENABLE_REGIME_GATE=true.
		EnableRegimeGate: getEnvOrDefault("ENABLE_REGIME_GATE", "false") == "true",
		RegimeReportPath: getEnvOrDefault("REGIME_REPORT_PATH", "./data/reports/regime_gate.json"),

		EnableProphetDefensive: getEnvOrDefault("ENABLE_PROPHET_DEFENSIVE", "false") == "true",

		EnableProphetDebitVerticals: getEnvOrDefault("ENABLE_PROPHET_DEBIT_VERTICALS", "false") == "true",

		EnableProphetSingleLegAttribution: getEnvOrDefault("ENABLE_PROPHET_SINGLELEG_ATTRIBUTION", "false") == "true",

		EnablePositionCaps: getEnvOrDefault("ENABLE_POSITION_CAPS", "true") == "true",
		MaxPositionPct:     parseFloat(getEnvOrDefault("MAX_POSITION_PCT", "0.12")),
		MaxDeployedPct:     parseFloat(getEnvOrDefault("MAX_DEPLOYED_PCT", "0.50")),

		EnableAgentUniverseGate: getEnvOrDefault("ENABLE_AGENT_UNIVERSE_GATE", "false") == "true",
		EnableDriftContinuation: getEnvOrDefault("ENABLE_DRIFT_CONTINUATION", "false") == "true",
		EnableDriftInferTiming:  getEnvOrDefault("DRIFT_INFER_TIMING", "true") != "false",

		EnableUniverseGate:         getEnvOrDefault("ENABLE_PROPHET_UNIVERSE_GATE", "false") == "true",
		TradableUniversePath:       getEnvOrDefault("PROPHET_TRADABLE_UNIVERSE_PATH", "./config/prophet_tradable_universe.txt"),
		EnableProphetOptionsSpread: getEnvOrDefault("ENABLE_PROPHET_OPTIONS_SPREAD", "false") == "true",
		ProphetSpreadMaxPct:        parseFloat(getEnvOrDefault("PROPHET_OPTIONS_SPREAD_MAX_PCT", "0.10")),
		ProphetQuoteMaxAgeSec:      parseIntOrDefault("PROPHET_OPTIONS_QUOTE_MAX_AGE_SEC", 60),

		EnableProphetOptionsStop:          getEnvOrDefault("ENABLE_PROPHET_OPTIONS_STOP", "false") == "true",
		ProphetOptionsStopPct:             parseFloat(getEnvOrDefault("PROPHET_OPTIONS_STOP_PCT", "0.50")),
		ProphetOptionsStopCooloffMin:      parseFloat(getEnvOrDefault("PROPHET_OPTIONS_STOP_COOLOFF_MIN", "7")),
		ProphetOptionsStopEscalationSec:   parseFloat(getEnvOrDefault("PROPHET_OPTIONS_STOP_ESCALATION_SEC", "60")),
		ProphetOptionsStopSanityFloorFrac: parseFloat(getEnvOrDefault("PROPHET_OPTIONS_STOP_SANITY_FLOOR_FRAC", "0.50")),

		ProphetStuckExitEnabled:     getEnvOrDefault("ENABLE_PROPHET_STUCK_EXIT_ESCALATION", "false") == "true",
		ProphetStuckExitWindowMin:   parseFloat(getEnvOrDefault("PROPHET_STUCK_EXIT_WINDOW_MIN", "5")),
		ProphetStuckExitMinReprices: parseIntOrDefault("PROPHET_STUCK_EXIT_MIN_REPRICES", 3),

		BarCacheEnabled: getEnvOrDefault("BAR_CACHE_ENABLED", "true") == "true",
		BarCacheDir:     getEnvOrDefault("BAR_CACHE_DIR", "./data/bar-cache"),
		BarCacheTTL:     parseDurationOrDefault("BAR_CACHE_TTL", "5m"),

		EnableProphetSleeve:          getEnvOrDefault("ENABLE_PROPHET_SLEEVE", "false") == "true",
		ProphetSleeveBaselineUSD:     parseFloat(getEnvOrDefault("PROPHET_SLEEVE_BASELINE_USD", "0")),
		ProphetSleeveMaxPositionFrac: parseFloat(getEnvOrDefault("PROPHET_SLEEVE_MAX_POSITION_FRAC", "0.25")),
		ProphetSleeveMaxPositions:    parseIntOrDefault("PROPHET_SLEEVE_MAX_POSITIONS", 5),
		ProphetSleeveLossBudgetFrac:  parseFloat(getEnvOrDefault("PROPHET_SLEEVE_LOSS_BUDGET_FRAC", "0.50")),
		ProphetSleeveDeadline:        os.Getenv("PROPHET_SLEEVE_DEADLINE"),
		ProphetSleeveDisarmDir:       os.Getenv("PROPHET_SLEEVE_DISARM_DIR"),
	}

	return nil
}

// resolveAIProvider picks a provider. Explicit env var wins; otherwise infer from which key is set.
// If both keys are set and no explicit preference, claude is the default.
func resolveAIProvider(explicit, claudeKey, xaiKey string) string {
	if explicit != "" {
		return explicit
	}
	if xaiKey != "" && claudeKey == "" {
		return "xai"
	}
	return "claude"
}

func getEnvOrDefault(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

// firstEnvOrDefault returns the first non-empty value among the named env vars,
// falling back to defaultValue if all are empty. Used to accept legacy aliases.
func firstEnvOrDefault(defaultValue string, keys ...string) string {
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	return defaultValue
}

func parseFloat(s string) float64 {
	v, _ := strconv.ParseFloat(s, 64)
	return v
}

func parseIntOrDefault(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// parseDurationOrDefault reads a Go duration string (e.g. "5m", "90s") from key,
// falling back to def (which must itself parse) on absence or a parse error.
func parseDurationOrDefault(key, def string) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	d, _ := time.ParseDuration(def)
	return d
}
