package services

import (
	"context"
	"errors"
	"prophet-trader/interfaces"
	"strings"
	"testing"

	"github.com/sirupsen/logrus"
)

// helper: a PM with one terminal record for `sym` and a stub broker holding it.
func newAutoFlattenPM(t *testing.T, sym string, qty float64, cfg OrphanAutoFlattenConfig) (*PositionManager, *reconcileStubTrading) {
	t.Helper()
	trading := &reconcileStubTrading{
		stubTrading: &stubTrading{},
		positions:   []*interfaces.Position{{Symbol: sym, Qty: qty, Side: "long"}},
	}
	pm := &PositionManager{
		tradingService: trading,
		positions:      map[string]*ManagedPosition{"p1": {ID: "p1", Symbol: sym, Status: "CLOSED"}},
		orphanAlerted:  map[string]bool{},
		orphanStreak:   map[string]int{},
		flattenLatched: map[string]bool{},
		logger:         logrus.New(),
	}
	pm.SetOrphanAutoFlatten(cfg)
	return pm, trading
}

func openCfg() OrphanAutoFlattenConfig {
	return OrphanAutoFlattenConfig{Enabled: true, AccountIsDedicated: true, Streak: 3, MarketIsOpen: func() bool { return true }}
}

// Fires at 3, not before.
func TestAutoFlatten_FiresAtStreakThreshold(t *testing.T) {
	pm, trading := newAutoFlattenPM(t, "UNH", 13, openCfg())
	bp := trading.positions
	pm.autoFlattenOrphans(context.Background(), bp) // streak 1
	pm.autoFlattenOrphans(context.Background(), bp) // streak 2
	if len(trading.closeCalls) != 0 {
		t.Fatalf("must not fire before streak 3, got %d calls", len(trading.closeCalls))
	}
	pm.autoFlattenOrphans(context.Background(), bp) // streak 3 → fire
	if len(trading.closeCalls) != 1 || trading.closeCalls[0].symbol != "UNH" || trading.closeCalls[0].qty != 13 {
		t.Fatalf("expected 1 ClosePosition(UNH,13), got %+v", trading.closeCalls)
	}
}

