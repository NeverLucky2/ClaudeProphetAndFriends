package services

import (
	"strings"
	"testing"
)

func TestAssessVerticalCheapness_SkewDiff_IsShortMinusLong(t *testing.T) {
	// Normal call skew: long (lower strike) richer than short (higher strike).
	c := assessVerticalCheapness(CallDebit, 0.30, 0.25, 0.28)
	if !almostEqual(c.SkewDiff, -0.05, 1e-9) {
		t.Fatalf("SkewDiff = %v, want -0.05", c.SkewDiff)
	}
	// Normal put skew: short (lower strike) richer than long (higher strike).
	p := assessVerticalCheapness(PutDebit, 0.30, 0.36, 0.30)
	if !almostEqual(p.SkewDiff, 0.06, 1e-9) {
		t.Fatalf("SkewDiff = %v, want 0.06", p.SkewDiff)
	}
}

func TestAssessVerticalCheapness_IVtoRV_WhenRealizedVolKnown(t *testing.T) {
	c := assessVerticalCheapness(CallDebit, 0.30, 0.30, 0.25)
	if !c.HasIVtoRV {
		t.Fatal("HasIVtoRV = false, want true when realizedVol > 0 and longIV > 0")
	}
	if !almostEqual(c.IVtoRV, 1.2, 1e-9) { // 0.30 / 0.25
		t.Fatalf("IVtoRV = %v, want 1.2", c.IVtoRV)
	}
}

func TestAssessVerticalCheapness_NoRealizedVol_NoRatio(t *testing.T) {
	c := assessVerticalCheapness(CallDebit, 0.28, 0.30, 0)
	if c.HasIVtoRV {
		t.Fatal("HasIVtoRV = true, want false when realizedVol <= 0")
	}
	if c.IVtoRV != 0 {
		t.Fatalf("IVtoRV = %v, want 0 when ratio unavailable", c.IVtoRV)
	}
}

func TestAssessVerticalCheapness_NonPositiveLongIV_NoRatio(t *testing.T) {
	// realizedVol is known but longIV <= 0, so the ratio is meaningless.
	c := assessVerticalCheapness(CallDebit, 0, 0.30, 0.28)
	if c.HasIVtoRV {
		t.Fatal("HasIVtoRV = true, want false when longIV <= 0")
	}
	if c.IVtoRV != 0 {
		t.Fatalf("IVtoRV = %v, want 0", c.IVtoRV)
	}
}

func TestAssessVerticalCheapness_CallDebit_NormalSkew_Rich(t *testing.T) {
	// Steep normal call skew (short far cheaper than long) — rich even though
	// IV<=RV, because structural skew dominates.
	c := assessVerticalCheapness(CallDebit, 0.30, 0.25, 0.28)
	if !strings.HasPrefix(c.Label, "rich") {
		t.Fatalf("Label = %q, want rich prefix", c.Label)
	}
	if !strings.Contains(c.Label, "steep skew") {
		t.Fatalf("Label = %q, want 'steep skew' reason", c.Label)
	}
}

func TestAssessVerticalCheapness_CallDebit_FlatSkew_IVleRV_Cheap(t *testing.T) {
	// Flat skew + IV below RV → cheap.
	c := assessVerticalCheapness(CallDebit, 0.28, 0.28, 0.30)
	if !strings.HasPrefix(c.Label, "cheap") {
		t.Fatalf("Label = %q, want cheap prefix", c.Label)
	}
	if !strings.Contains(c.Label, "IV<=RV") {
		t.Fatalf("Label = %q, want 'IV<=RV' reason", c.Label)
	}
}

func TestAssessVerticalCheapness_PutDebit_NormalSkew_Cheap(t *testing.T) {
	// Normal put skew makes the sold (lower-strike) leg richer → favorable.
	c := assessVerticalCheapness(PutDebit, 0.30, 0.36, 0.30)
	if !strings.HasPrefix(c.Label, "cheap") {
		t.Fatalf("Label = %q, want cheap prefix", c.Label)
	}
	if !strings.Contains(c.Label, "put_debit") {
		t.Fatalf("Label = %q, want direction in label", c.Label)
	}
}

