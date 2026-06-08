package services

import "testing"

func TestFormatHeartbeatLine(t *testing.T) {
	got := formatHeartbeatLine("Turtle", "0 entries, 1 exits, 2 skips", "17:00")
	want := "Turtle ✓ heartbeat processed — 0 entries, 1 exits, 2 skips · 17:00 ET"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestFormatHeartbeatLineOmitsEmptyAgentAndTime(t *testing.T) {
	got := formatHeartbeatLine("", "armed=false", "")
	want := "✓ heartbeat processed — armed=false"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}
