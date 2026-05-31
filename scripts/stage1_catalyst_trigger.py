#!/usr/bin/env python3
"""Hardened, precision-leaning catalyst TRIGGER classifier for the Stage 1 experiment.

Separate from the live daily-brief `_classify` (which is deliberately loose for a
human-reviewed top-3 brief). An automated backtest trigger must NOT admit macro /
geopolitical / hypothetical noise — a false-positive trigger injects non-event days
into the firing set and biases the test toward HR=0.5. So this leans to PRECISION:
a missed catalyst only costs n; a false catalyst costs validity.

Returns 'ma' | 'earnings' | None. Deterministic + hashable (freeze in the prereg).
Order: junk -> hypothetical -> macro-subject -> definitive M&A -> company earnings.
"""
import re

# Lowball solicitations companies routinely reject; not real catalysts.
JUNK = re.compile(r"\bmini[- ]tender\b", re.I)

# Historical / counterfactual musings, not events.
HYPOTHETICAL = re.compile(
    r"\b(would have|could have|once thought|might have|may have happened|"
    r"hypothetical|would have happened)\b", re.I)

# Article is ABOUT a macro / geopolitical subject, not a single-company event.
MACRO_SUBJECT = re.compile(
    r"\b(inflation|recession|interest rate|rate (cut|hike|jitters|decision)|"
    r"jobs? (report|growth|numbers|data|gains)|unemployment|payrolls?|jobless|"
    r"gdp|cpi|ppi|fed(eral reserve)?|fomc|treasury yield|bond yield|"
    r"oil demand|world (economy|oil)|copper supply|gold (price|at \$)|"
    r"global economy|geopolit|ukraine|iran|israel|middle east|trade war|tariffs?)\b",
    re.I)

# Definitive, company-tied M&A deal language (not bare 'acquires', not 'merger' alone).
MA_STRICT = re.compile(
    r"\b(to acquire|agrees? to (acquire|buy|merge)|agreed to (acquire|buy)|"
    r"to be acquired|completes? (its |the )?(acquisition|merger)|"
    r"acquisition offer|takeover (bid|offer)|tender offer|"
    r"definitive (merger )?agreement|to merge with|buyout offer|"
    r"all[- ]cash (deal|acquisition|offer))\b", re.I)

# Company earnings / guidance events, anchored to a financial metric or period.
EARN_EVENT = re.compile(
    r"\b(preannounc\w*|profit warning|"
    r"(raises?|lifts?|hikes?|boosts?|cuts?|lowers?|slashes?|trims?) "
    r"(its )?(full[- ]year |fy |q[1-4] |quarterly |annual )?"
    r"(eps |revenue |profit |sales |earnings )?(guidance|outlook|forecast)|"
    r"(beats?|tops?|misses?|trails?) [\w' .,-]{0,25}(eps|earnings|revenue|profit|estimates|consensus)|"
    r"(q[1-4]|fiscal|full[- ]year|quarterly) [\w' .,-]{0,25}(earnings|eps) (guidance|warning|outlook|range)|"
    r"earnings per share (guidance|warning|outlook|range)|"
    r"warns? of lower [\w' .,-]{0,20}(earnings|profit|revenue|sales))\b", re.I)


def classify_catalyst_strict(headline, summary=""):
    text = f"{headline or ''} {summary or ''}".strip()
    if not text:
        return None
    if JUNK.search(text):
        return None
    if HYPOTHETICAL.search(text):
        return None
    if MACRO_SUBJECT.search(text):
        return None
    if MA_STRICT.search(text):
        return "ma"
    if EARN_EVENT.search(text):
        return "earnings"
    return None
