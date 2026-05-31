# .claude/skills/catalyst-news/scripts/tests/test_historical_range.py
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fetch_catalyst_news import build_historical_table  # noqa: E402


def test_build_historical_table_flattens_and_classifies():
    fake = {
        "NVDA": [
            {"publishedDate": "2026-03-02 13:30:00", "title": "NVDA agrees to buy Arm", "text": "deal"},
            {"publishedDate": "2026-03-02 18:00:00", "title": "NVDA raises guidance", "text": ""},
        ],
        "AAPL": [
            {"publishedDate": "2026-03-05 09:00:00", "title": "Apple new color", "text": "nothing"},  # not a catalyst
        ],
    }

    def fake_fetch(ticker, frm, to):
        return fake.get(ticker, [])

    rows = build_historical_table(["NVDA", "AAPL"], "2026-03-01", "2026-03-31", fetch=fake_fetch)
    nvda = [r for r in rows if r["ticker"] == "NVDA"]
    assert len(nvda) == 2
    assert all(r["date"] == "2026-03-02" for r in nvda)
    assert {r["event_type"] for r in nvda} == {"ma", "earnings"}
    assert not any(r["ticker"] == "AAPL" for r in rows)
