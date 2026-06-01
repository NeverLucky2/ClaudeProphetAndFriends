# scripts/test_stage1_category_count.py
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from stage1_category_count import required_n_per_split, cluster_dedup, build_report


def test_required_n_matches_stage1_reference():
    # same formula as the Node binomial-stats; 0.55/0.63/0.05/0.80 -> 235
    assert required_n_per_split(0.55, 0.63, 0.05, 0.80) == 235


def test_cluster_dedup_collapses_waves_keeps_distinct():
    dates = ["2024-01-01", "2024-01-03", "2024-01-08", "2024-01-20"]
    # W=5 calendar days: 01-03 within 5 of 01-01 -> dropped; 01-08 (>5 from 01-01) kept; 01-20 kept
    assert cluster_dedup(dates, 5) == ["2024-01-01", "2024-01-08", "2024-01-20"]
    # W=10: 01-08 within 10 of 01-01 -> dropped; 01-20 (>10 from 01-01) kept
    assert cluster_dedup(dates, 10) == ["2024-01-01", "2024-01-20"]


def test_build_report_counts_distinct_and_flags_K():
    # AAA analyst_pt: 480 distinct events (>=470 bar); BBB gov_bailout: 2 events
    events = []
    import datetime
    d = datetime.date(2022, 1, 3)
    for _ in range(480):
        events.append({"ticker": "AAA", "date": d.isoformat(), "category": "analyst_pt"})
        d += datetime.timedelta(days=6)  # >5 apart so none collapse
    events.append({"ticker": "BBB", "date": "2023-05-01", "category": "gov_bailout"})
    events.append({"ticker": "BBB", "date": "2024-05-01", "category": "gov_bailout"})

    rep = build_report(events, window_years=4.42, universe_size=56, w=5)
    assert rep["categories"]["analyst_pt"]["distinct"] == 480
    assert rep["categories"]["analyst_pt"]["clears_uncorrected_470"] is True
    assert rep["categories"]["gov_bailout"]["distinct"] == 2
    assert rep["categories"]["gov_bailout"]["clears_uncorrected_470"] is False
    assert rep["K_committed"] == 1            # only analyst_pt clears
    assert rep["corrected_alpha"] == 0.05 / 1
