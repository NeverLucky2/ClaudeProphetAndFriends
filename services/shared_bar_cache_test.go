package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"prophet-trader/interfaces"
)

// fakeCacheSource is a call-counting MarketDataProvider for the cache tests.
type fakeCacheSource struct {
	histCalls  int
	multiCalls int
	bars       map[string][]*interfaces.Bar
	multiErr   error
	histErr    error
}

func (f *fakeCacheSource) GetHistoricalBars(_ context.Context, symbol string, _, _ time.Time, _ string) ([]*interfaces.Bar, error) {
	f.histCalls++
	if f.histErr != nil {
		return nil, f.histErr
	}
	return f.bars[symbol], nil
}

func (f *fakeCacheSource) GetMultiBars(_ context.Context, symbols []string, _, _ time.Time, _ string) (map[string][]*interfaces.Bar, error) {
	f.multiCalls++
	if f.multiErr != nil {
		return nil, f.multiErr
	}
	out := make(map[string][]*interfaces.Bar, len(symbols))
	for _, s := range symbols {
		if b, ok := f.bars[s]; ok {
			out[s] = b
		}
	}
	return out, nil
}

func (f *fakeCacheSource) GetLatestBar(_ context.Context, symbol string) (*interfaces.Bar, error) {
	return &interfaces.Bar{Symbol: symbol, Close: 1}, nil
}
func (f *fakeCacheSource) GetLatestQuote(_ context.Context, symbol string) (*interfaces.Quote, error) {
	return &interfaces.Quote{Symbol: symbol, BidPrice: 1}, nil
}
func (f *fakeCacheSource) GetLatestTrade(_ context.Context, symbol string) (*interfaces.Trade, error) {
	return &interfaces.Trade{Symbol: symbol, Price: 1}, nil
}
func (f *fakeCacheSource) StreamBars(_ context.Context, _ []string) (<-chan *interfaces.Bar, error) {
	ch := make(chan *interfaces.Bar)
	close(ch)
	return ch, nil
}

// newTestCache builds a SharedBarCache over a fake, in a temp dir, with a fixed clock.
func newTestCache(t *testing.T, src *fakeCacheSource, now time.Time) *SharedBarCache {
	t.Helper()
	c := NewSharedBarCache(src, t.TempDir(), 5*time.Minute, nil)
	c.clock = func() time.Time { return now }
	return c
}

func TestSharedBarCache_SatisfiesInterfaces(t *testing.T) {
	var _ interfaces.DataService = (*SharedBarCache)(nil)
	var _ MarketDataProvider = (*SharedBarCache)(nil)
}

func TestSharedBarCache_ForwardsLatest(t *testing.T) {
	src := &fakeCacheSource{}
	c := newTestCache(t, src, time.Now())
	if q, err := c.GetLatestQuote(context.Background(), "SPY"); err != nil || q == nil || q.Symbol != "SPY" {
		t.Fatalf("GetLatestQuote should forward, got %+v err=%v", q, err)
	}
	if b, err := c.GetLatestBar(context.Background(), "SPY"); err != nil || b == nil {
		t.Fatalf("GetLatestBar should forward, got %+v err=%v", b, err)
	}
}

func TestSharedBarCache_UpstreamErrorPropagated(t *testing.T) {
	src := &fakeCacheSource{histErr: errors.New("alpaca 429")}
	c := newTestCache(t, src, time.Now())
	_, err := c.GetHistoricalBars(context.Background(), "SPY", time.Now().AddDate(0, 0, -1), time.Now(), "1Day")
	if err == nil {
		t.Error("upstream error must propagate, got nil")
	}
	if files, _ := os.ReadDir(c.dir); len(files) != 0 {
		t.Error("error result must not be cached")
	}
}

func barsFor(sym string, n int) []*interfaces.Bar {
	out := make([]*interfaces.Bar, n)
	for i := range out {
		out[i] = &interfaces.Bar{Symbol: sym, Close: float64(i + 1)}
	}
	return out
}

