package services

import (
	"context"

	"golang.org/x/time/rate"
)

// RateLimiter is the admission-control seam for Alpaca data-API calls. The
// production implementation is *golang.org/x/time/rate.Limiter; tests inject a
// fake. A nil RateLimiter means "no limit" (see acquire).
type RateLimiter interface {
	Wait(ctx context.Context) error
}

// NewAlpacaDataRateLimiter builds a token-bucket limiter for the shared Alpaca
// data API, sized to perMinute requests with the given burst. A non-positive
// perMinute yields an unlimited (rate.Inf) limiter so the limiter can be wired
// unconditionally and disabled by configuration.
func NewAlpacaDataRateLimiter(perMinute, burst int) *rate.Limiter {
	if perMinute <= 0 {
		return rate.NewLimiter(rate.Inf, burst)
	}
	return rate.NewLimiter(rate.Limit(float64(perMinute)/60.0), burst)
}

// acquire blocks until the limiter admits one request or ctx is done. A nil
// limiter is a no-op, so callers can hold a possibly-unset limiter without a
// branch at every call site and existing constructions stay unthrottled.
func acquire(ctx context.Context, l RateLimiter) error {
	if l == nil {
		return nil
	}
	return l.Wait(ctx)
}
