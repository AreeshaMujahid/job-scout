"""LinkedIn, Xing and Arbeitnow, borrowed from the auto-apply bot.

`linkedin.py` at the repository root already has working, well-tested scrapers
for these three, and rewriting them here would mean maintaining two copies of
the same brittle HTML parsing. So this module imports them.

What it deliberately does NOT import is `JobStore`. The bot's scrapers are
normally handed a store and write straight into `jobs.db`; here they are
driven one level lower, at `source.fetch()`, which only yields postings. The
bot's database is never opened, never written to, and never read.

If `linkedin.py` is missing or fails to import, this degrades to an empty
board list rather than taking the whole service down with it.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Callable, Dict, List, Sequence, Tuple

from ..models import Job
from ._common import looks_remote

log = logging.getLogger(__name__)

# The bot lives one directory up. Importing by path rather than assuming the
# process was started from the repository root.
_REPO_ROOT = str(Path(__file__).resolve().parents[2])
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

IMPORT_ERROR: str | None = None

try:
    from linkedin import (  # type: ignore[import-not-found]
        ArbeitnowSource,
        HttpClient,
        LinkedInSource,
        XingSource,
    )

    SCRAPERS: Dict[str, str] = {
        "LinkedIn": "linkedin",
        "Xing": "xing",
        "Arbeitnow": "arbeitnow",
    }
except Exception as exc:  # pragma: no cover - only when the bot is absent
    IMPORT_ERROR = f"{type(exc).__name__}: {exc}"
    SCRAPERS = {}
    log.warning("scraper sources unavailable: %s", IMPORT_ERROR)
else:
    # Swap in the looser title check for THIS process only.
    #
    # All three of the bot's sources call the module-level
    # `_title_matches_keywords` from inside `fetch()`, so there is no argument
    # to pass and no method to override -- rebinding the module attribute is
    # the only seam. It is deliberately not an edit to `linkedin.py`: the bot
    # runs as its own process and keeps its stricter rule, unchanged and
    # unaffected by anything done here.
    #
    # Why looser: the bot's rule requires every query word in the title, which
    # threw away "Data Scientist (m/w/d)" for a search of "Senior Data
    # Scientist", and "ML Engineer" for "Machine Learning Engineer". See
    # titles.py for the full list and what it still rejects.
    import linkedin as _bot  # type: ignore[import-not-found]

    from . import places as _places
    from .titles import title_matches as _title_matches

    _bot._title_matches_keywords = _title_matches

    def _location_matches(wanted, got):
        """Country check for a board that already filtered by country.

        The bot's version knows six countries by name and falls back to a
        substring test, so it dropped every posting outside that list whose
        location did not literally contain the query -- and, in every country,
        LinkedIn's "Greater Nantes Metropolitan Area" format, which names no
        country at all.

        `source_filtered=True` is the important part: LinkedIn was already
        asked for this country server-side, so a location that names no
        country cannot be evidence of the wrong one and the posting is kept.
        A location naming a *different* country still is, and still drops.
        """
        return _places.matches(str(wanted or ""), str(got or ""), source_filtered=True)

    _bot._location_matches = _location_matches


# LinkedIn's f_E facet. The other two have no server-side seniority filter.
EXPERIENCE_LEVELS = {
    "Internship": "1",
    "Entry level": "2",
    "Associate": "3",
    "Mid-Senior level": "4",
    "Director": "5",
}


def _build_source(name: str, experience_levels: str | None, max_years: int | None):
    client = HttpClient()
    if name == "LinkedIn":
        return LinkedInSource(
            client=client,
            delay=2.0,
            experience_levels=experience_levels or None,
            max_years=max_years,
        )
    if name == "Xing":
        # Xing has no seniority facet and no per-job years extraction, so
        # those two filters are silently inapplicable rather than ignored
        # quietly -- the caller is told in the returned stats.
        return XingSource(client=client, delay=2.0)
    return ArbeitnowSource(client=client, delay=2.0)


def _to_job(posting, board: str) -> Job:
    location = posting.location or ""
    description = posting.description or ""
    return Job(
        source=board,
        title=posting.title,
        company=posting.company,
        url=posting.url or "",
        location=location,
        description=description,
        tags=[],
        salary="",
        # Full ISO 8601, not just the date. The scraper works to recover a
        # real time — LinkedIn's own `datetime` attribute is date-only, so
        # _parse_posted_at prefers the visible "3 hours ago" text and turns
        # it into an actual timestamp — and truncating to "%Y-%m-%d" here
        # threw that away, leaving the UI unable to tell a posting from an
        # hour ago from one posted at breakfast. "How fresh is this?" is
        # most of what a posting's age is for, since applying early matters.
        posted_at=posting.posted_at.isoformat() if posting.posted_at else "",
        remote=looks_remote(location, description[:600]),
        company_url=getattr(posting, "company_url", "") or "",
    )


def scrape(
    titles: Sequence[str],
    locations: Sequence[str],
    *,
    board: str = "LinkedIn",
    pages: int = 3,
    max_age_hours: float | None = 24,
    experience_levels: Sequence[str] = (),
    max_years: int | None = None,
    limit: int | None = None,
    on_progress: Callable[[str, str, int, int], None] | None = None,
) -> Tuple[List[Job], dict]:
    """Search every title against every location, as the bot's UI does.

    Returns the de-duplicated postings and a stats dict. A run that scrapes
    nothing at all is reported as such: with these sources that almost always
    means a blocked or empty response rather than an empty job market, and
    the difference matters to whoever is looking at the screen.

    `limit` stops the run once that many unique postings are collected. It
    matters more than it looks: this source fetches each posting's full
    description in its own request, with a delay after it, so cost is per
    POSTING and not per page. Eight searches over three pages is roughly 240
    descriptions -- about six minutes of sleeping -- and the caller then
    throws most of them away to score a couple of dozen. Without a limit
    that work is done anyway, and a run that overruns its HTTP timeout
    returns nothing at all for it.
    """
    if not SCRAPERS:
        raise RuntimeError(
            f"The LinkedIn/Xing/Arbeitnow scrapers could not be loaded ({IMPORT_ERROR})."
        )
    if board not in SCRAPERS:
        raise ValueError(f"Unknown board {board!r}. One of: {', '.join(SCRAPERS)}")

    facet = ",".join(EXPERIENCE_LEVELS[level] for level in experience_levels if level in EXPERIENCE_LEVELS)
    source = _build_source(board, facet, max_years)

    pairs = [(title, location) for title in titles for location in locations]
    stats = {
        "scraped": 0,
        "duplicates": 0,
        "searches": len(pairs),
        "failed_searches": 0,
        "board": board,
    }

    seen: set[str] = set()
    jobs: List[Job] = []
    # Per title x location, so a run across several titles doesn't collapse
    # into one aggregate number that means nothing to whoever is reading it --
    # "Android Developer: 0" and "Data Scientist: 27" is legible; "27" alone
    # covering both titles is not.
    per_search: List[dict] = []

    for index, (title, location) in enumerate(pairs, start=1):
        if limit is not None and len(jobs) >= limit:
            stats["stopped_early"] = True
            break
        if on_progress:
            on_progress(title, location, index, len(pairs))

        # Iterated lazily rather than list()-ed: materialising the whole
        # search first would pay for every description in it before anything
        # could count them, which is the cost the limit exists to avoid.
        found_count = 0
        failed = False
        try:
            for posting in source.fetch(title, location, pages, since_hours=max_age_hours):
                found_count += 1
                stats["scraped"] += 1
                job = _to_job(posting, board)
                if job.key in seen:
                    stats["duplicates"] += 1
                    continue
                seen.add(job.key)
                jobs.append(job)
                if limit is not None and len(jobs) >= limit:
                    stats["stopped_early"] = True
                    break
        except Exception as exc:
            # One dead search must not lose the other nine. Scraping a live
            # site fails routinely: rate limits, block pages, changed markup.
            # Anything already collected from this search is kept -- it was
            # paid for, and half a search beats none.
            stats["failed_searches"] += 1
            failed = True
            log.warning("%s search failed for %r in %r: %s", board, title, location, exc)

        per_search.append(
            {"title": title, "location": location, "scraped": found_count, "failed": failed}
        )

    stats["kept"] = len(jobs)
    stats["per_search"] = per_search
    # How many of the planned searches actually ran. Without this a run that
    # stopped early still claims `searches` of them, and the per-search list
    # silently comes up short with no explanation.
    stats["searches_run"] = len(per_search)
    stats.setdefault("stopped_early", False)
    return jobs, stats
