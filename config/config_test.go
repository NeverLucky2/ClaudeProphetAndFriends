package config

import (
	"testing"
	"time"
)

// Regime gate defaults follow the Item 1 flag-gated rollout pattern:
// enforcement off until observed in production. ReportPath defaults to the
// canonical scheduler-written location so the operator doesn't have to set it.
func TestLoad_RegimeGate_DefaultsWhenEnvUnset(t *testing.T) {
	t.Setenv("OPERATOR_EMAIL", "test@example.com")
	t.Setenv("ENABLE_REGIME_GATE", "")
	t.Setenv("REGIME_REPORT_PATH", "")
	if err := Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if AppConfig.EnableRegimeGate {
		t.Error("EnableRegimeGate: want false default (flag-gated rollout)")
	}
	if AppConfig.RegimeReportPath != "./data/reports/regime_gate.json" {
		t.Errorf("RegimeReportPath default: want %q, got %q",
			"./data/reports/regime_gate.json", AppConfig.RegimeReportPath)
	}
}

// Accept the .env.example / README convention (ALPACA_PUBLIC_KEY,
// ALPACA_ENDPOINT) as fallbacks for the Go-canonical names (ALPACA_API_KEY,
// ALPACA_BASE_URL). Mirrors the dual-name behavior in agent/config-store.js so
// `go run ./cmd/bot/main.go` works against the same .env that the Node side
// already accepts.
func TestLoad_AlpacaKeys_FallbackToPublicKeyAndEndpoint(t *testing.T) {
	t.Setenv("OPERATOR_EMAIL", "test@example.com")
	t.Setenv("ALPACA_API_KEY", "")
	t.Setenv("ALPACA_BASE_URL", "")
	t.Setenv("ALPACA_PUBLIC_KEY", "pk-fallback")
	t.Setenv("ALPACA_ENDPOINT", "https://example.alpaca.test")
	if err := Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if AppConfig.AlpacaAPIKey != "pk-fallback" {
		t.Errorf("AlpacaAPIKey fallback: want %q, got %q", "pk-fallback", AppConfig.AlpacaAPIKey)
	}
	if AppConfig.AlpacaBaseURL != "https://example.alpaca.test" {
		t.Errorf("AlpacaBaseURL fallback: want %q, got %q", "https://example.alpaca.test", AppConfig.AlpacaBaseURL)
	}
}

// When both the canonical and legacy names are set, the canonical Go name wins.
func TestLoad_AlpacaKeys_CanonicalNamePreferredOverFallback(t *testing.T) {
	t.Setenv("OPERATOR_EMAIL", "test@example.com")
	t.Setenv("ALPACA_API_KEY", "pk-canonical")
	t.Setenv("ALPACA_PUBLIC_KEY", "pk-legacy")
	t.Setenv("ALPACA_BASE_URL", "https://canonical.alpaca.test")
	t.Setenv("ALPACA_ENDPOINT", "https://legacy.alpaca.test")
	if err := Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if AppConfig.AlpacaAPIKey != "pk-canonical" {
		t.Errorf("AlpacaAPIKey: canonical should win, got %q", AppConfig.AlpacaAPIKey)
	}
	if AppConfig.AlpacaBaseURL != "https://canonical.alpaca.test" {
		t.Errorf("AlpacaBaseURL: canonical should win, got %q", AppConfig.AlpacaBaseURL)
	}
}

func TestLoad_RegimeGate_HonorsEnvOverrides(t *testing.T) {
	t.Setenv("OPERATOR_EMAIL", "test@example.com")
	t.Setenv("ENABLE_REGIME_GATE", "true")
	t.Setenv("REGIME_REPORT_PATH", "/tmp/custom_regime.json")
	if err := Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !AppConfig.EnableRegimeGate {
		t.Error("EnableRegimeGate: want true when ENABLE_REGIME_GATE=true")
	}
	if AppConfig.RegimeReportPath != "/tmp/custom_regime.json" {
		t.Errorf("RegimeReportPath override: want %q, got %q",
			"/tmp/custom_regime.json", AppConfig.RegimeReportPath)
	}
}

