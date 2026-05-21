package services

import (
	"testing"
	"time"
)

func TestProphetBeatObserver_RecordsLatest(t *testing.T) {
	o := NewProphetBeatObserver()

	if _, ok := o.LastProphetBeat(); ok {
		t.Fatal("expected no beat observed initially")
	}

	t1 := time.Date(2026, 5, 21, 14, 0, 0, 0, time.UTC)
	o.RecordBeat(t1)
	got, ok := o.LastProphetBeat()
	if !ok || !got.Equal(t1) {
		t.Fatalf("got (%v,%v), want (%v,true)", got, ok, t1)
	}

	t2 := t1.Add(time.Minute)
	o.RecordBeat(t2)
	if got, _ := o.LastProphetBeat(); !got.Equal(t2) {
		t.Fatalf("got %v, want latest %v", got, t2)
	}
}
