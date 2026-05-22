package services

import (
	"testing"
	"time"
)

// The Alpaca marketdata SDK defaults are dangerous for a latency-sensitive
// caller: RetryLimit=10, RetryDelay=1s, and a 10s per-request HTTP timeout
// (see marketdata/rest.go). A single rate-limited GetBars can block for ~60s.
// boundedAlpacaClientOpts must clamp all three so the worst case stays small.
func TestBoundedAlpacaClientOpts_ClampsRetryAndTimeout(t *testing.T) {
	opts := boundedAlpacaClientOpts("key", "secret")

	if opts.APIKey != "key" {
		t.Errorf("APIKey not passed through: got %q", opts.APIKey)
	}
	if opts.APISecret != "secret" {
		t.Errorf("APISecret not passed through: got %q", opts.APISecret)
	}
	if opts.RetryLimit <= 0 || opts.RetryLimit > 3 {
		t.Errorf("RetryLimit must be clamped to a small positive value, got %d", opts.RetryLimit)
	}
	if opts.RetryDelay <= 0 || opts.RetryDelay > 500*time.Millisecond {
		t.Errorf("RetryDelay must be clamped to <=500ms, got %v", opts.RetryDelay)
	}
	if opts.HTTPClient == nil {
		t.Fatal("HTTPClient must be set so the per-request timeout is bounded (SDK default is 10s)")
	}
	if opts.HTTPClient.Timeout <= 0 || opts.HTTPClient.Timeout > 3*time.Second {
		t.Errorf("HTTPClient.Timeout must be clamped to <=3s, got %v", opts.HTTPClient.Timeout)
	}
}
