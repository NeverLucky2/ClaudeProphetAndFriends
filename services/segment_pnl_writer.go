package services

import (
	"context"
	"time"

	"prophet-trader/database"
	"prophet-trader/models"

	"github.com/sirupsen/logrus"
)

// SegmentPnLWriter materializes one daily mark-to-market DBSegmentPnL row per
// strategy per trading day. It is the EOD half of segment P&L: the live
// SegmentPnLService answers "now"; this persists the daily series the lab
// graduation/beta analysis reads. Written daily even when a strategy is flat
// (0/0 row) so the return series stays continuous.
type SegmentPnLWriter struct {
	storage    *database.LocalStorage
	segmentPnL *SegmentPnLService
	logger     *logrus.Logger
}

// NewSegmentPnLWriter constructs the writer.
func NewSegmentPnLWriter(storage *database.LocalStorage, segmentPnL *SegmentPnLService, logger *logrus.Logger) *SegmentPnLWriter {
	return &SegmentPnLWriter{storage: storage, segmentPnL: segmentPnL, logger: logger}
}

// etDayKey returns the ET calendar-day string (YYYY-MM-DD) for now.
func etDayKey(now time.Time) string {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		return now.UTC().Format("2006-01-02")
	}
	return now.In(loc).Format("2006-01-02")
}

// shouldWriteSegmentMarks reports whether the EOD writer should run on this
// tick: a weekday, at/after 16:00 ET, and not already written for this ET day
// (lastWriteDay is the ET YYYY-MM-DD of the last successful write, "" if none).
func shouldWriteSegmentMarks(now time.Time, lastWriteDay string) bool {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		return false
	}
	et := now.In(loc)
	if wd := et.Weekday(); wd == time.Saturday || wd == time.Sunday {
		return false
	}
	if et.Hour() < 16 {
		return false
	}
	return etDayKey(now) != lastWriteDay
}

// WriteDailyMarks computes and upserts one DBSegmentPnL row per known strategy
// for the ET trading day containing now. Idempotent: a (strategy, day) that
// already has a row is skipped. Realized = frozen P&L of managed positions
// closed today (+ closed condors for harvest); unrealized/deployed/count/
// portfolio come from the live SegmentPnLService (current broker marks, valid
// for equity and options alike).
func (w *SegmentPnLWriter) WriteDailyMarks(ctx context.Context, now time.Time) error {
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		return err
	}
	et := now.In(loc)
	dayStart := time.Date(et.Year(), et.Month(), et.Day(), 0, 0, 0, 0, loc).UTC()
	dayEnd := dayStart.Add(24 * time.Hour)
	dayKey := time.Date(et.Year(), et.Month(), et.Day(), 0, 0, 0, 0, time.UTC) // Date column (UTC midnight of ET day)

	strategies, err := w.storage.ListManagedStrategies()
	if err != nil {
		return err
	}

	// D-DP9: defensive-Prophet persists to its own prophet_hedge_spreads table and
	// never writes managed_positions, so it won't appear in ListManagedStrategies().
	// Include it explicitly so its daily series is continuous (a 0/0 row on flat days).
	// NOTE / known limitation: only realized P&L (closed spreads) is folded in here;
	// open-spread unrealized marks require option-leg strategy attribution (mleg legs
	// aren't written to DBOrder), which is deferred to the grading-consumption work.
	hasDefensive := false
	for _, s := range strategies {
		if s == "prophet-defensive" {
			hasDefensive = true
			break
		}
	}
	if !hasDefensive {
		strategies = append(strategies, "prophet-defensive")
	}

	for _, strat := range strategies {
		existing, err := w.storage.GetSegmentPnLForDate(strat, dayKey)
		if err != nil {
			w.logger.WithError(err).WithField("strategy", strat).Warn("segment-pnl: existence check failed — skipping strategy this tick")
			continue
		}
		if existing != nil {
			continue // idempotent: already written today
		}

		realized, _, err := w.storage.GetManagedClosedPnL(strat, dayStart, dayEnd)
		if err != nil {
			w.logger.WithError(err).WithField("strategy", strat).Warn("segment-pnl: realized sum failed — skipping strategy this tick")
			continue
		}
		if strat == "harvest" {
			if h, herr := w.storage.GetHarvestClosedPnL(dayStart, dayEnd); herr == nil {
				realized += h
			}
		}
		if strat == "prophet-defensive" {
			if h, herr := w.storage.GetProphetHedgeClosedPnL(dayStart, dayEnd); herr == nil {
				realized += h
			}
		}

		seg, err := w.segmentPnL.GetSegmentPnL(ctx, strat)
		if err != nil {
			w.logger.WithError(err).WithField("strategy", strat).Warn("segment-pnl: live segment read failed — skipping strategy this tick")
			continue
		}

		row := &models.DBSegmentPnL{
			Strategy:        strat,
			Date:            dayKey,
			RealizedPnL:     realized,
			UnrealizedPnL:   seg.UnrealizedPnL,
			DeployedDollars: seg.DeployedDollars,
			DeployedPercent: seg.DeployedPercent,
			PositionCount:   seg.OpenPositions,
			PortfolioValue:  seg.PortfolioValue,
		}
		if err := w.storage.SaveSegmentPnL(row); err != nil {
			w.logger.WithError(err).WithField("strategy", strat).Error("segment-pnl: save failed")
			continue
		}
		w.logger.WithFields(logrus.Fields{
			"strategy": strat, "date": dayKey.Format("2006-01-02"),
			"realized": realized, "unrealized": seg.UnrealizedPnL,
		}).Info("segment-pnl: daily mark written")
	}
	return nil
}
