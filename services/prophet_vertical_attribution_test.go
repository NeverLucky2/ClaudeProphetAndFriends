package services

import "testing"

func TestBsPrice_ATMCallKnownValue(t *testing.T) {
	got := bsPrice("call", 100, 100, 1, 0.20, 0)
	if !almostEqual(got, 7.9656, 1e-3) {
		t.Fatalf("ATM call = %v, want ~7.9656", got)
	}
}

func TestBsPrice_PutCallParityATM(t *testing.T) {
	c := bsPrice("call", 100, 100, 1, 0.20, 0)
	p := bsPrice("put", 100, 100, 1, 0.20, 0)
	if !almostEqual(c, p, 1e-9) {
		t.Fatalf("ATM call %v != put %v at r=0", c, p)
	}
}

func TestBsPrice_DegenerateReturnsIntrinsic(t *testing.T) {
	if got := bsPrice("call", 110, 100, 0, 0.20, 0); !almostEqual(got, 10, 1e-9) {
		t.Fatalf("expired ITM call intrinsic = %v, want 10", got)
	}
	if got := bsPrice("put", 90, 100, -1, 0.20, 0); !almostEqual(got, 10, 1e-9) {
		t.Fatalf("expired ITM put intrinsic = %v, want 10", got)
	}
	if got := bsPrice("call", 90, 100, 1, 0, 0); !almostEqual(got, 0, 1e-9) {
		t.Fatalf("zero-vol OTM call = %v, want 0", got)
	}
}

func TestVerticalValuePerShare_CallDebitPositive(t *testing.T) {
	snap := VerticalSnapshot{Spot: 250, LongVol: 0.30, ShortVol: 0.30, TimeToExpiry: 30.0 / 365}
	v := verticalValuePerShare(CallDebit, 240, 260, snap)
	if v <= 0 {
		t.Fatalf("call-debit spread value should be positive, got %v", v)
	}
	if v >= 20 {
		t.Fatalf("spread value %v must be below width 20", v)
	}
}

func TestAttribute_PureIVCrush_BooksToIV(t *testing.T) {
	long, short := 240.0, 260.0
	entry := VerticalSnapshot{Spot: 250, LongVol: 0.50, ShortVol: 0.50, TimeToExpiry: 30.0 / 365}
	exit := VerticalSnapshot{Spot: 250, LongVol: 0.25, ShortVol: 0.25, TimeToExpiry: 30.0 / 365}
	v0 := verticalValuePerShare(CallDebit, long, short, entry)
	v1 := verticalValuePerShare(CallDebit, long, short, exit)
	realized := (v1 - v0) * 100
	a := attributeVerticalPnl(CallDebit, long, short, entry, exit, realized, 1)
	if !almostEqual(a.Theta, 0, 1e-6) {
		t.Fatalf("theta should be ~0 (time unchanged), got %v", a.Theta)
	}
	if !almostEqual(a.Direction, 0, 1e-6) {
		t.Fatalf("direction should be ~0 (spot unchanged), got %v", a.Direction)
	}
	if almostEqual(a.IV, 0, 1e-6) {
		t.Fatalf("IV component should be non-zero (vol moved), got %v", a.IV)
	}
	if !almostEqual(a.Residual, 0, 1e-6) {
		t.Fatalf("residual should reconcile to ~0, got %v", a.Residual)
	}
}

func TestAttribute_PureDirection_BooksToDirection(t *testing.T) {
	long, short := 240.0, 260.0
	entry := VerticalSnapshot{Spot: 250, LongVol: 0.30, ShortVol: 0.30, TimeToExpiry: 30.0 / 365}
	exit := VerticalSnapshot{Spot: 256, LongVol: 0.30, ShortVol: 0.30, TimeToExpiry: 30.0 / 365}
	v0 := verticalValuePerShare(CallDebit, long, short, entry)
	v1 := verticalValuePerShare(CallDebit, long, short, exit)
	realized := (v1 - v0) * 100
	a := attributeVerticalPnl(CallDebit, long, short, entry, exit, realized, 1)
	if !almostEqual(a.Theta, 0, 1e-6) || !almostEqual(a.IV, 0, 1e-6) {
		t.Fatalf("theta/IV should be ~0, got theta=%v iv=%v", a.Theta, a.IV)
	}
	if a.Direction <= 0 {
		t.Fatalf("upward spot move on a call-debit should book positive direction, got %v", a.Direction)
	}
}

func TestAttribute_ResidualReconciles(t *testing.T) {
	long, short := 240.0, 260.0
	entry := VerticalSnapshot{Spot: 250, LongVol: 0.40, ShortVol: 0.40, TimeToExpiry: 30.0 / 365}
	exit := VerticalSnapshot{Spot: 244, LongVol: 0.55, ShortVol: 0.55, TimeToExpiry: 10.0 / 365}
	a := attributeVerticalPnl(CallDebit, long, short, entry, exit, -123.45, 1)
	sum := a.Direction + a.Theta + a.IV + a.Residual
	if !almostEqual(sum, -123.45, 1e-6) {
		t.Fatalf("components must sum to realized -123.45, got %v", sum)
	}
}
