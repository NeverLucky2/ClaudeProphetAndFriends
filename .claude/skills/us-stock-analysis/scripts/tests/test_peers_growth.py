"""P1-3: peer rows must carry revenue growth, and field normalization must survive
FMP's stable/v3 key renames (the reason _g() exists). These are the schema-drift guard
called for in P0-2.
"""
from fetch_peers import build_peer_row, _yoy_revenue_growth


class FakeClient:
    """Returns canned payloads regardless of ticker; lets us assert normalization offline."""

    def __init__(self, quote, profile, ratios, metrics, income):
        self._quote, self._profile = quote, profile
        self._ratios, self._metrics, self._income = ratios, metrics, income

    def get_quote(self, t):
        return self._quote

    def get_profile(self, t):
        return self._profile

    def get_ratios_ttm(self, t):
        return self._ratios

    def get_key_metrics_ttm(self, t):
        return self._metrics

    def get_income_statement(self, t, period, limit):
        return self._income


def test_yoy_growth_from_two_year_income():
    # income returned newest-first by FMP: latest 120 vs prior 100 → +20%.
    income = [{"fiscalYear": "2025", "revenue": 120}, {"fiscalYear": "2024", "revenue": 100}]
    assert _yoy_revenue_growth(income) == 0.20


def test_yoy_growth_none_when_insufficient_history():
    assert _yoy_revenue_growth([{"fiscalYear": "2025", "revenue": 120}]) is None
    assert _yoy_revenue_growth([]) is None


def test_peer_row_includes_revenue_growth():
    client = FakeClient(
        quote={"price": 50.0, "marketCap": 5_000_000_000},
        profile={"companyName": "Test Co", "sector": "Technology", "industry": "Software"},
        ratios={"priceToSalesRatioTTM": 8.0, "grossProfitMarginTTM": 0.78},
        metrics={"evToSalesTTM": 8.2},
        income=[{"fiscalYear": "2025", "revenue": 130}, {"fiscalYear": "2024", "revenue": 100}],
    )
    row = build_peer_row(client, "TEST")
    assert row["revenue_growth"] == 0.30
    assert row["ps"] == 8.0


def test_peer_row_normalizes_v3_alt_key_names():
    # Provide only the v3-style alt names; _g() must still resolve them.
    client = FakeClient(
        quote={"price": 50.0, "marketCap": 5_000_000_000},
        profile={"companyName": "Test Co", "sector": "Tech", "industry": "SW"},
        ratios={"priceEarningsRatioTTM": 23.0, "debtEquityRatioTTM": 1.1},
        metrics={"enterpriseValueOverEBITDATTM": 17.0, "roicTTM": 0.09},
        income=[{"fiscalYear": "2025", "revenue": 110}, {"fiscalYear": "2024", "revenue": 100}],
    )
    row = build_peer_row(client, "TEST")
    assert row["pe_ttm"] == 23.0
    assert row["ev_ebitda"] == 17.0
    assert row["debt_to_equity"] == 1.1
    assert row["roic"] == 0.09
