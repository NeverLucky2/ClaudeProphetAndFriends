"""P0-1: snapshot must surface share-count trend + a marketCap≈price×shares sanity check.

The motivating bug: ServiceNow came back at $136 with a $140B market cap. Without a
share-count anchor an analyst can't tell a split from corrupt data. derive_share_context
makes that explicit and flags when the quote's implied share count diverges from the
reported share count (the signature of an unaccounted split or a stale/mixed series).
"""
from fetch_stock_snapshot import derive_share_context


def _income(*shares_by_year):
    """Build a minimal income_annual list (oldest-first) carrying weightedAverageShsOutDil."""
    return [
        {"fiscalYear": str(2021 + i), "weightedAverageShsOutDil": sh}
        for i, sh in enumerate(shares_by_year)
    ]


def test_emits_shares_trend_oldest_to_newest():
    ctx = derive_share_context(
        {"price": 136.0, "marketCap": 140_000_000_000},
        _income(1_016e6, 1_018e6, 1_028e6, 1_042e6, 1_047e6),
    )
    trend = ctx["shares_outstanding_trend"]
    assert [row["fiscalYear"] for row in trend] == ["2021", "2022", "2023", "2024", "2025"]
    assert trend[-1]["shares"] == 1_047e6
    assert ctx["latest_reported_shares"] == 1_047e6


def test_consistent_when_implied_matches_reported():
    # NOW case: implied 140e9/136 ≈ 1029M vs reported 1047M → ratio ~0.98 → consistent.
    ctx = derive_share_context(
        {"price": 136.0, "marketCap": 140_000_000_000},
        _income(1_016e6, 1_047e6),
    )
    assert ctx["marketcap_consistent"] is True
    assert 0.9 < ctx["marketcap_consistency_ratio"] < 1.1


def test_flags_split_or_stale_when_counts_diverge():
    # Pre-split reported count (207M) vs post-split implied count (~1029M) → ratio ~5 → flagged.
    ctx = derive_share_context(
        {"price": 136.0, "marketCap": 140_000_000_000},
        _income(207e6, 207e6),
    )
    assert ctx["marketcap_consistent"] is False
    assert "split" in ctx["note"].lower()


def test_soft_fails_on_missing_inputs():
    ctx = derive_share_context(None, None)
    assert ctx["marketcap_consistent"] is None
    assert ctx["shares_outstanding_trend"] == []
