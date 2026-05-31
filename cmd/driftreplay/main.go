package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"prophet-trader/config"
	"prophet-trader/services"

	"github.com/sirupsen/logrus"
)

func main() {
	years := flag.Int("years", 3, "years of earnings history to replay")
	fromStr := flag.String("from", "", "explicit start YYYY-MM-DD (overrides --years)")
	toStr := flag.String("to", "", "explicit end YYYY-MM-DD (default: today)")
	outDir := flag.String("out", "data/reports", "output directory")
	frictionPath := flag.String("friction", "config/friction.json", "friction config path")
	flag.Parse()

	logger := logrus.New()
	if err := config.Load(); err != nil {
		logger.WithError(err).Fatal("config load")
	}
	cfg := config.AppConfig // package global populated by Load(); see cmd/bot/main.go:25-29

	var err error
	to := time.Now()
	if *toStr != "" {
		if to, err = time.Parse("2006-01-02", *toStr); err != nil {
			logger.WithError(err).Fatal("parse --to")
		}
	}
	from := to.AddDate(-*years, 0, 0)
	if *fromStr != "" {
		if from, err = time.Parse("2006-01-02", *fromStr); err != nil {
			logger.WithError(err).Fatal("parse --from")
		}
	}

	fr, err := services.LoadStockFriction(*frictionPath)
	if err != nil {
		logger.WithError(err).Fatal("load friction")
	}

	// Service wiring — mirrors cmd/bot/main.go.
	limiter := services.NewAlpacaDataRateLimiter(cfg.AlpacaDataRatePerMin, 10)
	raw := services.NewAlpacaDataService(cfg.AlpacaAPIKey, cfg.AlpacaSecretKey)
	raw.SetRateLimiter(limiter)
	cacheDir, _ := filepath.Abs("data/bar-cache")
	data := services.NewSharedBarCache(raw, cacheDir, cfg.BarCacheTTL, logger)
	earnings := services.NewEarningsCalendarService(cfg.FMPAPIKey, cfg.AlpacaAPIKey, cfg.AlpacaSecretKey, cfg.AlpacaBaseURL, nil)
	// Enumerate earnings via the per-symbol /stable/earnings endpoint (full multi-year
	// history; no ~1y `from` cap or 4000-row truncation like /stable/earnings-calendar).
	reporter := services.NewUniverseEarningsReporter(earnings, services.DriftUniverse)

	cfgExit := services.ExitConfig{StopPct: 0.10, TargetPct: 0.20, TimeStopDays: 60}
	ctx := context.Background()

	logger.WithFields(logrus.Fields{"from": from.Format("2006-01-02"), "to": to.Format("2006-01-02"),
		"universe": len(services.DriftUniverse), "friction": fr.Version}).Info("driftreplay: starting")

	outcomes, cov := services.RunReplay(ctx, data, reporter, services.DriftUniverse, from, to, fr, cfgExit)
	summary := services.Aggregate(outcomes)

	rundate := time.Now().Format("2006-01-02")
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		logger.WithError(err).Fatal("mkdir out")
	}
	mdPath := filepath.Join(*outDir, "drift-continuation-replay-"+rundate+".md")
	jsonPath := filepath.Join(*outDir, "drift-continuation-replay-"+rundate+".json")

	md := renderMarkdown(from, to, fr, cov, summary)
	if err := os.WriteFile(mdPath, []byte(md), 0o644); err != nil {
		logger.WithError(err).Fatal("write md")
	}
	sidecar := map[string]any{"from": from.Format("2006-01-02"), "to": to.Format("2006-01-02"),
		"friction_version": fr.Version, "friction_hash": fr.Hash,
		"coverage": cov, "summary": summary, "outcomes": outcomes}
	jb, _ := json.MarshalIndent(sidecar, "", "  ")
	if err := os.WriteFile(jsonPath, jb, 0o644); err != nil {
		logger.WithError(err).Fatal("write json")
	}
	logger.WithFields(logrus.Fields{"md": mdPath, "json": jsonPath,
		"deployed": cov.DeployedEntries, "control": cov.ControlEntries}).Info("driftreplay: done")
}