func TestSharedBarCache_HistoricalHit(t *testing.T) {
	src := &fakeCacheSource{bars: map[string][]*interfaces.Bar{"SPY": barsFor("SPY", 3)}}
	now := time.Date(2026, 5, 22, 14, 0, 0, 0, time.UTC)
	c := newTestCache(t, src, now)

	start := now.AddDate(0, 0, -30)
	for i := 0; i < 2; i++ {
		got, err := c.GetHistoricalBars(context.Background(), "SPY", start, now, "1Day")
		if err != nil || len(got) != 3 {
			t.Fatalf("call %d: got %d bars err=%v", i, len(got), err)
		}
	}
	if src.histCalls != 1 {
		t.Errorf("second identical call must hit cache: underlying called %d times, want 1", src.histCalls)
	}
}

func TestSharedBarCache_HistoricalTTLExpiry(t *testing.T) {
	src := &fakeCacheSource{bars: map[string][]*interfaces.Bar{"SPY": barsFor("SPY", 3)}}
	now := time.Date(2026, 5, 22, 14, 0, 0, 0, time.UTC)
	c := newTestCache(t, src, now)
	start := now.AddDate(0, 0, -30)

	_, _ = c.GetHistoricalBars(context.Background(), "SPY", start, now, "1Day")
	c.clock = func() time.Time { return now.Add(6 * time.Minute) } // past 5m ttl
	_, _ = c.GetHistoricalBars(context.Background(), "SPY", start, now, "1Day")

	if src.histCalls != 2 {
		t.Errorf("expired entry must refetch: underlying called %d times, want 2", src.histCalls)
	}
}

func TestSharedBarCache_SubDailyBypass(t *testing.T) {
	src := &fakeCacheSource{bars: map[string][]*interfaces.Bar{"SPY": barsFor("SPY", 3)}}
	now := time.Now()
	c := newTestCache(t, src, now)
	start := now.Add(-2 * time.Hour)

	_, _ = c.GetHistoricalBars(context.Background(), "SPY", start, now, "5Min")
	_, _ = c.GetHistoricalBars(context.Background(), "SPY", start, now, "5Min")

	if src.histCalls != 2 {
		t.Errorf("sub-daily must bypass cache: underlying called %d times, want 2", src.histCalls)
	}
	if files, _ := os.ReadDir(c.dir); len(files) != 0 {
		t.Errorf("sub-daily must not write cache files, found %d", len(files))
	}
}

func TestSharedBarCache_DateNormalization(t *testing.T) {
	src := &fakeCacheSource{bars: map[string][]*interfaces.Bar{"SPY": barsFor("SPY", 3)}}
	now := time.Date(2026, 5, 22, 14, 0, 0, 5, time.UTC)
	c := newTestCache(t, src, now)
	start := now.AddDate(0, 0, -30)

	_, _ = c.GetHistoricalBars(context.Background(), "SPY", start, now, "1Day")
	end2 := now.Add(4 * time.Minute)
	c.clock = func() time.Time { return end2 }
	_, _ = c.GetHistoricalBars(context.Background(), "SPY", start.Add(time.Second), end2, "1Day")

	if src.histCalls != 1 {
		t.Errorf("same ET-date window must map to one key: underlying called %d times, want 1", src.histCalls)
	}
}

