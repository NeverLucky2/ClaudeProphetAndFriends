# scripts/test_stage1_news_categories.py
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from stage1_news_categories import categorize as C


TRUE_CASES = {
    "ma_acquirer":    "Johnson & Johnson Agrees To Acquire Shockwave Medical For $335/Share",
    "ma_target":      "Shockwave Medical To Be Acquired By Johnson & Johnson",
    "earnings_beat":  "Microsoft Tops Q2 EPS Estimates",
    "earnings_miss":  "Acme Misses Q3 Revenue Estimates",
    "guidance_raise": "Delta Raises Full-Year Profit Guidance",
    "guidance_cut":   "FedEx Cuts FY Guidance; Issues Profit Warning",
    "analyst_upgrade":"Morgan Stanley Upgrades Nvidia To Overweight",
    "analyst_downgrade":"Goldman Downgrades Intel To Sell",
    "analyst_pt":     "BofA Raises Apple Price Target To $260",
    "fda_approval":   "FDA Approves Eli Lilly's New Diabetes Drug",
    "fda_reject":     "Biotech Shares Plunge As FDA Issues Complete Response Letter",
    "legal_action":   "SEC Opens Investigation Into Company's Accounting; Lawsuit Filed",
    "antitrust":      "DOJ Sues To Block The Merger On Antitrust Grounds",
    "gov_bailout":    "Airline Secures Federal Bailout In Rescue Package",
    "gov_grant":      "Intel Awarded CHIPS Act Grant For New Fab",
    "tariff":         "New Tariffs On Chinese EV Imports Hit The Sector",
    "buyback":        "Company Authorizes $10B Share Repurchase Program",
    "dividend_change":"Company Raises Quarterly Dividend By 8%",
    "offering":       "Company Prices $500M Secondary Offering",
    "ceo_change":     "Company CEO Steps Down; Board Names New CEO",
    "insider_trade":  "CEO Buys 50,000 Shares In Insider Purchase",
    "product_launch": "Apple Unveils New iPhone Model",
    "product_recall": "Automaker Recalls 200,000 Vehicles Over Safety Defect",
    "restructuring":  "Tech Giant Announces Layoffs, Cutting 10,000 Jobs",
    "short_report":   "Hindenburg Short Report Alleges Accounting Fraud",
}

NOISE = [
    "Jamie Dimon Warns Of Stickier Inflation In Annual JPMorgan Letter",
    "US Job Growth Beats Expectations And What That Means For You",
    "Bob Iger Once Thought Apple And Disney Merger Would Have Happened",
    "Analyst Warns Of Escalation If Iran Strikes Back",
    "Company Recommends Rejection Of Mini-Tender Offer",
]


def test_each_category_matches_its_true_case():
    for cat, headline in TRUE_CASES.items():
        assert cat in C(headline, ""), f"{cat!r} not in {C(headline, '')!r} for {headline!r}"


def test_noise_matches_nothing():
    for h in NOISE:
        assert C(h, "") == set(), f"expected empty for noise {h!r}, got {C(h, '')!r}"


def test_multilabel_ma_with_guidance():
    h = "MegaCorp Agrees To Acquire Rival And Raises Full-Year Guidance"
    got = C(h, "")
    assert "ma_acquirer" in got and "guidance_raise" in got


def test_empty_is_empty_set():
    assert C("", "") == set()
    assert C(None, None) == set()
