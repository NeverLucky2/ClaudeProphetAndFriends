"""P1-5: price-target consensus must carry recency context so staleness is visible.

The motivating bug: DDOG traded +31% above its consensus target. Without the date of
the last analyst update, the analyst can't tell "sell-side thinks it's overvalued"
(fresh targets, informative) from "consensus is just lagging a fast rally" (stale
targets, ignore the anchor). derive_pt_context makes that explicit.
"""
from datetime import date

from fetch_stock_snapshot import derive_pt_context


def _pt_news(*dates_and_targets):
    """Build a minimal price-target-news list (newest-first, like FMP returns)."""
    return [
        {
            "publishedDate": f"{d}T12:00:00.000Z",
            "analystCompany": company,
            "priceTarget": pt,
        }
        for d, company, pt in dates_and_targets
    ]


TODAY = date(2026, 6, 9)


def test_emits_latest_update_and_90d_count():
    ctx = derive_pt_context(
        {"price": 100.0},
        {"targetConsensus": 110.0, "targetHigh": 130.0, "targetLow": 90.0},
        _pt_news(
            ("2026-06-04", "Goldman Sachs", 125.0),
            ("2026-04-20", "Morgan Stanley", 115.0),
            ("2025-11-01", "Jefferies", 95.0),
        ),
        today=TODAY,
    )
    assert ctx["latest_update_date"] == "2026-06-04"
    assert ctx["days_since_latest_update"] == 5
    assert ctx["updates_last_90d"] == 2
    # newest-first trimmed echo for the report narrative
    assert ctx["recent_updates"][0]["analystCompany"] == "Goldman Sachs"


def test_flags_stale_when_no_recent_updates():
    ctx = derive_pt_context(
        {"price": 131.0},
        {"targetConsensus": 100.0},
        _pt_news(("2025-10-15", "Jefferies", 100.0)),
        today=TODAY,
    )
    assert ctx["stale"] is True
    assert "stale" in ctx["note"].lower()
    # price 31% above a stale consensus → the anchor warning must fire
    assert ctx["price_vs_consensus_pct"] > 30


def test_fresh_updates_with_price_above_consensus_not_stale():
    # DDOG-like but with fresh targets: analysts genuinely below the price — informative.
    ctx = derive_pt_context(
        {"price": 131.0},
        {"targetConsensus": 100.0},
        _pt_news(("2026-06-05", "Goldman Sachs", 105.0)),
        today=TODAY,
    )
    assert ctx["stale"] is False
    assert ctx["price_vs_consensus_pct"] > 30
    assert "above" in ctx["note"].lower()


def test_soft_fails_on_missing_inputs():
    ctx = derive_pt_context(None, None, None, today=TODAY)
    assert ctx["stale"] is None
    assert ctx["latest_update_date"] is None
    assert ctx["recent_updates"] == []