func TestSharedBarCache_CorruptFileSoftFails(t *testing.T) {
	src := &fakeCacheSource{bars: map[string][]*interfaces.Bar{"SPY": barsFor("SPY", 3)}}
	now := time.Date(2026, 5, 22, 14, 0, 0, 0, time.UTC)
	c := newTestCache(t, src, now)
	start := now.AddDate(0, 0, -30)

	_, _ = c.GetHistoricalBars(context.Background(), "SPY", start, now, "1Day")
	files, _ := os.ReadDir(c.dir)
	if len(files) != 1 {
		t.Fatalf("expected 1 cache file, got %d", len(files))
	}
	if err := os.WriteFile(filepath.Join(c.dir, files[0].Name()), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := c.GetHistoricalBars(context.Background(), "SPY", start, now, "1Day")
	if err != nil || len(got) != 3 {
		t.Fatalf("corrupt file must soft-fail to a fetch: got %d bars err=%v", len(got), err)
	}
	if src.histCalls != 2 {
		t.Errorf("corrupt file must trigger a refetch: underlying called %d times, want 2", src.histCalls)
	}
}

func TestSharedBarCache_EmptyResultNotCached(t *testing.T) {
	src := &fakeCacheSource{bars: map[string][]*interfaces.Bar{}} // "ZZZZ" returns nil bars
	now := time.Date(2026, 5, 22, 14, 0, 0, 0, time.UTC)
	c := newTestCache(t, src, now)
	start := now.AddDate(0, 0, -30)

	_, _ = c.GetHistoricalBars(context.Background(), "ZZZZ", start, now, "1Day")
	_, _ = c.GetHistoricalBars(context.Background(), "ZZZZ", start, now, "1Day")
	if src.histCalls != 2 {
		t.Errorf("empty result must not be cached: underlying called %d times, want 2", src.histCalls)
	}
}

func TestSharedBarCache_MultiPartialHit(t *testing.T) {
	src := &fakeCacheSource{bars: map[string][]*interfaces.Bar{
		"AAA": barsFor("AAA", 2), "BBB": barsFor("BBB", 2), "CCC": barsFor("CCC", 2),
	}}
	now := time.Date(2026, 5, 22, 14, 0, 0, 0, time.UTC)
	c := newTestCache(t, src, now)
	start := now.AddDate(0, 0, -30)

	// Prime AAA and BBB via single-symbol fetches.
	_, _ = c.GetHistoricalBars(context.Background(), "AAA", start, now, "1Day")
	_, _ = c.GetHistoricalBars(context.Background(), "BBB", start, now, "1Day")
	if src.histCalls != 2 {
		t.Fatalf("setup: histCalls=%d want 2", src.histCalls)
	}

	out, err := c.GetMultiBars(context.Background(), []string{"AAA", "BBB", "CCC"}, start, now, "1Day")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 3 || len(out["AAA"]) != 2 || len(out["CCC"]) != 2 {
		t.Fatalf("merged result wrong: %v", out)
	}
	if src.multiCalls != 1 {
		t.Errorf("must batch-fetch the misses exactly once, got %d", src.multiCalls)
	}

	// CCC is now cached too: a second multi-call needs zero upstream calls.
	src.multiCalls = 0
	_, _ = c.GetMultiBars(context.Background(), []string{"AAA", "BBB", "CCC"}, start, now, "1Day")
	if src.multiCalls != 0 {
		t.Errorf("fully-warm multi-call must issue no upstream call, got %d", src.multiCalls)
	}
}

func TestSharedBarCache_MultiSubDailyBypass(t *testing.T) {
	src := &fakeCacheSource{bars: map[string][]*interfaces.Bar{"AAA": barsFor("AAA", 2)}}
	now := time.Now()
	c := newTestCache(t, src, now)
	_, _ = c.GetMultiBars(context.Background(), []string{"AAA"}, now.Add(-2*time.Hour), now, "5Min")
	_, _ = c.GetMultiBars(context.Background(), []string{"AAA"}, now.Add(-2*time.Hour), now, "5Min")
	if src.multiCalls != 2 {
		t.Errorf("sub-daily multi must bypass cache, got %d want 2", src.multiCalls)
	}
}

func TestSharedBarCache_RenameFailureSoftFails(t *testing.T) {
	src := &fakeCacheSource{bars: map[string][]*interfaces.Bar{"SPY": barsFor("SPY", 3)}}
	now := time.Date(2026, 5, 22, 14, 0, 0, 0, time.UTC)
	// Point the cache at a path that is a FILE, not a dir, so os.CreateTemp in
	// the "dir" fails on every write — exercising the write/rename soft-fail path.
	badDir := filepath.Join(t.TempDir(), "iam-a-file")
	if err := os.WriteFile(badDir, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	c := NewSharedBarCache(src, badDir, 5*time.Minute, nil)
	c.clock = func() time.Time { return now }

	start := now.AddDate(0, 0, -30)
	got, err := c.GetHistoricalBars(context.Background(), "SPY", start, now, "1Day")
	if err != nil || len(got) != 3 {
		t.Fatalf("write failure must soft-fail and still return bars: got %d err=%v", len(got), err)
	}
}