func TestAssessVerticalCheapness_NoRV_SkewOnlyLabel(t *testing.T) {
	// Favorable skew, no realized vol → skew-only cheap.
	good := assessVerticalCheapness(CallDebit, 0.28, 0.30, 0)
	if !strings.HasPrefix(good.Label, "cheap") || !strings.Contains(good.Label, "no RV") {
		t.Fatalf("Label = %q, want cheap + 'no RV'", good.Label)
	}
	// Steep skew, no realized vol → still rich (skew alone condemns it).
	bad := assessVerticalCheapness(CallDebit, 0.30, 0.25, 0)
	if !strings.HasPrefix(bad.Label, "rich") {
		t.Fatalf("Label = %q, want rich prefix", bad.Label)
	}
}

func TestAssessVerticalCheapness_IVmuchGreaterThanRV_RichDespiteFlatSkew(t *testing.T) {
	// Flat skew, but long IV far above RV → overpaying → rich.
	c := assessVerticalCheapness(CallDebit, 0.40, 0.40, 0.25) // IVtoRV = 1.6
	if !strings.HasPrefix(c.Label, "rich") {
		t.Fatalf("Label = %q, want rich prefix", c.Label)
	}
	if !strings.Contains(c.Label, "IV>>RV") {
		t.Fatalf("Label = %q, want 'IV>>RV' reason", c.Label)
	}
	if !almostEqual(c.IVtoRV, 1.6, 1e-9) {
		t.Fatalf("IVtoRV = %v, want 1.6", c.IVtoRV)
	}
}

func TestAssessVerticalCheapness_FavorableSkew_NeutralVRP_Fair(t *testing.T) {
	// Flat skew, IVtoRV between cheap and rich cutoffs → fair.
	c := assessVerticalCheapness(CallDebit, 0.33, 0.33, 0.28) // IVtoRV ~= 1.179
	if !strings.HasPrefix(c.Label, "fair") {
		t.Fatalf("Label = %q, want fair prefix", c.Label)
	}
}

func TestAssessVerticalCheapness_Boundaries(t *testing.T) {
	// Skew flat-band: just inside (-0.009) favorable, just outside (-0.011) steep.
	// Margins are ~1e-3, far above float64 noise, so the boundary is exercised
	// without exact-equality fragility.
	inside := assessVerticalCheapness(CallDebit, 0.30, 0.291, 0) // SkewDiff -0.009
	if !strings.HasPrefix(inside.Label, "cheap") {
		t.Fatalf("inside flat band: Label = %q, want cheap", inside.Label)
	}
	outside := assessVerticalCheapness(CallDebit, 0.30, 0.289, 0) // SkewDiff -0.011
	if !strings.HasPrefix(outside.Label, "rich") {
		t.Fatalf("outside flat band: Label = %q, want rich", outside.Label)
	}

	// VRP cutoffs (flat skew so the VRP branch decides):
	cheapVol := assessVerticalCheapness(CallDebit, 0.27, 0.27, 0.25) // IVtoRV 1.08 <= 1.10
	if !strings.HasPrefix(cheapVol.Label, "cheap") {
		t.Fatalf("cheap-vol: Label = %q, want cheap", cheapVol.Label)
	}
	neutralVol := assessVerticalCheapness(CallDebit, 0.285, 0.285, 0.25) // IVtoRV 1.14
	if !strings.HasPrefix(neutralVol.Label, "fair") {
		t.Fatalf("neutral-vol: Label = %q, want fair", neutralVol.Label)
	}
	richVol := assessVerticalCheapness(CallDebit, 0.34, 0.34, 0.25) // IVtoRV 1.36 >= 1.30
	if !strings.HasPrefix(richVol.Label, "rich") {
		t.Fatalf("rich-vol: Label = %q, want rich", richVol.Label)
	}
}
