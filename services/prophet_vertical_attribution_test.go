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
