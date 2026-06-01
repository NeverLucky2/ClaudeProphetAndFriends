"""P1-4: 52-week high/low must use intraday highs/lows, not closing prices.

Old code computed high_52w = max(closes), which understates the true range and made
"0.0% off 52w high" really mean "at its highest close". compute_from_bars is the
injectable core so the math is testable without hitting FMP (also part of P0-2).
"""
from fetch_technicals import compute_from_bars


def _bars():
    """260 daily bars, FMP order (newest-first). Closes ramp 100..~150.

    Inject an intraday spike high (999) and flush low (1.0) on recent bars whose
    *closes* stay on the ramp, so close-based and intraday-based ranges diverge.
    """
    bars = []
    for i in range(260):
        close = 150.0 - i * 0.19  # newest (i=0) highest close ~150, oldest lower
        bars.append(
            {
                "date": f"2026-{(i % 12) + 1:02d}-{(i % 28) + 1:02d}",
                "open": close,
                "high": close + 0.5,
                "low": close - 0.5,
                "close": close,
                "volume": 1_000_000,
            }
        )
    bars[10]["high"] = 999.0  # intraday spike, within the trailing 252-bar window
    bars[20]["low"] = 1.0     # intraday flush
    return bars


def test_52w_high_uses_intraday_not_close():
    out = compute_from_bars("TEST", _bars())
    assert out["high_52w"] == 999.0  # would be ~150 if computed from closes
    assert out["low_52w"] == 1.0


def test_core_indicators_present():
    out = compute_from_bars("TEST", _bars())
    for key in ("ma20", "ma50", "ma200", "rsi14", "macd", "atr14", "current_price"):
        assert out[key] is not None
    assert 0.0 <= out["rsi14"] <= 100.0


def test_error_on_empty_bars():
    out = compute_from_bars("TEST", [])
    assert "error" in out
