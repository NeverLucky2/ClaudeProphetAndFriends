package services

import (
	"testing"
	"time"

	"prophet-trader/models"
)

func TestLifecyclePredicates(t *testing.T) {
	now := time.Date(2026, 6, 1, 17, 0, 0, 0, time.UTC)
	exp := now.Add(40 * 24 * time.Hour) // DTE 40
	near := now.Add(5 * 24 * time.Hour) // DTE 5
	sp := &models.DBProphetHedgeSpread{Expiration: exp, MaxPayoff: 1000, ShortPutStrike: 425}

	if !shouldHarvest(sp, 600) {
		t.Fatal("600 ≥ 60% of 1000 → harvest")
	}
	if shouldHarvest(sp, 599) {
		t.Fatal("599 < 60% → hold")
	}
	spNear := &models.DBProphetHedgeSpread{Expiration: near, ShortPutStrike: 425}
	if !shouldRoll(spNear, now, true) {
		t.Fatal("DTE 5 & armed → roll")
	}
	if shouldRoll(spNear, now, false) {
		t.Fatal("DTE 5 & disarmed → not roll (expire path)")
	}
	if !shouldExpire(spNear, now, false) {
		t.Fatal("DTE 5 & disarmed → expire")
	}
	if shouldExpire(spNear, now, true) {
		t.Fatal("DTE 5 & armed → not expire (roll path)")
	}
	if !shouldCloseITMShort(spNear, now, 420) {
		t.Fatal("DTE 5 & spot 420 ≤ short 425 → close")
	}
	if shouldCloseITMShort(spNear, now, 430) {
		t.Fatal("spot 430 > short 425 → no assignment risk")
	}
	if shouldCloseITMShort(sp, now, 420) {
		t.Fatal("DTE 40 not near expiry → not ITM-short rule")
	}
}

func TestDeriveArm(t *testing.T) {
	cases := []struct {
		name   string
		status RegimeGateStatus
		want   bool
	}{
		{"armed below threshold", RegimeGateStatus{Tier: "DEFENSIVE", Score: 30}, true},
		{"armed lower-normal", RegimeGateStatus{Tier: "NORMAL", Score: 49}, true},
		{"disarmed at threshold", RegimeGateStatus{Tier: "NORMAL", Score: 50}, false},
		{"disarmed green", RegimeGateStatus{Tier: "GREEN", Score: 80}, false},
		{"UNKNOWN never arms even with score 0", RegimeGateStatus{Tier: "UNKNOWN", Score: 0}, false},
		{"stale never arms", RegimeGateStatus{Tier: "RED", Score: 10, IsStale: true}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got, _ := deriveArm(c.status); got != c.want {
				t.Fatalf("deriveArm(%+v) = %v, want %v", c.status, got, c.want)
			}
		})
	}
}
