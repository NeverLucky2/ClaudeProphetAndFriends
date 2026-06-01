package services

import (
	"math"
	"testing"

	"prophet-trader/models"
)

func TestDailyReturns(t *testing.T) {
	got := dailyReturns([]float64{100, 110, 99})
	want := []float64{0.10, -0.10}
	if len(got) != len(want) {
		t.Fatalf("len: got %d, want %d", len(got), len(want))
	}
	for i := range want {
		if math.Abs(got[i]-want[i]) > 1e-9 {
			t.Errorf("returns[%d]: got %v, want %v", i, got[i], want[i])
		}
	}
	if r := dailyReturns([]float64{100}); r != nil {
		t.Errorf("single close must yield nil returns, got %v", r)
	}
	if r := dailyReturns(nil); r != nil {
		t.Errorf("nil closes must yield nil returns, got %v", r)
	}
}

func TestPearson_PerfectPositive(t *testing.T) {
	rho, ok := pearsonR([]float64{1, 2, 3, 4}, []float64{2, 4, 6, 8})
	if !ok {
		t.Fatal("expected ok=true")
	}
	if math.Abs(rho-1.0) > 1e-9 {
		t.Errorf("got %v, want +1", rho)
	}
}

func TestPearson_PerfectNegative(t *testing.T) {
	rho, ok := pearsonR([]float64{1, 2, 3, 4}, []float64{4, 3, 2, 1})
	if !ok {
		t.Fatal("expected ok=true")
	}
	if math.Abs(rho+1.0) > 1e-9 {
		t.Errorf("got %v, want -1", rho)
	}
}

func TestPearson_Orthogonal(t *testing.T) {
	rho, ok := pearsonR([]float64{1, -1, 1, -1}, []float64{1, 1, -1, -1})
	if !ok {
		t.Fatal("expected ok=true")
	}
	if math.Abs(rho) > 1e-9 {
		t.Errorf("orthogonal series: got %v, want ~0", rho)
	}
}

func TestPearson_UnusableInputs(t *testing.T) {
	if _, ok := pearsonR([]float64{1}, []float64{1}); ok {
		t.Error("n<2 must be ok=false")
	}
	if _, ok := pearsonR([]float64{1, 2, 3}, []float64{1, 2}); ok {
		t.Error("length mismatch must be ok=false")
	}
	if _, ok := pearsonR([]float64{5, 5, 5}, []float64{1, 2, 3}); ok {
		t.Error("zero variance must be ok=false")
	}
}

func TestTrailing(t *testing.T) {
	if got := trailing([]float64{1, 2, 3, 4, 5}, 3); len(got) != 3 || got[0] != 3 || got[2] != 5 {
		t.Errorf("trailing last 3: got %v", got)
	}
	if got := trailing([]float64{1, 2}, 3); got != nil {
		t.Errorf("series shorter than window must be nil, got %v", got)
	}
	if got := trailing([]float64{1, 2, 3}, 0); got != nil {
		t.Errorf("zero window must be nil, got %v", got)
	}
}

func openRow(ticker, status string) *models.DBTrendLedgerEntry {
	return &models.DBTrendLedgerEntry{Ticker: ticker, Status: status}
}

func TestClusterSlotTaken(t *testing.T) {
	// TLT, IEF, TIP are all "rates"; GLD is "metals".
	if clusterSlotTaken(nil, "rates", 1) {
		t.Error("empty book: slot must be free")
	}
	one := []*models.DBTrendLedgerEntry{openRow("TLT", "open")}
	if !clusterSlotTaken(one, "rates", 1) {
		t.Error("one open rates position at max 1 must report taken")
	}
	if clusterSlotTaken(one, "metals", 1) {
		t.Error("a different cluster must be free")
	}
	if clusterSlotTaken(one, "rates", 2) {
		t.Error("one open position with max 2 must still be free")
	}
	// Pending fills occupy a slot; closed rows free it.
	pend := []*models.DBTrendLedgerEntry{openRow("IEF", "pending_fill")}
	if !clusterSlotTaken(pend, "rates", 1) {
		t.Error("pending_fill must occupy a cluster slot")
	}
	closed := []*models.DBTrendLedgerEntry{openRow("TLT", "closed")}
	if clusterSlotTaken(closed, "rates", 1) {
		t.Error("a closed row must not occupy a cluster slot")
	}
	// Unknown candidate cluster never binds.
	if clusterSlotTaken(one, "", 1) {
		t.Error("empty candidate cluster must never report taken")
	}
}

func TestTooCorrelated(t *testing.T) {
	cand := []float64{0.01, 0.02, 0.03, 0.01}

	// Identical series → ρ=+1 > 0.7 → blocked.
	if !tooCorrelated(cand, map[string][]float64{"X": {0.01, 0.02, 0.03, 0.01}}, 0.70, 4) {
		t.Error("perfectly +correlated open must block the candidate")
	}
	// Mirrored series → ρ=-1 → allowed (diversifying).
	if tooCorrelated(cand, map[string][]float64{"X": {-0.01, -0.02, -0.03, -0.01}}, 0.70, 4) {
		t.Error("anti-correlated open must NOT block (negative ρ is diversifying)")
	}
	// Empty book → allowed.
	if tooCorrelated(cand, map[string][]float64{}, 0.70, 4) {
		t.Error("no open positions must not block")
	}
	// Candidate has fewer returns than window → cannot assess → allowed.
	if tooCorrelated([]float64{0.01, 0.02}, map[string][]float64{"X": {0.01, 0.02, 0.03, 0.01}}, 0.70, 4) {
		t.Error("candidate shorter than window must not block (cannot assess)")
	}
	// One unassessable open (too short) + one highly correlated → blocked.
	book := map[string][]float64{
		"SHORT": {0.01, 0.02},
		"HOT":   {0.01, 0.02, 0.03, 0.01},
	}
	if !tooCorrelated(cand, book, 0.70, 4) {
		t.Error("a single +correlated open among others must block")
	}
}
