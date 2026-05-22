package services

import (
	"fmt"
	"time"
)

// RateLimitedError is returned by Alpaca data-API fetches when the broker
// responds HTTP 429. It carries the parsed Retry-After hint (0 when the header
// is absent) so callers can both classify the failure (errors.As) and surface
// the broker's backoff guidance. The Error() string includes "HTTP 429" so the
// existing isTransientBrokerError classifier treats it as retryable.
type RateLimitedError struct {
	RetryAfter time.Duration
	Body       string
}

func (e *RateLimitedError) Error() string {
	return fmt.Sprintf("rate limited (HTTP 429), retry-after=%s: %s", e.RetryAfter, e.Body)
}