func renderMarkdown(from, to time.Time, fr services.StockFriction, cov services.Coverage,
	s services.ReplaySummary) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Drift Continuation Expectancy Replay\n\n")
	fmt.Fprintf(&b, "Window requested: %s → %s | actual: %s → %s | friction: %s (%s)\n\n",
		from.Format("2006-01-02"), to.Format("2006-01-02"), cov.ActualFrom, cov.ActualTo, fr.Version, fr.Hash)

	fmt.Fprintf(&b, "## Coverage\n\n")
	fmt.Fprintf(&b, "- events enumerated: %d | in-universe: %d | bars OK: %d\n", cov.EventsEnumerated, cov.InUniverse, cov.BarsOK)
	fmt.Fprintf(&b, "- deployed entries: %d | control entries: %d | non-entries: %d | pead entries: %d\n",
		cov.DeployedEntries, cov.ControlEntries, cov.NonEntries, cov.NPeadEntries)
	fmt.Fprintf(&b, "- timing (inferred): bmo=%d amc=%d | fallback=%d unknown=%d\n",
		cov.TimingFill["bmo"], cov.TimingFill["amc"], cov.TimingFallback, cov.TimingFill[""])
	fmt.Fprintf(&b, "- entry price min/median/max: %.2f / %.2f / %.2f\n", cov.PriceMin, cov.PriceMedian, cov.PriceMax)
	fmt.Fprintf(&b, "- dropped: %v\n\n", cov.Dropped)

	writeCohort := func(name string, c services.CohortReport) {
		fmt.Fprintf(&b, "### %s\n\n", name)
		fmt.Fprintf(&b, "| basis | n | win%% | avg win%% | avg loss%% | PF | expectancy%% | avg hold |\n")
		fmt.Fprintf(&b, "|---|---|---|---|---|---|---|---|\n")
		for _, row := range []struct {
			label string
			cs    services.CohortSummary
		}{{"gross", c.Gross}, {"friction", c.Friction}} {
			fmt.Fprintf(&b, "| %s | %d | %.2f | %.2f | %.2f | %.2f | %.2f | %.1f |\n",
				row.label, row.cs.N, row.cs.WinRate, row.cs.AvgWinPct, row.cs.AvgLossPct,
				row.cs.ProfitFactor, row.cs.ExpectancyPct, row.cs.AvgHoldingDays)
		}
		fmt.Fprintf(&b, "\nexit reasons (gross): %v\n\n", c.Gross.ExitReasonCount)
	}
	fmt.Fprintf(&b, "## Expectancy\n\n")
	writeCohort("Deployed (continuation)", s.Deployed)
	writeCohort("Control (base gates only)", s.Control)
	fmt.Fprintf(&b, "**Marginal edge (deployed − control):** gross %.2f%% | friction %.2f%%\n\n",
		s.MarginalEdgeGrossPct, s.MarginalEdgeFricPct)

	tline := func(name string, n int, tb services.TimingBreakdown) {
		fmt.Fprintf(&b, "| %s | %d | %d | %d | %d | %d | %.2f / %.2f / %.2f |\n",
			name, n, tb.BMO, tb.AMC, tb.Fallback, tb.NearTies, tb.RatioMin, tb.RatioMedian, tb.RatioMax)
	}
	fmt.Fprintf(&b, "## Timing composition (clean read — read BEFORE expectancy)\n\n")
	fmt.Fprintf(&b, "Inferred BMO/AMC split per cohort + inference confidence. A large change in `n` or\n")
	fmt.Fprintf(&b, "in the inferred-BMO count vs the prior AMC-default run is itself a headline finding.\n\n")
	fmt.Fprintf(&b, "| cohort | n | bmo | amc | fallback | near-ties (<1.5) | ratio min/med/max |\n")
	fmt.Fprintf(&b, "|---|---|---|---|---|---|---|\n")
	tline("deployed", s.Deployed.Friction.N, s.DeployedTiming)
	tline("control", s.Control.Friction.N, s.ControlTiming)
	fmt.Fprintf(&b, "\n_Inferred-AMC entries sitting on a large BMO-side gap (low ratio) are the suspicious\n")
	fmt.Fprintf(&b, "BMO→AMC mislabels (risk #1); fallback entries kept the legacy AMC-default (risk #4)._\n\n")

	fmt.Fprintf(&b, "## Anti-chase (extension_pct vs friction-adjusted return, deployed cohort)\n\n")
	fmt.Fprintf(&b, "- Spearman ρ = %.2f | OLS slope = %.2f (n=%d)\n", s.ExtSpearman, s.ExtOLSSlope, s.Deployed.Friction.N)
	fmt.Fprintf(&b, "- **Buckets are descriptive only — low-power at this n; do not read a cap from them alone.**\n\n")
	fmt.Fprintf(&b, "| ext bucket | n | mean ret%% | win rate | win CI |\n|---|---|---|---|---|\n")
	for _, bk := range s.Buckets {
		fmt.Fprintf(&b, "| %s | %d | %.2f | %.2f | [%.2f, %.2f] |\n",
			bk.Label, bk.N, bk.MeanReturn, bk.WinRate, bk.WinLoCI, bk.WinHiCI)
	}
	fmt.Fprintf(&b, "\n_Survivorship (current universe) biases up; daily-bar stop-first/next-open fills bias down; net unknown._\n")
	return b.String()
}
