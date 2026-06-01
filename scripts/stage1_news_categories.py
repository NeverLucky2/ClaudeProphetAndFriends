# scripts/stage1_news_categories.py
"""Deterministic multi-label news categorizer (~25 categories) for the per-category
frequency screen. Global excludes (junk/hypothetical/macro) are applied FIRST, reusing
the strict trigger, so a macro headline never tags a company event. Precision-leaning:
a missed category only costs frequency; a false tag inflates a category's apparent base.
Returns the SET of matched categories. Spec: 2026-05-31-news-category-frequency-count."""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from stage1_catalyst_trigger import JUNK, HYPOTHETICAL  # reuse junk + hypothetical excludes

# Categorizer-local macro exclude = the strict trigger's MACRO_SUBJECT MINUS tariff/trade-war,
# because `tariff` is one of OUR categories here (a tariff story tagged to a company is a
# company event). Everything else macro (inflation/jobs/Fed/geopolitics) still excluded so a
# macro headline never spuriously tags a category (e.g. "Job Growth Beats Expectations").
_MACRO_EXCL = re.compile(
    r"\b(inflation|recession|interest rate|rate (cut|hike|jitters|decision)|"
    r"jobs? (report|growth|numbers|data|gains)|unemployment|payrolls?|jobless|"
    r"gdp|cpi|ppi|fed(eral reserve)?|fomc|treasury yield|bond yield|"
    r"oil demand|world (economy|oil)|copper supply|gold (price|at \$)|"
    r"global economy|geopolit|ukraine|iran|israel|middle east)\b", re.I)


def _p(s):
    return re.compile(s, re.I)


CATEGORY_PATTERNS = {
    "ma_target":        _p(r"\b(to be acquired|agrees? to be acquired|agrees? to sell itself|"
                           r"(acquisition|takeover|buyout|tender) offer for|to be (acquired|bought) by)\b"),
    "ma_acquirer":      _p(r"\b(to acquire|agrees? to (acquire|buy)|completes? (its |the )?acquisition of)\b"),
    "earnings_beat":    _p(r"\b(beats?|tops?|crushes?|surpasses?) [\w' .,$-]{0,25}"
                           r"(eps|earnings|revenue|profit|estimates|consensus|expectations)\b"),
    "earnings_miss":    _p(r"\b(misses?|trails?|falls short of) [\w' .,$-]{0,25}"
                           r"(eps|earnings|revenue|profit|estimates|consensus|expectations)\b"),
    "guidance_raise":   _p(r"\b(raises?|lifts?|hikes?|boosts?|increases?) (its )?"
                           r"(full[- ]year |fy |q[1-4] |quarterly |annual )?"
                           r"(eps |revenue |profit |sales |earnings )?(guidance|forecast|outlook)\b"),
    "guidance_cut":     _p(r"\b((cuts?|lowers?|slashes?|trims?|reduces?) (its )?"
                           r"(full[- ]year |fy |q[1-4] |quarterly |annual )?"
                           r"(eps |revenue |profit |sales |earnings )?(guidance|forecast|outlook)|"
                           r"profit warning)\b"),
    "analyst_upgrade":  _p(r"\b(upgrade[sd]?|raised to (buy|overweight|outperform)|"
                           r"initiates? [\w' ]{0,15}(buy|outperform|overweight))\b"),
    "analyst_downgrade":_p(r"\b(downgrade[sd]?|cut to (sell|underweight|underperform)|"
                           r"lowered to (sell|hold|underperform))\b"),
    "analyst_pt":       _p(r"\b(raises?|lifts?|cuts?|lowers?|boosts?|hikes?) [\w' ]{0,20}price target\b|"
                           r"\bprice target (raised|cut|lowered|boosted|hiked|to \$)"),
    "fda_approval":     _p(r"\bfda (approv\w+|clears?|grants? approval)\b|"
                           r"\breceives? fda (approval|clearance)\b"),
    "fda_reject":       _p(r"\bfda (reject\w+|declines?)\b|\b(complete response letter|crl)\b|"
                           r"\b(fails?|failed|misses?) [\w' ]{0,20}(trial|endpoint|study)\b"),
    "legal_action":     _p(r"\b(lawsuit|sued|sues|class action|fined \$|settlement|"
                           r"(sec|doj) (probe|investigation|charges))\b"),
    "antitrust":        _p(r"\bantitrust\b|\b(doj|ftc|eu) (sues?|to sue|blocks?|to block|challenges?)\b|"
                           r"\bmonopoly\b"),
    "gov_bailout":      _p(r"\b(bailout|government rescue|federal (loan|aid|rescue)|rescue package|"
                           r"state aid)\b"),
    "gov_grant":        _p(r"\b(government grant|federal grant|subsid(y|ies)|"
                           r"awarded [\w' ]{0,20}contract|wins? [\w' ]{0,15}(government|federal|defense|dod|doe) contract|"
                           r"chips act (fund\w*|grant|award))\b"),
    "tariff":           _p(r"\b(tariffs?|export controls?|export ban|trade restrictions?)\b"),
    "buyback":          _p(r"\b(buyback|share repurchase|stock repurchase|repurchase program|"
                           r"authoriz\w+ [\w' $]{0,20}repurchase)\b"),
    "dividend_change":  _p(r"\b(raises?|increases?|cuts?|lowers?|suspends?|initiates?|declares?) "
                           r"[\w' ]{0,10}dividend\b|\bdividend (increase|cut|hike|boost|suspension)\b"),
    "offering":         _p(r"\b(secondary offering|public offering|share offering|stock offering|"
                           r"convertible (notes|bond) offering|prices? [\w' $]{0,15}offering|"
                           r"registered direct offering|dilution)\b"),
    "ceo_change":       _p(r"\b(ceo|cfo|chief executive) (steps? down|resigns?|to retire|departs?|"
                           r"named|appointed|to step down)\b|\bnames? new (ceo|cfo)\b|"
                           r"\b(ceo|cfo) (transition|shakeup|ouster)\b"),
    "insider_trade":    _p(r"\binsider (buying|selling|purchase|sale)\b|"
                           r"\b(ceo|cfo|director|insider) (buys?|sells?|purchases?) [\w' ,]{0,15}shares\b|"
                           r"\bform 4\b"),
    "product_launch":   _p(r"\b(unveils?|debuts?|launches? [\w' ]{0,20}(product|model|chip|device|service|app)|"
                           r"announces? [\w' ]{0,15}(launch|release))\b"),
    "product_recall":   _p(r"\b(recalls?|recall of|voluntary recall|safety recall)\b"),
    "restructuring":    _p(r"\b(layoffs?|job cuts?|cuts? [\w' ]{0,10}jobs|"
                           r"to cut [\w' ]{0,10}(jobs|workforce)|restructuring|plant closure|"
                           r"workforce reduction)\b"),
    "short_report":     _p(r"\b(short seller|short report|hindenburg|muddy waters|citron research|"
                           r"alleges? (fraud|accounting))\b"),
}


def categorize(headline, summary=""):
    text = f"{headline or ''} {summary or ''}".strip()
    if not text:
        return set()
    if JUNK.search(text) or HYPOTHETICAL.search(text) or _MACRO_EXCL.search(text):
        return set()
    return {cat for cat, pat in CATEGORY_PATTERNS.items() if pat.search(text)}