// One attempt then latch: no second submit even if the orphan persists.
func TestAutoFlatten_OneAttemptThenLatch(t *testing.T) {
	pm, trading := newAutoFlattenPM(t, "UNH", 13, openCfg())
	bp := trading.positions
	for i := 0; i < 6; i++ {
		pm.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 1 {
		t.Fatalf("expected exactly 1 ClosePosition across many passes, got %d", len(trading.closeCalls))
	}
}

// Failure latches too — never retried.
func TestAutoFlatten_FailureLatches(t *testing.T) {
	pm, trading := newAutoFlattenPM(t, "UNH", 13, openCfg())
	trading.closeErr = errors.New("rejected")
	bp := trading.positions
	for i := 0; i < 6; i++ {
		pm.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 1 {
		t.Fatalf("a failed flatten must not be retried, got %d calls", len(trading.closeCalls))
	}
}

// Both gates required: not affirmed dedicated → never fires.
func TestAutoFlatten_NotDedicated_NeverFires(t *testing.T) {
	cfg := openCfg()
	cfg.AccountIsDedicated = false
	pm, trading := newAutoFlattenPM(t, "UNH", 13, cfg)
	bp := trading.positions
	for i := 0; i < 5; i++ {
		pm.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 0 {
		t.Fatalf("un-affirmed account must never flatten, got %d", len(trading.closeCalls))
	}
}

func TestAutoFlatten_Disabled_NeverFires(t *testing.T) {
	cfg := openCfg()
	cfg.Enabled = false
	pm, trading := newAutoFlattenPM(t, "UNH", 13, cfg)
	bp := trading.positions
	for i := 0; i < 5; i++ {
		pm.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 0 {
		t.Fatalf("disabled must never flatten, got %d", len(trading.closeCalls))
	}
}

// Market closed → never fires; streak preserved so it fires once open.
func TestAutoFlatten_MarketClosed_HoldsThenFires(t *testing.T) {
	cfg := openCfg()
	open := false
	cfg.MarketIsOpen = func() bool { return open }
	pm, trading := newAutoFlattenPM(t, "UNH", 13, cfg)
	bp := trading.positions
	for i := 0; i < 5; i++ {
		pm.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 0 {
		t.Fatalf("closed market must not flatten, got %d", len(trading.closeCalls))
	}
	open = true
	pm.autoFlattenOrphans(context.Background(), bp)
	if len(trading.closeCalls) != 1 {
		t.Fatalf("must fire once the market opens, got %d", len(trading.closeCalls))
	}
}

// Long-only: a short orphan (qty<0) is never flattened.
func TestAutoFlatten_ShortOrphan_NeverFlattened(t *testing.T) {
	pm, trading := newAutoFlattenPM(t, "UNH", -13, openCfg())
	bp := trading.positions
	for i := 0; i < 5; i++ {
		pm.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 0 {
		t.Fatalf("a short orphan must never be auto-covered, got %d", len(trading.closeCalls))
	}
}

// Catastrophic guard: a live (non-terminal) record means it is NOT an orphan.
func TestAutoFlatten_LiveRecord_NeverFlattened(t *testing.T) {
	pm, trading := newAutoFlattenPM(t, "UNH", 13, openCfg())
	pm.positions["p2"] = &ManagedPosition{ID: "p2", Symbol: "UNH", Status: "ACTIVE"}
	bp := trading.positions
	for i := 0; i < 5; i++ {
		pm.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 0 {
		t.Fatalf("a symbol with a live record is not an orphan; must never flatten, got %d", len(trading.closeCalls))
	}
}

// Success appends an audit note to the terminal record.
func TestAutoFlatten_SuccessAppendsAuditNote(t *testing.T) {
	pm, trading := newAutoFlattenPM(t, "UNH", 13, openCfg())
	bp := trading.positions
	for i := 0; i < 3; i++ {
		pm.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 1 {
		t.Fatalf("expected 1 flatten, got %d", len(trading.closeCalls))
	}
	if note := pm.positions["p1"].Notes; !strings.Contains(note, "orphan_autoflattened") {
		t.Fatalf("expected audit note on terminal record, got %q", note)
	}
}

// raceInjectingTrading wraps reconcileStubTrading and, on the FIRST call to
// GetPositions (the pre-sell fresh re-read inside autoFlattenOrphans, called
// strictly after the pass's under-lock orphan selection/toFire has already been
// built), injects a live managed record for a symbol. This simulates a same-symbol
// re-entry landing exactly in the window the spec's step-4c re-confirm exists to
// catch: after selection, before the sell.
type raceInjectingTrading struct {
	*reconcileStubTrading
	pm       *PositionManager
	symbol   string
	injected bool
}

func (r *raceInjectingTrading) GetPositions(ctx context.Context) ([]*interfaces.Position, error) {
	positions, err := r.reconcileStubTrading.GetPositions(ctx)
	if !r.injected {
		r.injected = true
		r.pm.mu.Lock()
		r.pm.positions["p2"] = &ManagedPosition{ID: "p2", Symbol: r.symbol, Status: "ACTIVE"}
		r.pm.mu.Unlock()
	}
	return positions, err
}

// Pre-sell re-confirm (spec 4c): a live (non-terminal) managed record appears for
// the symbol in the window strictly between the pass's orphan selection and the
// fresh broker re-read used to confirm before selling. findOrphans excludes any
// symbol with a non-terminal record, so on fresh state this symbol is no longer an
// orphan at all — it must never be sold, even though the broker still shows shares
// held and the selection pass had already picked it as a firing target.
func TestAutoFlatten_LiveRecordAppearsBeforeSell_NeverFlattened(t *testing.T) {
	pm, trading := newAutoFlattenPM(t, "UNH", 13, openCfg())
	race := &raceInjectingTrading{reconcileStubTrading: trading, pm: pm, symbol: "UNH"}
	pm.tradingService = race
	bp := trading.positions
	pm.autoFlattenOrphans(context.Background(), bp) // streak 1
	pm.autoFlattenOrphans(context.Background(), bp) // streak 2
	// streak 3: selection (top of function) still sees UNH as an orphan (no live
	// record yet) and builds toFire; then the fresh GetPositions re-read fires the
	// injection, landing the live record before the re-confirm evaluates it.
	pm.autoFlattenOrphans(context.Background(), bp)
	if len(trading.closeCalls) != 0 {
		t.Fatalf("a symbol that went live during the fresh re-read window must never be sold, got %+v", trading.closeCalls)
	}
}

// Pre-sell re-confirm (spec 4c), qty cap: the orphan was 13 sh at selection; by the
// fresh re-read the broker shows 20 sh (e.g. a re-entry added 7) but NO live record
// exists yet, so it is still a confirmed orphan — just at a larger qty. The sold
// qty must be capped at the selection qty (min(13,20)=13), never the grown total,
// so a concurrent re-entry's added shares can never be swept.
func TestAutoFlatten_QtyGrownBeforeSell_SellsSelectionQtyNotFreshQty(t *testing.T) {
	pm, trading := newAutoFlattenPM(t, "UNH", 13, openCfg())
	bp := trading.positions
	pm.autoFlattenOrphans(context.Background(), bp) // streak 1
	pm.autoFlattenOrphans(context.Background(), bp) // streak 2
	// Grow the broker qty before the firing pass's fresh re-read; no live record.
	// Reassign (not mutate-in-place) so the already-captured `bp` slice — which is
	// what the firing pass's detection/selection uses — keeps seeing the original
	// 13, while GetPositions() (reading the field fresh) sees the grown 20.
	trading.positions = []*interfaces.Position{{Symbol: "UNH", Qty: 20, Side: "long"}}
	pm.autoFlattenOrphans(context.Background(), bp) // streak 3 → fire, capped at selection qty
	if len(trading.closeCalls) != 1 || trading.closeCalls[0].symbol != "UNH" || trading.closeCalls[0].qty != 13 {
		t.Fatalf("expected 1 ClosePosition(UNH,13) capped at selection qty, got %+v", trading.closeCalls)
	}
}

// Restart behavior (deliberate, per spec): in-memory streak/latch reset on a new
// process, so a still-present orphan re-accrues and re-fires. Pins that this is
// intended, not accidental.
func TestAutoFlatten_RestartReAttempts(t *testing.T) {
	pm1, trading := newAutoFlattenPM(t, "UNH", 13, openCfg())
	bp := trading.positions
	trading.closeErr = errors.New("rejected") // first process: flatten fails, latches
	for i := 0; i < 4; i++ {
		pm1.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 1 {
		t.Fatalf("first process: expected 1 attempt, got %d", len(trading.closeCalls))
	}
	// Simulate a restart: a fresh PM over the SAME stub broker (orphan still held).
	trading.closeErr = nil
	pm2 := &PositionManager{
		tradingService: trading,
		positions:      map[string]*ManagedPosition{"p1": {ID: "p1", Symbol: "UNH", Status: "CLOSED"}},
		orphanAlerted:  map[string]bool{},
		orphanStreak:   map[string]int{},
		flattenLatched: map[string]bool{},
		logger:         logrus.New(),
	}
	pm2.SetOrphanAutoFlatten(openCfg())
	for i := 0; i < 3; i++ {
		pm2.autoFlattenOrphans(context.Background(), bp)
	}
	if len(trading.closeCalls) != 2 {
		t.Fatalf("after restart the still-present orphan must re-fire (total 2 calls), got %d", len(trading.closeCalls))
	}
}
