"""Work out how senior a posting is, when the board will not tell you.

LinkedIn has a real experience-level facet, so the scraper path filters before
anything is fetched. The API boards have nothing of the kind -- Remotive,
RemoteOK, Jobicy and the rest return whatever matches the words -- so a search
for entry-level work came back full of Senior and Staff roles and the filter
the user had set was quietly doing nothing on that half of the app.

This reads the title instead, which is where seniority is actually written.

The bias is deliberate and one-directional: a posting is dropped only when it
says plainly that it is a level the user did not ask for. "Senior Data
Scientist" is not an entry-level job and never will be. A bare "Data
Scientist" is genuinely ambiguous -- plenty are open to two years' experience
-- and guessing it away would throw out most of the market to remove a few
bad matches. Unknown is kept.
"""
from __future__ import annotations

import re
from typing import Optional, Sequence

# The levels the UI offers, in order. Matching the LinkedIn facet names keeps
# one vocabulary across both search paths.
LEVELS = ["Internship", "Entry level", "Associate", "Mid-Senior level", "Director"]
_RANK = {name: index for index, name in enumerate(LEVELS)}

# Words that put a title at a level, checked against whole words so that
# "Principal" matches and "Principles" does not, and "lead" in "Lead Engineer"
# matches while "leading" does not.
_MARKERS: list[tuple[str, tuple[str, ...]]] = [
    ("Director", (
        "director", "vp", "vice president", "head of", "chief", "cto", "cio",
        "principal", "distinguished", "fellow",
    )),
    ("Mid-Senior level", (
        "senior", "sr", "snr", "staff", "lead", "iii", "iv",
        # German and Dutch postings phrase it this way and are common on the
        # European boards this app reads.
        "leitung", "leiter", "leiterin", "erfahren",
    )),
    ("Internship", (
        "intern", "internship", "praktikum", "praktikant", "praktikantin",
        "working student", "werkstudent", "werkstudentin", "trainee",
        "apprentice", "placement",
        # German student routes, which a German board lists beside real
        # vacancies and which read as entry-level roles to an English eye.
        # A Duales Studium is a degree, an Abschlussarbeit is a thesis, and
        # neither is a job anyone applies to with a CV. They sit at
        # Internship so that a search for Entry level does not return them
        # while a search that does want them still can.
        "duales studium", "dualer student", "duale studentin", "ausbildung",
        "auszubildende", "abschlussarbeit", "bachelorarbeit", "masterarbeit",
        "studentische", "studentischer", "studentenjob",
    )),
    ("Entry level", (
        "junior", "jr", "graduate", "grad", "entry level", "entry-level",
        "einsteiger", "berufseinsteiger", "absolvent", "no experience",
    )),
]

# "5+ years", "at least 3 years", "3-5 years", "mindestens 4 Jahre".
_YEARS = re.compile(
    r"(\d{1,2})\s*(?:\+|plus)?\s*(?:-|–|to)?\s*(?:\d{1,2})?\s*\+?\s*"
    r"(?:years?|yrs?|jahre|jahren)",
    re.IGNORECASE,
)


def _has_word(haystack: str, needle: str) -> bool:
    return re.search(rf"(?<![a-z]){re.escape(needle)}(?![a-z])", haystack) is not None


def level_of(title: str) -> Optional[str]:
    """The level this title states, or None when it does not state one.

    Checked most senior first: "Senior Director" is a Director, and a title
    carrying both "Graduate" and "Senior" ("Senior Graduate Programme Lead")
    is not an entry-level job.
    """
    text = (title or "").lower()
    if not text:
        return None
    for level, markers in _MARKERS:
        if any(_has_word(text, marker) for marker in markers):
            return level
    return None


def years_required(description: str) -> Optional[int]:
    """The smallest number of years the posting asks for, if it says.

    The smallest, because a description mentioning both "2+ years of Python"
    and "5+ years in a regulated industry" is open to someone with two -- the
    larger figure is usually a nice-to-have further down the page. Taking the
    maximum turned "2+ years" postings into rejections.
    """
    found = [int(match) for match in _YEARS.findall(description or "")]
    # Anything above 25 is a company age or a founding year, not a requirement.
    plausible = [year for year in found if 0 < year <= 25]
    return min(plausible) if plausible else None


def matches(
    title: str,
    description: str = "",
    *,
    levels: Sequence[str] = (),
    max_years: Optional[int] = None,
) -> bool:
    """Should this posting survive the user's filters?

    True when nothing rules it out. Both filters only ever reject on evidence:
    a title that states a level outside the request, or a description asking
    for more years than the cap. Silence is not evidence.
    """
    if levels:
        stated = level_of(title)
        wanted = {_RANK[level] for level in levels if level in _RANK}
        if stated is not None and wanted and _RANK[stated] not in wanted:
            return False

    if max_years is not None:
        needed = years_required(description)
        if needed is not None and needed > max_years:
            return False

    return True
