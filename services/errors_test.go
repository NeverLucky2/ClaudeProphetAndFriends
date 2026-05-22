package services

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestRateLimitedError_MessageContainsHTTP429(t *testing.T) {
	// The message must contain "HTTP 429" so isTransientBrokerError classifies
	// it as transient (the retry loop relies on this).
	e := &RateLimitedError{RetryAfter: 2 * time.Second, Body: "too many requests"}
	if !isTransientBrokerError(e) {
		t.Errorf("RateLimitedError must be transient, message was %q", e.Error())
	}
}

func TestRateLimitedError_ExtractableViaErrorsAs(t *testing.T) {
	wrapped := fmt.Errorf("options chain fetch: %w", &RateLimitedError{RetryAfter: 3 * time.Second})
	var rle *RateLimitedError
	if !errors.As(wrapped, &rle) {
		t.Fatal("RateLimitedError must be recoverable from a wrapped error via errors.As")
	}
	if rle.RetryAfter != 3*time.Second {
		t.Errorf("RetryAfter: got %v, want 3s", rle.RetryAfter)
	}
}
