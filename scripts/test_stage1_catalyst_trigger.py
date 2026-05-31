"""Behavior spec for the hardened Stage 1 catalyst trigger. Cases are REAL headlines
pulled from Alpaca news (2024-04) plus a few canonical examples. True positives must
classify; the noise that polluted the loose classifier must now return None."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from stage1_catalyst_trigger import classify_catalyst_strict as clf


TRUE_MA = [
    "Johnson & Johnson Agrees To Acquire Shockwave Medical For $335/Share In Cash",
    "NVIDIA Agrees To Acquire Arm For $40B",
    "HubSpot Stock Jumps As Alphabet Considers Acquisition Offer: The Details",
]
TRUE_EARN = [
    "AbbVie Says Q1 2024 Adj Diluted Earnings Per Share Guidance Range",
    "Energy Woes: Exxon Mobil Warns Of Lower Q1 Earnings",
    "Tesla Preannounces Q3 Deliveries Below Consensus",
    "Microsoft Tops Q2 EPS Estimates",
]
# Real Alpaca headlines the loose classifier wrongly flagged, or canonical macro noise.
FALSE_NOISE = [
    "Jamie Dimon Warns Of Stickier Inflation, Higher Interest Rates In Annual JPMorgan Letter",
    "Bank Of America Sees Gold At $3,000, Warns Of A Copper Supply Crisis: Metals",
    "US Job Growth Beats Expectations And What That Means For You - Market Review",
    "March's 'Blowout' Jobs Numbers Underscore 'American Exceptionalism': 5 Economists Analyze",
    "Analyst Warns Of 'Serious Escalatory Tit-For-Tat Cycle' If Iran Strikes Back, Raising Fears",
    "Bob Iger Once Thought Apple And Disney Merger Would Have Happened If His Friend Steve Jobs",
    "U.S. Energy Information Administration Cuts Forecast For 2024 World Oil Demand Growth By 4",
    "Fed Raises Interest Rates By 25 Basis Points",
    "AMD Recommends Rejection Of Mini-Tender Offer From Tutanota LLC",
    "Morgan Stanley Capital Partners Acquires Resource Innovations; No Financial Terms Disclosed",
]


def test_true_ma_classifies_as_ma():
    for h in TRUE_MA:
        assert clf(h) == "ma", f"expected ma: {h!r} got {clf(h)!r}"


def test_true_earnings_classifies_as_earnings():
    for h in TRUE_EARN:
        assert clf(h) == "earnings", f"expected earnings: {h!r} got {clf(h)!r}"


def test_noise_is_rejected():
    for h in FALSE_NOISE:
        assert clf(h) is None, f"expected None (noise): {h!r} got {clf(h)!r}"


def test_empty_is_none():
    assert clf("") is None
    assert clf(None) is None