func TestLoad_AlpacaDataRatePerMin_Default(t *testing.T) {
	t.Setenv("OPERATOR_EMAIL", "test@example.com") // required by Load
	t.Setenv("ALPACA_DATA_RATE_PER_MIN", "")
	if err := Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if AppConfig.AlpacaDataRatePerMin != 180 {
		t.Errorf("default: got %d, want 180", AppConfig.AlpacaDataRatePerMin)
	}
}

func TestLoad_AlpacaDataRatePerMin_Override(t *testing.T) {
	t.Setenv("OPERATOR_EMAIL", "test@example.com")
	t.Setenv("ALPACA_DATA_RATE_PER_MIN", "600")
	if err := Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if AppConfig.AlpacaDataRatePerMin != 600 {
		t.Errorf("override: got %d, want 600", AppConfig.AlpacaDataRatePerMin)
	}
}

func TestLoad_BarCache_Defaults(t *testing.T) {
	t.Setenv("OPERATOR_EMAIL", "ops@example.com")
	t.Setenv("BAR_CACHE_ENABLED", "")
	t.Setenv("BAR_CACHE_DIR", "")
	t.Setenv("BAR_CACHE_TTL", "")
	_ = Load()
	if !AppConfig.BarCacheEnabled {
		t.Error("BarCacheEnabled should default to true")
	}
	if AppConfig.BarCacheDir != "./data/bar-cache" {
		t.Errorf("BarCacheDir default: got %q, want ./data/bar-cache", AppConfig.BarCacheDir)
	}
	if AppConfig.BarCacheTTL != 5*time.Minute {
		t.Errorf("BarCacheTTL default: got %v, want 5m", AppConfig.BarCacheTTL)
	}
}

func TestLoad_BarCache_Overrides(t *testing.T) {
	t.Setenv("OPERATOR_EMAIL", "ops@example.com")
	t.Setenv("BAR_CACHE_ENABLED", "false")
	t.Setenv("BAR_CACHE_DIR", "/tmp/bc")
	t.Setenv("BAR_CACHE_TTL", "90s")
	_ = Load()
	if AppConfig.BarCacheEnabled {
		t.Error("BarCacheEnabled should be false when BAR_CACHE_ENABLED=false")
	}
	if AppConfig.BarCacheDir != "/tmp/bc" {
		t.Errorf("BarCacheDir override: got %q", AppConfig.BarCacheDir)
	}
	if AppConfig.BarCacheTTL != 90*time.Second {
		t.Errorf("BarCacheTTL override: got %v, want 90s", AppConfig.BarCacheTTL)
	}
}

func TestLoad_BarCacheTTL_BadValueFallsBackToDefault(t *testing.T) {
	t.Setenv("OPERATOR_EMAIL", "ops@example.com")
	t.Setenv("BAR_CACHE_TTL", "not-a-duration")
	_ = Load()
	if AppConfig.BarCacheTTL != 5*time.Minute {
		t.Errorf("bad BAR_CACHE_TTL must fall back to 5m, got %v", AppConfig.BarCacheTTL)
	}
}

func TestLoad_PositionCapDefaults(t *testing.T) {
	t.Setenv("OPERATOR_EMAIL", "test@example.com")
	if err := Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !AppConfig.EnablePositionCaps {
		t.Error("EnablePositionCaps should default true")
	}
	if AppConfig.MaxPositionPct != 0.12 {
		t.Errorf("MaxPositionPct = %v, want 0.12", AppConfig.MaxPositionPct)
	}
	if AppConfig.MaxDeployedPct != 0.50 {
		t.Errorf("MaxDeployedPct = %v, want 0.50", AppConfig.MaxDeployedPct)
	}
}

func TestLoadConfig_ProphetDefensiveDefaultsOff(t *testing.T) {
	t.Setenv("OPERATOR_EMAIL", "test@example.com")
	t.Setenv("ENABLE_PROPHET_DEFENSIVE", "")
	if err := Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if AppConfig.EnableProphetDefensive {
		t.Fatal("EnableProphetDefensive must default to false")
	}
}

func TestLoadConfig_ProphetDefensiveOn(t *testing.T) {
	t.Setenv("OPERATOR_EMAIL", "test@example.com")
	t.Setenv("ENABLE_PROPHET_DEFENSIVE", "true")
	if err := Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !AppConfig.EnableProphetDefensive {
		t.Fatal("ENABLE_PROPHET_DEFENSIVE=true must set the flag")
	}
}
