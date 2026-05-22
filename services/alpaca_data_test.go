package services

import (
	"context"
	"errors"
	"testing"
	"time"
)

// The Alpaca marketdata SDK defaults are dangerous for a latency-sensitive
// caller: RetryLimit=10, RetryDelay=1s, and a 10s per-request timeout (see
// marketdata/rest.go). A single rate-limited GetBars can block for ~60s. Both
// opts builders must clamp all three, but to different budgets:
//
//   - defaultAlpacaClientOpts: the shared client. Generous enough for heavy
//     batch callers (e.g. penny_max_filter's 100-symbol GetMultiBars) while
//     still far below the SDK default.
//   - intradayAlpacaClientOpts: a tight client for the latency-critical
//     intraday-signals path, which is independently deadline-bounded and just
//     needs fast cleanup of abandoned fetches.

func TestDefaultAlpacaClientOpts_ClampedButGenerous(t *testing.T) {
	opts := defaultAlpacaClientOpts("key", "secret")

	if opts.APIKey != "key" || opts.APISecret != "secret" {
		t.Errorf("credentials not passed through: %q / %q", opts.APIKey, opts.APISecret)
	}
	if opts.RetryLimit <= 0 || opts.RetryLimit > 4 {
		t.Errorf("RetryLimit must be clamped to a small positive value, got %d", opts.RetryLimit)
	}
	if opts.RetryDelay <= 0 || opts.RetryDelay > 500*time.Millisecond {
		t.Errorf("RetryDelay must be clamped to <=500ms, got %v", opts.RetryDelay)
	}
	if opts.HTTPClient == nil {
		t.Fatal("HTTPClient must be set so the per-request timeout is bounded")
	}
	// Generous enough for a 100-symbol batch, but well under the 10s default.
	if opts.HTTPClient.Timeout <= 2*time.Second || opts.HTTPClient.Timeout > 6*time.Second {
		t.Errorf("shared timeout should be in (2s, 6s], got %v", opts.HTTPClient.Timeout)
	}
}

func TestIntradayAlpacaClientOpts_Tight(t *testing.T) {
	opts := intradayAlpacaClientOpts("key", "secret")

	if opts.APIKey != "key" || opts.APISecret != "secret" {
		t.Errorf("credentials not passed through: %q / %q", opts.APIKey, opts.APISecret)
	}
	if opts.RetryLimit <= 0 || opts.RetryLimit > 2 {
		t.Errorf("intraday RetryLimit must be very small, got %d", opts.RetryLimit)
	}
	if opts.HTTPClient == nil {
		t.Fatal("HTTPClient must be set")
	}
	if opts.HTTPClient.Timeout <= 0 || opts.HTTPClient.Timeout > 2*time.Second {
		t.Errorf("intraday timeout must be tight (<=2s), got %v", opts.HTTPClient.Timeout)
	}
}

// The decoupling invariant: the intraday client must be strictly tighter than
// the shared client, so a slow heavy batch on the shared client can never be
// caused by — or impose latency on — the intraday path.
func TestIntradayClientIsTighterThanDefault(t *testing.T) {
	def := defaultAlpacaClientOpts("k", "s")
	intra := intradayAlpacaClientOpts("k", "s")
	if !(intra.HTTPClient.Timeout < def.HTTPClient.Timeout) {
		t.Errorf("intraday timeout (%v) must be < shared timeout (%v)", intra.HTTPClient.Timeout, def.HTTPClient.Timeout)
	}
}

// The shared data service must acquire a rate-limiter token before issuing a
// fetch. We prove the gate by injecting a limiter that fails: GetHistoricalBars
// must return that error and never reach the network SDK call.
func TestGetHistoricalBars_AcquiresBeforeFetch(t *testing.T) {
	sentinel := errors.New("limiter blocked")
	svc := NewAlpacaDataService("k", "s")
	svc.SetRateLimiter(&fakeLimiter{err: sentinel})

	_, err := svc.GetHistoricalBars(context.Background(), "SPY", time.Now().AddDate(0, 0, -5), time.Now(), "1Day")
	if !errors.Is(err, sentinel) {
		t.Errorf("GetHistoricalBars must short-circuit on limiter error, got %v", err)
	}
}

func TestGetMultiBars_AcquiresBeforeFetch(t *testing.T) {
	sentinel := errors.New("limiter blocked")
	svc := NewAlpacaDataService("k", "s")
	svc.SetRateLimiter(&fakeLimiter{err: sentinel})

	_, err := svc.GetMultiBars(context.Background(), []string{"SPY", "QQQ"}, time.Now().AddDate(0, 0, -5), time.Now(), "1Day")
	if !errors.Is(err, sentinel) {
		t.Errorf("GetMultiBars must short-circuit on limiter error, got %v", err)
	}
}

// Limiter is opt-in: constructors leave it nil so existing callers/tests are
// unthrottled. The intraday client must NEVER be wired to the shared limiter
// (preserves the latency isolation from commit 1ec6b6a) — main.go only calls
// SetRateLimiter on the shared service, never the intraday one.
func TestConstructors_LeaveLimiterNil(t *testing.T) {
	if NewAlpacaDataService("k", "s").limiter != nil {
		t.Error("shared service must construct with nil limiter (opt-in via SetRateLimiter)")
	}
	if NewIntradayAlpacaDataService("k", "s").limiter != nil {
		t.Error("intraday service must never carry a limiter")
	}
}
