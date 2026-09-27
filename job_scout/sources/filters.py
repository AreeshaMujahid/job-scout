"""Filters the API boards cannot apply for you.

These boards have no server-side query beyond words: they hand back their
catalogue and everything narrowing it happens here. Each rule below follows
the same principle as the seniority filter -- reject only on evidence. A
posting that does not state a salary is not a posting below your floor, and a
description that never mentions sponsorship is not a refusal to sponsor.
Silence is kept; only a statement counts against a job.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timezone
from typing import Iterable, Optional, Sequence

# --- freshness -------------------------------------------------------------

def age_in_days(posted_at: str, today: Optional[date] = None) -> Optional[int]:
    """How old this posting is, or None when it does not say.

    Boards write dates every way imaginable. Only ISO-ish leading dates are
    read, because a wrong guess here silently discards fresh jobs -- and the
    boards that give nothing usable simply return None and are kept.
    """
    if not posted_at:
        return None
    text = posted_at.strip()[:10]
    for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y"):
        try:
            parsed = datetime.strptime(text, fmt).date()
        except ValueError:
            continue
        reference = today or datetime.now(timezone.utc).date()
        return max(0, (reference - parsed).days)
    return None


def fresh_enough(posted_at: str, max_age_days: Optional[int]) -> bool:
    """Within the window, or undated. Undated is kept -- see the module note."""
    if max_age_days is None:
        return True
    age = age_in_days(posted_at)
    return age is None or age <= max_age_days


# --- salary ----------------------------------------------------------------

# "€65,000", "65000 EUR", "60k - 80k", "£45,000 per annum". The currency is
# ignored: a European board quoting 70k is quoting euros, and guessing
# exchange rates to filter a job listing is worse than not filtering.
_MONEY = re.compile(r"(\d[\d.,]{2,})\s*(k\b)?|(\d{2,3})\s*k\b", re.IGNORECASE)


def salary_figures(salary: str) -> list:
    """Every annual figure this salary string states, largest first.

    Hourly and daily rates are deliberately not converted. A "€65 per hour"
    posting is not a €65 salary, and treating it as one would hide good
    contract work behind a salary floor.
    """
    text = (salary or "").lower()
    if not text.strip():
        return []
    if any(word in text for word in ("hour", "hourly", "/h", "per day", "daily", "stunde", "tag")):
        return []

    found = []
    for match in _MONEY.finditer(text):
        raw, k_suffix, k_only = match.groups()
        if k_only:
            found.append(int(k_only) * 1000)
            continue
        if not raw:
            continue
        cleaned = raw.replace(",", "").replace(".", "")
        if not cleaned.isdigit():
            continue
        value = int(cleaned)
        if k_suffix:
            value *= 1000
        # Below 1000 a year is a typo or a percentage; above 10 million is an
        # employee count or a funding round that wandered into the field.
        if 1000 <= value <= 10_000_000:
            found.append(value)
    return sorted(found, reverse=True)


def pays_enough(salary: str, minimum: Optional[int]) -> bool:
    """Is the top of the stated range at or above the floor?

    The top, not the bottom: a posting advertising "55,000 - 75,000" is open
    to someone wanting 70,000, and filtering on the bottom of the band would
    reject the job they would actually be offered.
    """
    if minimum is None:
        return True
    figures = salary_figures(salary)
    return not figures or figures[0] >= minimum


# --- companies -------------------------------------------------------------

def _squash(name: str) -> str:
    """A company name with the noise removed, for comparing.

    Agencies appear as "Acme GmbH", "Acme Recruitment Ltd." and "ACME" in one
    afternoon's results, and a blocklist that only matches one spelling is a
    blocklist somebody stops maintaining.
    """
    text = re.sub(r"[^a-z0-9 ]+", " ", (name or "").lower())
    noise = {
        "gmbh", "ag", "ltd", "limited", "inc", "llc", "bv", "nv", "sa", "srl",
        "co", "kg", "se", "plc", "group", "holding", "holdings", "recruitment",
        "recruiting", "consulting", "solutions", "services", "the", "and",
    }
    return " ".join(word for word in text.split() if word and word not in noise)


def blocked(company: str, blocklist: Sequence[str]) -> bool:
    """Is this employer one the user asked never to see again?

    Matched on the squashed name, and on containment in either direction, so
    blocking "Acme" also blocks "Acme GmbH" and blocking the full legal name
    also catches the short one.
    """
    if not blocklist:
        return False
    name = _squash(company)
    if not name:
        return False
    for entry in blocklist:
        blocked_name = _squash(entry)
        if not blocked_name:
            continue
        if blocked_name in name or name in blocked_name:
            return True
    return False


# --- work authorisation ----------------------------------------------------

# Phrases that say, plainly, that the employer will not sponsor. Written to
# require the refusal: "visa sponsorship available" must not match, and
# neither must "we support visa applications".
_NO_SPONSORSHIP = [
    r"no (?:visa )?sponsorship",
    r"not (?:able|be able) to sponsor",
    r"cannot sponsor",
    r"can not sponsor",
    r"unable to sponsor",
    r"do(?:es)? not (?:offer|provide) (?:visa )?sponsorship",
    r"sponsorship is not (?:available|offered|provided)",
    r"without (?:visa )?sponsorship",
    r"must (?:already )?(?:have|possess) (?:the )?(?:valid )?(?:right to work|work authori[sz]ation|work permit)",
    r"(?:eu|eea|us|uk) (?:citizens?|nationals?|passport holders?) only",
    r"keine visa",
    r"keine arbeitserlaubnis",
]
_NO_SPONSORSHIP_RE = re.compile("|".join(_NO_SPONSORSHIP), re.IGNORECASE)


def refuses_sponsorship(description: str) -> bool:
    """Does this posting say outright that it will not sponsor a visa?"""
    return bool(_NO_SPONSORSHIP_RE.search(description or ""))


def open_to(description: str, needs_sponsorship: bool) -> bool:
    """Could someone needing sponsorship actually take this job?

    Only postings that refuse in words are dropped. Most say nothing at all,
    and treating silence as refusal would hide almost the whole market from
    exactly the people who most need to see it.
    """
    if not needs_sponsorship:
        return True
    return not refuses_sponsorship(description)


def keep(
    job,
    *,
    max_age_days: Optional[int] = None,
    min_salary: Optional[int] = None,
    blocked_companies: Iterable[str] = (),
    needs_sponsorship: bool = False,
) -> Optional[str]:
    """None when the posting survives, otherwise the reason it did not.

    A reason rather than a bool so the caller can count each one separately
    and tell the user which filter emptied their search.
    """
    if not fresh_enough(job.posted_at, max_age_days):
        return "stale"
    if not pays_enough(job.salary, min_salary):
        return "underpaid"
    if blocked(job.company, list(blocked_companies)):
        return "blocked"
    if not open_to(job.description, needs_sponsorship):
        return "no_sponsorship"
    return None
