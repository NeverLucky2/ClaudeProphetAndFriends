package services

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadTradableUniverse(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "floor.txt")
	os.WriteFile(p, []byte("# header\nSPY\n  nvda  \n\nMSTR # inline\n"), 0o644)

	got, err := LoadTradableUniverse(p)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{"SPY", "NVDA", "MSTR"} {
		if !got[want] {
			t.Errorf("expected %q in floor, got %v", want, got)
		}
	}
	if len(got) != 3 {
		t.Errorf("expected 3 names, got %d (%v)", len(got), got)
	}
}

func TestLoadTradableUniverse_MissingFileIsEmptyNotError(t *testing.T) {
	// Missing file = "not configured yet" -> empty map, no error (gate fails open).
	got, err := LoadTradableUniverse(filepath.Join(t.TempDir(), "absent.txt"))
	if err != nil {
		t.Fatalf("missing file must not error, got %v", err)
	}
	if len(got) != 0 {
		t.Errorf("missing file must yield empty map, got %v", got)
	}
}
