"""
Job scraper — extended version of the class project.

Key ideas kept from the original:
  - a reusable requests.Session with a browser-like User-Agent
  - polite delays between requests
  - per-item error isolation so one bad record doesn't kill the run

What's new:
  - retry with exponential backoff  (finally uses `max_retries`)
  - Pydantic model instead of raw dicts (validation + clean typing)
  - a pluggable "source" abstraction so the fetch logic is swappable
  - a legitimate JSON API (Arbeitnow) as the default source
  - the LinkedIn scraper refactored to fit the same interface (kept for comparison)
  - SQLite persistence with automatic de-duplication
  - logging instead of print()
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import sys
import time
from abc import ABC, abstractmethod
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterator, List, Optional, Tuple, Union

import requests
from bs4 import BeautifulSoup
from pydantic import BaseModel, Field, ValidationError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("job_scraper")

# Job titles searched by default (CLI run and the Streamlit UI's initial
# selection). Each is its own LinkedIn search — see JobScraper.run_many.
DEFAULT_JOB_TITLES = ["Data Scientist", "AI Engineer", "ML Engineer"]


# --------------------------------------------------------------------------- #
# 1. The data model                                                           #
# --------------------------------------------------------------------------- #
class JobPosting(BaseModel):
    """One job listing. Pydantic validates types and gives us a stable schema.

    `job_id` is what we de-duplicate on — the same posting can show up on
    multiple pages, so we need a deterministic key.
    """

    title: str
    company: str
    location: Optional[str] = None
    url: Optional[str] = None
    company_url: Optional[str] = Field(
        None,
        description="The employer's own page on the board (LinkedIn /company/...), when "
                    "the listing links to one. Who is behind a posting is part of "
                    "deciding whether to apply, and an agency reposting for an "
                    "undisclosed client looks different from the employer posting itself.",
    )
    source: str = Field(..., description="Which source this came from, e.g. 'arbeitnow'")
    job_id: str = Field(..., description="Stable unique key for de-duplication")
    posted_at: Optional[datetime] = Field(
        None, description="When the job was posted (UTC), if the source exposes it"
    )
    required_years: Optional[int] = Field(
        None, description="Minimum years of experience parsed from the job description, if stated"
    )
    description: Optional[str] = Field(
        None, description="Full job description text, if the source exposes it — needed to rate fit"
    )
    fit_score: Optional[int] = Field(
        None, description="1-10 CV-fit score from job_rating.rate_job_fit, filled in after scraping"
    )
    fit_reasoning: Optional[str] = Field(
        None, description="One-line justification for fit_score"
    )
    application_status: Optional[str] = Field(
        None, description="'applied' | 'dry_run' | 'skipped' | 'failed'. None = not yet attempted."
    )
    applied_at: Optional[datetime] = Field(
        None, description="UTC timestamp of the application attempt, if one was made"
    )
    application_notes: Optional[str] = Field(
        None, description="Audit trail: fields filled/values used, or the skip/fail reason"
    )
    first_seen: Optional[str] = Field(
        None,
        description="When THIS tool first saw the job — not when the employer "
                    "posted it (that is posted_at). Lets the UI show one fetch.",
    )


# --------------------------------------------------------------------------- #
# 2. A shared HTTP helper with retry + backoff                                #
# --------------------------------------------------------------------------- #
class HttpClient:
    """Thin wrapper around requests.Session that retries transient failures.

    This is where the original `max_retries` finally does something. On a
    failed request we wait `backoff * (2 ** attempt)` seconds before trying
    again — 1s, 2s, 4s ... — which is the standard exponential-backoff pattern
    and a very common interview question.
    """

    def __init__(self, max_retries: int = 3, backoff: float = 1.0, timeout: float = 10.0):
        self.max_retries = max_retries
        self.backoff = backoff
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124"
                )
            }
        )

    def get(self, url: str, params: Optional[dict] = None) -> Optional[requests.Response]:
        """GET with retries. Returns the Response, or None if all attempts fail."""
        for attempt in range(self.max_retries):
            try:
                res = self.session.get(url, params=params, timeout=self.timeout)
                res.raise_for_status()
                return res
            except requests.RequestException as e:
                wait = self.backoff * (2 ** attempt)
                log.warning(
                    "request failed (attempt %d/%d): %s — retrying in %.1fs",
                    attempt + 1,
                    self.max_retries,
                    e,
                    wait,
                )
                time.sleep(wait)
        log.error("giving up on %s after %d attempts", url, self.max_retries)
        return None


# --------------------------------------------------------------------------- #
# 3. The source abstraction                                                   #
# --------------------------------------------------------------------------- #
class JobSource(ABC):
    """A source of jobs. Subclass this to add LinkedIn, Adzuna, Xing, etc.

    The orchestrator only knows about this interface, so swapping sources
    doesn't touch the rest of the code.
    """

    name: str = "base"

    def __init__(self, client: Optional[HttpClient] = None, delay: float = 2.0):
        self.client = client or HttpClient()
        self.delay = delay

    @abstractmethod
    def fetch(
        self,
        keywords: str,
        location: str,
        num_pages: int,
        since_hours: Optional[float] = None,
    ) -> Iterator[JobPosting]:
        """Yield postings. `since_hours`, if given, is a hint to prefer/only
        request recent postings — sources that can't filter server-side are
        free to ignore it (JobScraper.run still filters by `posted_at`)."""
        ...


# A handful of role-title words that split into surface variants a plain
# substring check won't connect (e.g. "scientist" isn't a substring of
# "science", so "Data Science Engineer" would wrongly be rejected for the
# query "Data Scientist"; "ai"/"ml" as full words also need their spelled-out
# forms). Keyed by the lowercase query word.
_TITLE_WORD_SYNONYMS = {
    "scientist": {"scientist", "scientists", "science"},
    "science": {"science", "scientist", "scientists"},
    "ai": {"ai", "artificial intelligence"},
    "ml": {"ml", "machine learning"},
}


def _title_matches_keywords(title: str, keywords: str) -> bool:
    """True if every word in `keywords` has a matching form in `title`
    (case-insensitive, order-independent, whole-word).

    Matching the full phrase as one contiguous substring is too strict:
    "Data Scientist" as a literal substring check rejects legitimate
    variants like "Senior Data Science Engineer" or "Werkstudent Data
    Science". Requiring each word separately — with a small synonym set for
    common variants — catches those while still rejecting titles that share
    no real relation (e.g. "Data Engineer" has "data" but no scientist/
    science form, so it's correctly excluded).

    Word-boundary matching (`\\b`) matters once short tokens like "ai"/"ml"
    are in play: a plain substring check would let "ai" match inside
    "Rails" or "ml" match inside "html", which a real word never does.
    """
    title_lower = title.lower()
    for word in keywords.lower().split():
        forms = _TITLE_WORD_SYNONYMS.get(word, {word})
        if not any(re.search(r"\b" + re.escape(form) + r"\b", title_lower) for form in forms):
            return False
    return True


# Sources are asked to search a location (e.g. "USA"), but that's a text
# query on the source's own search box, not a guarantee — LinkedIn/Xing
# happily return unrelated results if their fuzzy match misfires, and
# "Remote" isn't a real place a geo search understands at all. So every
# source's `location` filter is re-checked client-side against what the
# card itself displays, the same way _title_matches_keywords re-checks
# keywords. Aliases below cover the location names offered in job_ui.py;
# an unlisted (custom) location falls back to a plain substring check.
_LOCATION_ALIASES = {
    "usa": {"usa", "united states", "u.s.a", "u.s.", "us"},
    "us": {"usa", "united states", "u.s.a", "u.s.", "us"},
    "united states": {"usa", "united states", "u.s.a", "u.s.", "us"},
    "canada": {"canada"},
    "indonesia": {"indonesia"},
    "germany": {"germany"},
    "remote": {"remote"},
    "uk": {"uk", "united kingdom", "u.k."},
    "united kingdom": {"uk", "united kingdom", "u.k."},
}


# A posting's location text rarely says "remote" outright (LinkedIn's guest
# search tends to show a city/state even for fully-remote roles), so a
# "Remote" search also checks the description for real remote language —
# see LinkedInSource.fetch, where the description is force-fetched just for
# this check when nothing else confirms it.
#
# A bare "remote"-or-"work from home" match is NOT safe, and excluding a
# handful of known bad phrases isn't enough to fix that — confirmed against
# a real scraped posting (a cleared, Honolulu-only government contract job,
# nothing remote about it) that matched on two different false signals at
# once: "dropped off on a *remote* contract" (idiom, nothing to do with
# work arrangement) and a "Work From Home Opportunities" bullet buried in
# a generic benefits list (a perk the company sometimes offers, not an
# assertion that *this* posting is remote). Blacklisting more bad phrases
# only chases the next idiom; this instead whitelists the specific
# assertions a posting makes when it actually IS remote — "fully remote",
# "remote position", "work remotely", etc. — which is a much smaller,
# far more reliable surface than every incidental use of the word.
# "Remote" in the TITLE ("Data Scientist (Remote)", "Remote ML Engineer") is
# a direct assertion about the posting itself, not an incidental mention, so
# unlike the description it needs no whitelist of surrounding phrasing.
_REMOTE_TITLE_RE = re.compile(r"\bremote\b", re.I)


_REMOTE_TEXT_RE = re.compile(
    r"100%\s*remote"
    r"|fully\s*remote"
    r"|remote[\s-](?:first|friendly|eligible|only)"
    r"|remote\s+(?:position|role|job|opportunity|employment|team|employee|hire|hiring)"
    r"|(?:this\s+(?:position|role|job)\s+is|position\s+is)\s+remote"
    r"|work(?:s|ing)?\s+remotely"
    r"|remote\s+work\s+(?:arrangement|environment|setup)"
    r"|work[\s-]?from[\s-]?home\s+(?:position|role|job|policy|arrangement|full[\s-]?time|opportunity)",
    re.I,
)


def _location_matches(query: str, job_location: Optional[str]) -> bool:
    """True if `job_location` (as shown on the listing) actually satisfies
    the requested `query` location — see module note above.

    An empty query always matches (no location filter requested). A
    non-empty query with no location on the listing never matches: we can't
    confirm it satisfies the filter, so it's dropped rather than guessed at.
    """
    q = query.strip().lower()
    if not q:
        return True
    if not job_location:
        return False
    job_location_lower = job_location.lower()
    aliases = _LOCATION_ALIASES.get(q, {q})
    return any(alias in job_location_lower for alias in aliases)


class ArbeitnowSource(JobSource):
    """Arbeitnow's public job-board API — free, JSON, no key, no ToS problem.

    This is the recommended default: it returns structured JSON, so there are
    no fragile CSS selectors that break when a site redesigns. We filter by
    keyword/location client-side because the endpoint returns a general feed.
    """

    name = "arbeitnow"
    BASE_URL = "https://www.arbeitnow.com/api/job-board-api"

    def fetch(
        self,
        keywords: str,
        location: str,
        num_pages: int,
        since_hours: Optional[float] = None,
    ) -> Iterator[JobPosting]:
        # Arbeitnow's feed API has no server-side date filter/sort, so
        # `since_hours` is unused here — JobScraper.run filters by posted_at.
        is_remote_only = location.strip().lower() == "remote"

        for page in range(1, num_pages + 1):
            res = self.client.get(self.BASE_URL, params={"page": page})
            if res is None:
                continue

            try:
                payload = res.json()
            except ValueError:
                log.error("arbeitnow: page %d did not return JSON", page)
                continue

            for row in payload.get("data", []):
                title = (row.get("title") or "").strip()
                job_location = (row.get("location") or "").strip()

                # simple client-side filtering
                if keywords and not _title_matches_keywords(title, keywords):
                    continue
                # Arbeitnow gives a real `remote` boolean on every row — a
                # far more reliable signal than hoping "remote" shows up as
                # a word in the free-text `location` field.
                if is_remote_only:
                    if not row.get("remote"):
                        continue
                elif not _location_matches(location, job_location):
                    continue

                # Arbeitnow gives an exact unix timestamp — the most precise
                # `posted_at` we get from any source.
                posted_at = None
                created_ts = row.get("created_at")
                if created_ts:
                    try:
                        posted_at = datetime.fromtimestamp(created_ts, tz=timezone.utc)
                    except (TypeError, ValueError, OSError):
                        posted_at = None

                # Arbeitnow includes the full description inline (as HTML) —
                # no extra request needed, unlike LinkedIn.
                raw_description = row.get("description")
                description = (
                    BeautifulSoup(raw_description, "html.parser").get_text(" ", strip=True)
                    if raw_description
                    else None
                )

                try:
                    yield JobPosting(
                        title=title,
                        company=(row.get("company_name") or "").strip(),
                        location=job_location or None,
                        url=row.get("url"),
                        source=self.name,
                        # slug is Arbeitnow's own stable id — perfect dedup key
                        job_id=f"{self.name}:{row.get('slug') or row.get('url')}",
                        posted_at=posted_at,
                        description=description,
                    )
                except ValidationError as e:
                    log.debug("skipping malformed row: %s", e)
                    continue

            log.info("arbeitnow: fetched page %d", page)
            time.sleep(self.delay)


class LinkedInSource(JobSource):
    """Your original scraper, refactored to fit the JobSource interface.

    Kept so you can talk about it critically in your write-up. Note the
    trade-off you already know: this parses HTML with hard-coded class names,
    so it breaks whenever LinkedIn changes its markup, and scraping their
    guest endpoint is against their Terms of Service. Prefer ArbeitnowSource
    for anything you actually rely on.
    """

    name = "linkedin"
    BASE_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
    DETAIL_URL = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting"

    # LinkedIn's f_E experience-level facet: 1=Internship, 2=Entry level,
    # 3=Associate, 4=Mid-Senior level, 5=Director, 6=Executive.
    ENTRY_ASSOCIATE_LEVELS = "2,3"

    _RELATIVE_TIME_RE = re.compile(r"(\d+)\s+(minute|hour|day|week|month)s?\s+ago")
    _UNIT_TO_DELTA = {
        "minute": lambda n: timedelta(minutes=n),
        "hour": lambda n: timedelta(hours=n),
        "day": lambda n: timedelta(days=n),
        "week": lambda n: timedelta(weeks=n),
        "month": lambda n: timedelta(days=n * 30),
    }

    # English + German phrasing for "N years of experience" / "N-jährige
    # Erfahrung". The "experience"/"erfahrung" word is REQUIRED (with up to
    # two filler words in between, e.g. "years of professional experience")
    # so bare mentions of "years" ("founded 40 years ago", "over the past 5
    # years the team has grown") don't get misread as a requirement.
    #
    # German commonly glues a prefix directly onto "erfahrung" with no space
    # ("Berufserfahrung", "Praxiserfahrung") rather than as a separate word,
    # so that branch allows a glued letter-prefix; English "experience"
    # doesn't compound that way, so it stays a standalone word.
    _EXPERIENCE_TAIL = (
        r"(?:(?:of\s+)?(?:[a-zA-Z]+\s+){0,2}experience"
        r"|(?:[a-zA-Zäöüß]+\s+){0,2}[a-zA-Zäöüß]*erfahrung)"
    )
    _YEARS_RANGE_RE = re.compile(
        r"(\d{1,2})\s*(?:-|–|to|bis)\s*(\d{1,2})\+?\s*(?:years?|jahre[n]?)\s*"
        + _EXPERIENCE_TAIL,
        re.IGNORECASE,
    )
    _YEARS_SINGLE_RE = re.compile(
        r"(\d{1,2})\+?[\s-]?(?:"
        r"years?\s*" + _EXPERIENCE_TAIL + r"|"
        r"j[aä]hrige[r]?\s*" + _EXPERIENCE_TAIL + r"|"
        r"jahre[n]?\s*" + _EXPERIENCE_TAIL
        + r")",
        re.IGNORECASE,
    )

    def __init__(
        self,
        client: Optional[HttpClient] = None,
        delay: float = 2.0,
        experience_levels: Optional[str] = ENTRY_ASSOCIATE_LEVELS,
        min_years: Optional[int] = None,
        max_years: Optional[int] = None,
        detail_delay: float = 1.0,
        fetch_descriptions: bool = True,
    ):
        """
        `experience_levels`: LinkedIn f_E facet value(s), e.g. "2,3" for
        Entry level + Associate. None disables the server-side level filter.

        `min_years`/`max_years`: if set, each job's full description is
        fetched and scanned for a stated years-of-experience requirement;
        jobs requiring more than `max_years` are dropped. A description with
        no detectable years requirement is kept (best-effort, not a rejection).
        `min_years` is currently informational only (see _extract_required_years).

        `fetch_descriptions`: fetch each job's full description even when
        `max_years` is None (e.g. so job_rating.rate_job_fit has text to
        score against). Fetching happens once per job either way — if
        `max_years` is also set, the same fetched text is reused for the
        years check rather than fetching twice.
        """
        super().__init__(client=client, delay=delay)
        self.experience_levels = experience_levels
        self.min_years = min_years
        self.max_years = max_years
        self.detail_delay = detail_delay
        self.fetch_descriptions = fetch_descriptions

    def _parse_posted_at(self, card) -> Optional[datetime]:
        """Best-effort posting timestamp from the card's <time> element.

        LinkedIn's `datetime` attribute is date-only ("2024-06-10"), which is
        too coarse to tell "3 hours ago" from "23 hours ago". The visible
        relative text ("3 hours ago") is more precise, so we prefer parsing
        that and only fall back to the raw attribute if the text doesn't match.
        """
        # LinkedIn uses a separate `--new` class for very recent postings
        # (e.g. "21 hours ago") instead of the plain `listdate` class.
        time_el = card.select_one(
            "time.job-search-card__listdate, time.job-search-card__listdate--new"
        )
        if not time_el:
            return None

        relative = time_el.get_text(strip=True)
        match = self._RELATIVE_TIME_RE.match(relative)
        if match:
            amount, unit = int(match.group(1)), match.group(2)
            return datetime.now(timezone.utc) - self._UNIT_TO_DELTA[unit](amount)

        raw = time_el.get("datetime")
        if raw:
            try:
                return datetime.fromisoformat(raw).replace(tzinfo=timezone.utc)
            except ValueError:
                return None
        return None

    def _fetch_description(self, job_id: str) -> Optional[str]:
        """Fetch a single job's full description text (search cards don't
        include it — only the individual posting page does)."""
        res = self.client.get(f"{self.DETAIL_URL}/{job_id}")
        if res is None:
            return None
        soup = BeautifulSoup(res.text, "html.parser")
        desc = soup.select_one("div.description__text")
        return desc.get_text(" ", strip=True) if desc else None

    def _extract_required_years(self, text: str) -> Optional[int]:
        """Best-effort minimum years-of-experience requirement from free text.

        Only phrases tied to "years of experience"/"Jahre Erfahrung" count
        (see _EXPERIENCE_TAIL), so incidental mentions like "founded 40
        years ago" are ignored. A description can state several numbers
        (a "nice to have: 8 years" alongside the real "minimum 3 years
        required") — we take the smallest, since for a job seeker missing
        out on a role you could've applied to is worse than seeing one
        that's a bit out of reach.
        """
        candidates = [int(m.group(1)) for m in self._YEARS_RANGE_RE.finditer(text)]
        candidates += [int(m.group(1)) for m in self._YEARS_SINGLE_RE.finditer(text)]
        return min(candidates) if candidates else None

    def fetch(
        self,
        keywords: str,
        location: str,
        num_pages: int,
        since_hours: Optional[float] = None,
    ) -> Iterator[JobPosting]:
        # "Remote" isn't a place LinkedIn's location box can geocode — sending
        # it there returns unrelated results scattered across random
        # countries (confirmed live: searching location="Remote" returned
        # cards in Qatar, Norway, the UAE...). LinkedIn's real remote facet,
        # f_WT=2, looks like the fix but ISN'T: confirmed live that the
        # guest/unauthenticated endpoint this scraper uses (BASE_URL above)
        # returns byte-for-byte the same job ids with or without it — the
        # facet is silently ignored server-side. There is no server-side way
        # to ask this endpoint for remote jobs. So for "Remote", search
        # broadly (no location constraint, so nothing worldwide is excluded
        # up front) and rely entirely on the client-side check below, which
        # forces a description fetch and looks for real remote language.
        is_remote_only = location.strip().lower() == "remote"

        # Sending no location and no remote hint returns ordinary city-bound
        # postings — confirmed live: a "Remote" search came back as Michigan,
        # Plano, San Francisco, Washington DC..., none of them remote, so the
        # remote check below dropped all ten and the search yielded nothing.
        # Putting "remote" in the KEYWORDS is what actually surfaces remote
        # roles, since LinkedIn's own relevance ranking reads it (same query
        # with "remote" appended returned "Data Scientist - Python (Remote)",
        # "Data Scientist (Remote)" and nationwide "United States" postings).
        #
        # Kept separate from `keywords` because the client-side title check
        # below validates against the role words only: _title_matches_keywords
        # requires EVERY query word in the title, and demanding "remote" there
        # would throw away real remote postings that don't say so in the title.
        search_keywords = f"{keywords} remote" if is_remote_only else keywords

        for page in range(num_pages):
            params = {"keywords": search_keywords, "start": page * 25}
            if not is_remote_only:
                params["location"] = location
            if since_hours is not None:
                # f_TPR = "posted within the last N seconds"; sortBy=DD sorts
                # newest-first. Without these, results are relevance-sorted
                # and recent postings may never appear in the first pages.
                params["f_TPR"] = f"r{int(since_hours * 3600)}"
                params["sortBy"] = "DD"
            if self.experience_levels:
                params["f_E"] = self.experience_levels
            res = self.client.get(self.BASE_URL, params=params)
            if res is None:
                continue

            soup = BeautifulSoup(res.text, "html.parser")
            # LinkedIn moved `base-card` onto an inner <div>; the wrapping <li>
            # no longer carries that class, so `li.base-card` matches nothing.
            for card in soup.select("div.base-card.job-search-card"):
                title = card.select_one("h3.base-search-card__title")
                company = card.select_one("h4.base-search-card__subtitle")
                loc_el = card.select_one("span.job-search-card__location")
                link = card.select_one("a.base-card__full-link")

                if not (title and company):
                    continue

                # The employer's own page, straight off the card — no extra
                # request. Worth taking here rather than from the job page:
                # forcing a detail fetch per posting is what trips LinkedIn's
                # rate limiting partway through a run (see the note on
                # descriptions below), and this is the same link.
                company_link = company.select_one("a[href*='/company/']")
                company_url = None
                if company_link and company_link.get("href"):
                    company_url = company_link["href"].split("?")[0].strip() or None

                title_text = title.get_text(strip=True)
                # Once narrow filters (recent + junior/associate) exhaust the
                # real matches, LinkedIn's guest search pads later pages with
                # unrelated "you might also like" postings that ignore the
                # keyword entirely. Guard against that drift client-side.
                if keywords and not _title_matches_keywords(title_text, keywords):
                    continue
                job_location_text = loc_el.get_text(strip=True) if loc_el else None
                # LinkedIn's `location` search box is a fuzzy geo query, not a
                # hard filter — it can return postings outside the requested
                # place. Re-check what the card itself displays before
                # keeping it. Not applied for "Remote" (no location was even
                # sent, see above) — that case is checked further down,
                # against the description, once fetched.
                if not is_remote_only and not _location_matches(location, job_location_text):
                    continue

                url = link.get("href") if link else None
                # Prefer the stable numeric id from data-entity-urn
                # (e.g. "urn:li:jobPosting:4399464145") over the full tracking URL.
                urn = card.get("data-entity-urn") or ""
                numeric_id = urn.rsplit(":", 1)[-1] if urn else None
                stable_key = numeric_id or url
                posted_at = self._parse_posted_at(card)

                # Remote signals that cost no extra request. Either one is a
                # direct claim by the posting itself, so when one holds the
                # description is never fetched just to re-confirm remoteness
                # — that halves the request count on a Remote search, which
                # matters: force-fetching every description is what trips
                # LinkedIn's rate limiting (429s) partway through a run.
                remote_confirmed = is_remote_only and bool(
                    _location_matches("remote", job_location_text)
                    or _REMOTE_TITLE_RE.search(title_text)
                )
                # Nothing cheap said remote, so the description is the only
                # place left to confirm it — and without an id we can't fetch
                # one, so the card can't be confirmed and is dropped, same as
                # a location filter dropping an unconfirmable card.
                if is_remote_only and not remote_confirmed and not numeric_id:
                    continue

                description = None
                required_years = None
                needs_remote_proof = is_remote_only and not remote_confirmed
                if (self.fetch_descriptions or self.max_years is not None or needs_remote_proof) and numeric_id:
                    description = self._fetch_description(numeric_id)
                    time.sleep(self.detail_delay)
                    if self.max_years is not None and description:
                        required_years = self._extract_required_years(description)
                        if required_years is not None and required_years > self.max_years:
                            log.debug(
                                "skipping %s: requires %d+ years (max %d)",
                                stable_key,
                                required_years,
                                self.max_years,
                            )
                            continue

                if is_remote_only and not remote_confirmed and not (
                    description and _REMOTE_TEXT_RE.search(description)
                ):
                    log.debug(
                        "skipping %s: no remote signal in location, title or description", stable_key
                    )
                    continue

                try:
                    yield JobPosting(
                        title=title_text,
                        company=company.get_text(strip=True),
                        location=job_location_text,
                        url=url,
                        company_url=company_url,
                        source=self.name,
                        job_id=f"{self.name}:{stable_key}",
                        posted_at=posted_at,
                        required_years=required_years,
                        description=description,
                    )
                except ValidationError as e:
                    log.debug("skipping malformed card: %s", e)
                    continue

            log.info("linkedin: fetched page %d", page)
            time.sleep(self.delay)


class XingSource(JobSource):
    """Xing's job search (xing.com/jobs/search) — HTML, not a public API.

    Same trade-off documented on LinkedInSource applies here: no ToS-clean
    JSON endpoint exists for job search (unlike Arbeitnow), so this parses
    server-rendered HTML with real, hard-coded selectors, and will break
    when Xing changes its markup.

    Confirmed live before writing a single selector here (Xing is a
    styled-components React app — its CSS classes carry a stable,
    human-readable prefix plus a hashed suffix that changes on redeploy,
    e.g. "job-teaser-list-item-styles__Company-sc-614863cf-11 fJsoJC" — so
    every selector below matches on the stable PREFIX via `class*=`, never
    the full hashed class):

      - results are fully present in the plain GET response (confirmed via
        `requests.get` directly, not just in a rendered browser) — no
        headless browser needed, same as ArbeitnowSource/LinkedInSource
      - each result card: `article[data-testid='job-search-result']`
      - title: `h2[data-testid='job-teaser-list-title']`
      - company: `p[class*='job-teaser-list-item-styles__Company']`
      - location: first text node of the `p` inside
        `div[class*='multi-location-display']` (a "+N weitere" `<b>` tag
        for additional locations sits alongside it and must be excluded)
      - native one-click apply ("Einfach bewerben"/"Easy apply") is
        signalled by the presence of `[data-testid='apply-button']` on the
        card; its absence means the job is an external-site redirect
        ("Zur Arbeitgeber-Website"/"Visit employer website") — carried
        through as `easy_apply` in `application_notes`-free form via the
        job_id prefix so downstream code can tell them apart without
        re-fetching the page.
      - the server does not send a charset in its Content-Type header, so
        `requests` falls back to ISO-8859-1 and mangles every €/– — must
        set `res.encoding = "utf-8"` explicitly before parsing.
    """

    name = "xing"
    BASE_URL = "https://www.xing.com/jobs/search"
    _EASY_APPLY_TEXT = re.compile(r"einfach bewerben|easy apply", re.I)

    def _fetch_description(self, url: str) -> Optional[str]:
        """Full posting text — search cards carry only a short teaser."""
        res = self.client.get(url)
        if res is None:
            return None
        res.encoding = "utf-8"
        soup = BeautifulSoup(res.text, "html.parser")
        desc = soup.select_one("[class*='description-module__DescriptionWrapper']")
        return desc.get_text(" ", strip=True) if desc else None

    def fetch(
        self,
        keywords: str,
        location: str,
        num_pages: int,
        since_hours: Optional[float] = None,
    ) -> Iterator[JobPosting]:
        # Xing's search has no server-side "posted within" filter exposed
        # here (unlike LinkedIn's f_TPR) — since_hours is enforced by
        # JobScraper.run filtering on posted_at afterward, same as Arbeitnow.
        #
        # Unlike LinkedIn (f_WT=2) or Arbeitnow (a `remote` boolean field),
        # Xing has no confirmed remote facet in this scraper — its search
        # HTML hasn't been inspected for one (see the class docstring: every
        # selector here was checked live before being written, and this
        # isn't). A "Remote" search here still only does the plain text
        # match below, which Xing's location field may not satisfy — flag
        # that loudly rather than let it silently return nothing useful.
        if location.strip().lower() == "remote":
            log.warning(
                "xing: no verified remote-work filter for this source — "
                "'Remote' is being sent as a location text query and may "
                "return few or no results"
            )
        for page in range(1, num_pages + 1):
            params = {"keywords": keywords, "location": location, "page": page}
            res = self.client.get(self.BASE_URL, params=params)
            if res is None:
                continue
            res.encoding = "utf-8"

            soup = BeautifulSoup(res.text, "html.parser")
            seen_hrefs = set()
            for card in soup.select("[data-testid='job-search-result']"):
                link = card.select_one("a[href^='/jobs/']")
                title_el = card.select_one("[data-testid='job-teaser-list-title']")
                if not (link and title_el):
                    continue
                href = link.get("href")
                # The same card renders more than once in the DOM (desktop +
                # mobile action-button variants share one <article> in some
                # layouts, confirmed live) — dedupe within a page by href.
                if not href or href in seen_hrefs:
                    continue
                seen_hrefs.add(href)

                title_text = title_el.get_text(strip=True)
                if keywords and not _title_matches_keywords(title_text, keywords):
                    continue

                company_el = card.select_one(
                    "[class*='job-teaser-list-item-styles__Company']"
                )
                loc_container = card.select_one("[class*='multi-location-display']")
                location_text = None
                if loc_container:
                    loc_p = loc_container.find("p")
                    if loc_p:
                        # First text node only — the "+N weitere" <b> tag is
                        # a sibling inside the same <p>, not the location.
                        first_text = next(loc_p.stripped_strings, "")
                        location_text = first_text or None

                # Xing's `location` search box is a fuzzy geo query too — see
                # the matching check in LinkedInSource.fetch for why this is
                # re-verified against what the card itself displays.
                if not _location_matches(location, location_text):
                    continue

                full_url = f"https://www.xing.com{href}" if href.startswith("/") else href
                job_id = f"{self.name}:{href.rsplit('-', 1)[-1] if '-' in href else href}"

                # Whether this card shows "Easy apply" is NOT carried into
                # JobPosting: fit_reasoning gets overwritten by
                # job_rating.rate_job_fit before apply time (confirmed in
                # JobPosting's own docstring — "filled in after scraping"),
                # so anything stashed there would be silently lost exactly
                # when it's needed. XingEasyApplyBot instead checks for the
                # apply button live on the job page itself, the same way
                # LinkedInEasyApplyBot doesn't trust scraped metadata either.

                description = None
                if self.fetch_descriptions:
                    description = self._fetch_description(full_url)
                    time.sleep(self.detail_delay)

                try:
                    yield JobPosting(
                        title=title_text,
                        company=company_el.get_text(strip=True) if company_el else "",
                        location=location_text,
                        url=full_url,
                        source=self.name,
                        job_id=job_id,
                        description=description,
                    )
                except ValidationError as e:
                    log.debug("skipping malformed xing card: %s", e)
                    continue

            log.info("xing: fetched page %d", page)
            time.sleep(self.delay)

    def __init__(
        self,
        client: Optional[HttpClient] = None,
        delay: float = 2.0,
        detail_delay: float = 1.0,
        fetch_descriptions: bool = True,
    ):
        super().__init__(client=client, delay=delay)
        self.detail_delay = detail_delay
        self.fetch_descriptions = fetch_descriptions


# --------------------------------------------------------------------------- #
# 4. Persistence                                                              #
# --------------------------------------------------------------------------- #
class JobStore:
    """SQLite store. `INSERT OR IGNORE` on the job_id primary key gives us
    de-duplication for free — re-running the scraper won't create duplicates.
    """

    def __init__(self, path: str = "jobs.db"):
        self.path = path
        # All jobs saved between begin_fetch() and the end of that scrape
        # share one first_seen, which is what makes "show me the last fetch"
        # mean a batch rather than a single row.
        self._fetch_stamp: Optional[str] = None
        self._init_db()

    def begin_fetch(self) -> str:
        """Open a new fetch batch. Every save() until the next call to this
        records the same first_seen."""
        self._fetch_stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
        return self._fetch_stamp

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path)
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def _init_db(self) -> None:
        with self._conn() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    job_id              TEXT PRIMARY KEY,
                    title               TEXT NOT NULL,
                    company             TEXT NOT NULL,
                    location            TEXT,
                    url                 TEXT,
                    source              TEXT NOT NULL,
                    posted_at           TEXT,
                    required_years      INTEGER,
                    description         TEXT,
                    fit_score           INTEGER,
                    fit_reasoning       TEXT,
                    application_status  TEXT,
                    applied_at          TEXT,
                    application_notes   TEXT
                )
                """
            )
            # Upgrade older DBs created before these columns existed.
            existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(jobs)")}
            for col, col_type in (
                ("posted_at", "TEXT"),
                ("required_years", "INTEGER"),
                ("description", "TEXT"),
                ("fit_score", "INTEGER"),
                ("fit_reasoning", "TEXT"),
                ("application_status", "TEXT"),
                ("applied_at", "TEXT"),
                ("application_notes", "TEXT"),
                # WHEN WE FIRST SAW the job, which is not posted_at (when the
                # employer published it). Needed to answer "show me what the
                # last fetch brought in" — a question posted_at cannot answer,
                # since one fetch returns postings from several days.
                ("first_seen", "TEXT"),
                # The computed answer sheet for a job whose submission was
                # blocked by a CAPTCHA, stored as JSON so --finish-captcha
                # can re-fill the form later without paying for the analysis
                # a second time. See save_captcha_pending.
                ("pending_answer_sheet", "TEXT"),
            ):
                if col not in existing_cols:
                    conn.execute(f"ALTER TABLE jobs ADD COLUMN {col} {col_type}")

            # Rows that predate first_seen get one shared sentinel rather than
            # a guessed time. They then group as a single "before tracking
            # started" batch, which is true, instead of scattering through the
            # timeline and making the newest-fetch filter meaningless.
            conn.execute(
                "UPDATE jobs SET first_seen = ? WHERE first_seen IS NULL",
                ("0000-00-00T00:00:00",),
            )

    def save(self, job: JobPosting) -> bool:
        """Insert one job. Returns True if it was new, False if a duplicate."""
        with self._conn() as conn:
            cur = conn.execute(
                """
                INSERT OR IGNORE INTO jobs
                    (job_id, title, company, location, url, source, posted_at,
                     required_years, description, fit_score, fit_reasoning,
                     application_status, applied_at, application_notes, first_seen)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job.job_id,
                    job.title,
                    job.company,
                    job.location,
                    job.url,
                    job.source,
                    job.posted_at.isoformat() if job.posted_at else None,
                    job.required_years,
                    job.description,
                    job.fit_score,
                    job.fit_reasoning,
                    job.application_status,
                    job.applied_at.isoformat() if job.applied_at else None,
                    job.application_notes,
                    # ONE stamp for the whole fetch, not per row. Stamping
                    # each insert as it happened put 15 jobs from a single
                    # 38-second scrape on 15 different timestamps, so the
                    # "last fetch" filter matched only the final row.
                    #
                    # INSERT OR IGNORE means a job already seen keeps its
                    # ORIGINAL first_seen, so re-running a search does not
                    # make old jobs look freshly fetched.
                    self._fetch_stamp or datetime.now(timezone.utc).isoformat(timespec="seconds"),
                ),
            )
            return cur.rowcount > 0

    def save_rating(self, job_id: str, score: int, reasoning: str) -> None:
        """Persist a fit_score/fit_reasoning for an already-saved job.

        Pure DB update — the actual LLM call lives in job_rating.py, kept
        separate so this module has no dependency on Anthropic/an API key.
        """
        with self._conn() as conn:
            conn.execute(
                "UPDATE jobs SET fit_score = ?, fit_reasoning = ? WHERE job_id = ?",
                (score, reasoning, job_id),
            )

    def unrated_jobs(self) -> List[JobPosting]:
        """Jobs with a description to rate but no fit_score yet."""
        with self._conn() as conn:
            rows = conn.execute(
                self._SELECT_COLUMNS + " FROM jobs "
                "WHERE fit_score IS NULL AND description IS NOT NULL AND description != ''"
            ).fetchall()
        return [self._row_to_job(r) for r in rows]

    def jobs_by_ids(self, job_ids: List[str]) -> List[JobPosting]:
        """Fetch specific jobs by id, in the order given.

        Deliberately ignores both the fit-score threshold and whether an
        attempt was already recorded: these are jobs a human picked off a
        list by hand, so the automatic filters that exist to choose jobs
        for you have no business overruling that. It also makes retrying a
        single previously-skipped job a one-click operation rather than a
        database edit.
        """
        if not job_ids:
            return []

        # Accept the bare number as well as the stored "linkedin:<id>".
        # The id a person has to hand comes from a job URL or a printed
        # list, and is just digits; matching only the prefixed form meant
        # --jobs silently selected NOTHING and the run then reported "no
        # candidate jobs (fit_score >= 7, not yet attempted)" — a message
        # about a filter that had not even been consulted. Four jobs
        # looked unavailable when they were simply never looked up.
        wanted = list(job_ids)
        lookup = set(wanted)
        for j in wanted:
            if ":" not in j:
                lookup.update(f"{src}:{j}" for src in ("linkedin", "email", "manual"))

        placeholders = ",".join("?" for _ in lookup)
        with self._conn() as conn:
            rows = conn.execute(
                self._SELECT_COLUMNS + f" FROM jobs WHERE job_id IN ({placeholders})",
                list(lookup),
            ).fetchall()

        by_id = {r[5]: self._row_to_job(r) for r in rows}   # r[5] is job_id
        # Also reachable by the bare number, so the caller gets back what
        # it asked for whichever form it used.
        for stored, job in list(by_id.items()):
            if ":" in stored:
                by_id.setdefault(stored.split(":", 1)[1], job)

        found, missing = [], []
        for j in wanted:
            if j in by_id:
                found.append(by_id[j])
            else:
                missing.append(j)
        if missing:
            # Say so. A silently dropped id is indistinguishable from a job
            # that failed, and that is how four jobs were reported as "no
            # candidate jobs" instead of "these ids are not in the database".
            log.warning(
                "--jobs: %d id(s) not found in the database and skipped: %s",
                len(missing), ", ".join(missing),
            )
        return found

    def jobs_to_apply(self, min_fit_score: int = 7) -> List[JobPosting]:
        """Jobs at/above the fit threshold that haven't had an application
        attempted yet — deduplicated by ROLE.

        LinkedIn assigns a fresh job_id to the same posting when it is
        reposted or listed more than once, so INSERT OR IGNORE (keyed on
        job_id) lets the SAME role into the queue many times: a real DB had
        DataAnnotation's "Data Scientist - AI Trainer" 13 times, 4flow's
        consulting role 8 times, T-Systems and BWI 3 times each — 22% of the
        table was duplicate listings. Applying to each in turn wastes runs and,
        worse, sends an employer the same application several times.

        Two guards, both on normalised (company, title):
          * never return a role that ANY listing has already been APPLIED to;
          * collapse the remaining duplicate listings to one representative
            (highest fit, then lowest job_id for a stable choice), so a single
            run cannot fire the same role three times.
        """
        with self._conn() as conn:
            rows = conn.execute(
                self._SELECT_COLUMNS + " FROM jobs j "
                "WHERE j.fit_score >= ? AND j.application_status IS NULL "
                "AND NOT EXISTS ("
                "  SELECT 1 FROM jobs a WHERE a.application_status = 'applied'"
                "  AND LOWER(TRIM(a.company)) = LOWER(TRIM(j.company))"
                "  AND LOWER(TRIM(a.title))   = LOWER(TRIM(j.title))) "
                "AND j.job_id = ("
                "  SELECT b.job_id FROM jobs b"
                "  WHERE b.application_status IS NULL AND b.fit_score >= ?"
                "  AND LOWER(TRIM(b.company)) = LOWER(TRIM(j.company))"
                "  AND LOWER(TRIM(b.title))   = LOWER(TRIM(j.title))"
                "  ORDER BY b.fit_score DESC, b.job_id ASC LIMIT 1)",
                (min_fit_score, min_fit_score),
            ).fetchall()
        return [self._row_to_job(r) for r in rows]

    def save_application_result(self, job_id: str, status: str, notes: Optional[str] = None) -> None:
        """Persist the outcome of an application attempt for an already-saved job.

        Pure DB update — the actual browser/LLM automation lives in
        auto_apply.py/browser_automation.py, kept separate for the same
        reason save_rating() is separate: no Anthropic/Playwright dependency
        belongs in this module.
        """
        stamp = datetime.now(timezone.utc).isoformat()
        with self._conn() as conn:
            conn.execute(
                "UPDATE jobs SET application_status = ?, applied_at = ?, application_notes = ? "
                "WHERE job_id = ?",
                (status, stamp, notes, job_id),
            )
            if status == "applied":
                row = conn.execute(
                    "SELECT company, title FROM jobs WHERE job_id = ?", (job_id,)
                ).fetchone()
                self._append_to_ledger(job_id, row[0] if row else "", row[1] if row else "", stamp)

    # The status of a job that was filled but could not be submitted because
    # a CAPTCHA gate needs a human. It is deliberately NOT "skipped": a
    # skipped job is one nothing more can be done with automatically, whereas
    # this one is ready to finish and only waits for the applicant to solve
    # one challenge. jobs_to_apply() ignores it (it filters on status IS
    # NULL), so a deferred job is not re-attempted by an ordinary run.
    CAPTCHA_PENDING = "captcha_pending"

    def save_captcha_pending(self, job_id: str, answer_sheet: dict, notes: str = "") -> None:
        """Park a job whose form was filled but whose submit is CAPTCHA-gated.

        Stores the answer sheet alongside the status so --finish-captcha can
        re-fill the form from it later, without re-running the LLM analysis.
        """
        stamp = datetime.now(timezone.utc).isoformat()
        try:
            sheet_json = json.dumps(answer_sheet, ensure_ascii=False)
        except (TypeError, ValueError):
            sheet_json = None
        with self._conn() as conn:
            conn.execute(
                "UPDATE jobs SET application_status = ?, applied_at = ?, "
                "application_notes = ?, pending_answer_sheet = ? WHERE job_id = ?",
                (self.CAPTCHA_PENDING, stamp, notes or None, sheet_json, job_id),
            )

    def delete_job(self, job_id: str) -> None:
        """Remove a job row entirely — for a posting the applicant never
        wants to see again."""
        with self._conn() as conn:
            conn.execute("DELETE FROM jobs WHERE job_id = ?", (job_id,))

    def save_form_url(self, job_id: str, form_url: str) -> None:
        """Remember the company's real application-form URL for a job,
        without changing its status.

        Merged into the saved answer sheet under _form_url, so the next
        finish opens it directly instead of walking LinkedIn -> Apply ->
        redirect again — even when the previous attempt did not complete.
        """
        if not form_url:
            return
        with self._conn() as conn:
            row = conn.execute(
                "SELECT pending_answer_sheet FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
            try:
                sheet = json.loads(row[0]) if row and row[0] else {}
            except (TypeError, ValueError):
                sheet = {}
            sheet["_form_url"] = form_url
            conn.execute(
                "UPDATE jobs SET pending_answer_sheet = ? WHERE job_id = ?",
                (json.dumps(sheet, ensure_ascii=False), job_id),
            )

    def dismiss_captcha_job(self, job_id: str) -> None:
        """Remove a job from the CAPTCHA finish list.

        Leaves the job row in place — it just stops matching
        captcha_blocked_jobs, so it disappears from the "Finish CAPTCHA"
        tab. Recorded as skipped with a plain note (no "captcha" wording)
        and its saved answer sheet cleared.
        """
        # The note must NOT contain "captcha" or "human verification", or it
        # would still match captcha_blocked_jobs and the row would reappear.
        with self._conn() as conn:
            conn.execute(
                "UPDATE jobs SET application_status = 'skipped', "
                "application_notes = 'removed from the finish list by the user', "
                "pending_answer_sheet = NULL WHERE job_id = ?",
                (job_id,),
            )

    def captcha_blocked_jobs(self) -> List[Tuple["JobPosting", dict]]:
        """Every job whose ONLY obstacle is a CAPTCHA — ready to finish by
        hand.

        This is a superset of captcha_pending_jobs: it also includes jobs
        that were SKIPPED for a challenge before the deferral feature
        existed (their notes say so), which therefore have no saved answer
        sheet. Those come back with an empty dict, and the finish path
        rebuilds the answers on the spot — so a CAPTCHA job is finishable
        from the UI whether or not it was deferred first.
        """
        out: List[Tuple["JobPosting", dict]] = []
        with self._conn() as conn:
            rows = conn.execute(
                self._SELECT_COLUMNS + " , pending_answer_sheet FROM jobs "
                "WHERE application_status = ? "
                "OR (application_status = 'skipped' AND ("
                "  application_notes LIKE '%captcha%' "
                "  OR application_notes LIKE '%human verification%'))",
                (self.CAPTCHA_PENDING,),
            ).fetchall()
        for row in rows:
            job = self._row_to_job(row[:-1])
            try:
                sheet = json.loads(row[-1]) if row[-1] else {}
            except (TypeError, ValueError):
                sheet = {}
            out.append((job, sheet))
        return out

    def captcha_pending_jobs(self) -> List[Tuple["JobPosting", dict]]:
        """Every job waiting on a CAPTCHA, paired with its saved answer sheet.

        A job whose stored sheet is missing or unreadable is returned with
        an empty dict rather than dropped, so --finish-captcha can still open
        it for a fully manual finish instead of silently losing it.
        """
        out: List[Tuple["JobPosting", dict]] = []
        with self._conn() as conn:
            rows = conn.execute(
                self._SELECT_COLUMNS + " , pending_answer_sheet FROM jobs "
                "WHERE application_status = ?",
                (self.CAPTCHA_PENDING,),
            ).fetchall()
        for row in rows:
            job = self._row_to_job(row[:-1])
            try:
                sheet = json.loads(row[-1]) if row[-1] else {}
            except (TypeError, ValueError):
                sheet = {}
            out.append((job, sheet))
        return out

    # An append-only record of jobs actually applied to, kept OUTSIDE the
    # database on purpose. jobs.db has been replaced twice during this
    # project's life, and each time it took the memory of real, confirmed
    # submissions with it — 13 of them on the second occasion. A lost row
    # is not a cosmetic problem: nothing then stops the bot applying to the
    # same employer a second time, which is visible to them and looks
    # careless in a way no recruiter forgives twice.
    LEDGER_PATH = Path("output") / "applied_ledger.tsv"

    def _append_to_ledger(self, job_id: str, company: str, title: str, stamp: str) -> None:
        try:
            self.LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
            new = not self.LEDGER_PATH.exists()
            with self.LEDGER_PATH.open("a", encoding="utf-8") as fh:
                if new:
                    fh.write("applied_at\tjob_id\tcompany\ttitle\n")
                fh.write(f"{stamp}\t{job_id}\t{company}\t{title}\n")
        except Exception:
            # Never let bookkeeping break a run that has already succeeded.
            pass

    def applied_job_ids(self) -> set:
        """Every job ever applied to, according to the ledger."""
        if not self.LEDGER_PATH.exists():
            return set()
        try:
            lines = self.LEDGER_PATH.read_text(encoding="utf-8").splitlines()[1:]
            return {ln.split("\t")[1] for ln in lines if "\t" in ln}
        except Exception:
            return set()

    def reconcile_ledger(self) -> List[str]:
        """Re-mark anything the ledger says was applied to but the DB does not.

        Runs at startup. If the database is replaced, restored from an old
        copy, or rebuilt by a fresh scrape, this puts the "already applied"
        flags back before any job can be selected for another attempt.

        Returns the job_ids it restored, so a caller can report them.
        """
        known = self.applied_job_ids()
        if not known:
            return []
        restored: List[str] = []
        with self._conn() as conn:
            for job_id in known:
                cur = conn.execute(
                    "UPDATE jobs SET application_status = 'applied', "
                    "application_notes = COALESCE(application_notes, '') || "
                    "' || restored from the applied ledger: this job was applied to in an "
                    "earlier run whose database record was lost. NOT retried.' "
                    "WHERE job_id = ? AND COALESCE(application_status, '') != 'applied'",
                    (job_id,),
                )
                if cur.rowcount:
                    restored.append(job_id)
        return restored

    # Reasons a job should NEVER be retried. Everything else is treated as
    # a transient/environmental outcome worth another attempt.
    #
    # This distinction exists because jobs_to_apply() only ever returns rows
    # whose application_status IS NULL, so ANY recorded outcome removes a job
    # from the queue permanently. That is right for "already applied" and
    # "the posting is closed", and quietly wrong for everything else: a job
    # skipped by a bug that has since been fixed stays excluded forever, and
    # the only way back was hand-editing the database after every fix. In
    # one real audit 17 jobs were stranded this way, four of them the
    # highest-scoring jobs in the whole database.
    # captcha_pending is terminal for --retry on purpose: it is not a
    # failure but a job waiting on the human, and requeuing it to NULL would
    # have an ordinary run re-fill and re-defer it endlessly. It is finished
    # through --finish-captcha, not --retry.
    _TERMINAL_STATUSES = ("applied", "dry_run", "captcha_pending")
    _TERMINAL_NOTE_PATTERNS = (
        "no longer accepting",          # the posting itself is closed
        "requires an account",          # sign-in wall; needs a human once
        "credential field",             # ditto, detected via a password field
        "blocked automated access",     # the site refuses automation outright
        "challenge/captcha detected",   # not solvable, by design
    )

    def requeue_retryable(self) -> List[str]:
        """Clear the recorded outcome of every job that could plausibly
        succeed on another attempt, and return their titles.

        Leaves terminal outcomes untouched so nothing gets applied to twice
        and closed postings aren't retried forever.
        """
        placeholders = ",".join("?" for _ in self._TERMINAL_STATUSES)
        note_filter = " AND ".join(
            "COALESCE(application_notes,'') NOT LIKE ?" for _ in self._TERMINAL_NOTE_PATTERNS
        )
        where = (
            f"application_status IS NOT NULL "
            f"AND application_status NOT IN ({placeholders}) AND {note_filter}"
        )
        params = list(self._TERMINAL_STATUSES) + [f"%{p}%" for p in self._TERMINAL_NOTE_PATTERNS]
        with self._conn() as conn:
            titles = [r[0] for r in conn.execute(f"SELECT title FROM jobs WHERE {where}", params)]
            conn.execute(
                "UPDATE jobs SET application_status = NULL, applied_at = NULL, "
                f"application_notes = NULL WHERE {where}",
                params,
            )
        return titles

    def all_jobs(self) -> List[JobPosting]:
        with self._conn() as conn:
            rows = conn.execute(self._SELECT_COLUMNS + " FROM jobs").fetchall()
        return [self._row_to_job(r) for r in rows]

    _SELECT_COLUMNS = (
        "SELECT title, company, location, url, source, job_id, posted_at, "
        "required_years, description, fit_score, fit_reasoning, "
        "application_status, applied_at, application_notes, first_seen"
    )

    @staticmethod
    def _row_to_job(r: tuple) -> JobPosting:
        return JobPosting(
            title=r[0],
            company=r[1],
            location=r[2],
            url=r[3],
            source=r[4],
            job_id=r[5],
            posted_at=r[6],
            required_years=r[7],
            description=r[8],
            fit_score=r[9],
            fit_reasoning=r[10],
            application_status=r[11],
            applied_at=r[12],
            application_notes=r[13],
            first_seen=r[14],
        )

    def export_excel(self, path: str = "jobs.xlsx", jobs: Optional[List[JobPosting]] = None) -> str:
        """Export jobs (everything in the DB, unless `jobs` is given) to an
        .xlsx file. Returns the path written.

        Lazy-imports pandas/openpyxl so the scraper itself has no hard
        dependency on them if you only ever want the SQLite store.
        """
        import pandas as pd

        rows = jobs if jobs is not None else self.all_jobs()
        df = pd.DataFrame([r.model_dump() for r in rows])
        if "posted_at" in df.columns:
            # Excel/openpyxl can't write timezone-aware datetimes.
            df["posted_at"] = pd.to_datetime(df["posted_at"]).dt.tz_localize(None)
        df.to_excel(path, index=False, engine="openpyxl")
        return path


# --------------------------------------------------------------------------- #
# 5. Orchestrator                                                             #
# --------------------------------------------------------------------------- #
class JobScraper:
    """Ties a source to a store. Doesn't care which source it's given."""

    def __init__(self, source: JobSource, store: Optional[JobStore] = None):
        self.source = source
        self.store = store or JobStore()
        # Aggregated across the whole run_many() batch — lets a caller (e.g.
        # the UI) show *why* a run found few/no new jobs (nothing scraped at
        # all — likely a blocked/empty response from the source — vs. plenty
        # scraped but stale or already saved) instead of just a bare count.
        self.last_run_stats: dict = {}

    def run(
        self,
        keywords: str,
        location: str,
        num_pages: int = 2,
        max_age_hours: Optional[float] = None,
    ) -> List[JobPosting]:
        """Scrape, optionally keeping only postings from the last `max_age_hours`.

        Jobs whose `posted_at` is unknown (the source didn't expose a date)
        are kept rather than silently dropped, since we can't tell if they're
        stale or just missing metadata.
        """
        cutoff = (
            datetime.now(timezone.utc) - timedelta(hours=max_age_hours)
            if max_age_hours is not None
            else None
        )

        new_jobs: List[JobPosting] = []
        seen_this_run = 0
        skipped_stale = 0

        for job in self.source.fetch(keywords, location, num_pages, since_hours=max_age_hours):
            seen_this_run += 1
            if cutoff is not None and job.posted_at is not None and job.posted_at < cutoff:
                skipped_stale += 1
                continue
            if self.store.save(job):
                new_jobs.append(job)

        already_in_db = seen_this_run - skipped_stale - len(new_jobs)
        log.info(
            "done: %d scraped, %d skipped (older than %s), %d new, %d already in db",
            seen_this_run,
            skipped_stale,
            f"{max_age_hours}h" if max_age_hours is not None else "n/a",
            len(new_jobs),
            already_in_db,
        )
        if self.last_run_stats:
            self.last_run_stats["scraped"] += seen_this_run
            self.last_run_stats["skipped_stale"] += skipped_stale
            self.last_run_stats["already_in_db"] += already_in_db
        return new_jobs

    def run_many(
        self,
        titles: List[str],
        locations: Union[str, List[str]],
        num_pages: int = 2,
        max_age_hours: Optional[float] = None,
        on_title_start: Optional[Callable[[str, int, int], None]] = None,
    ) -> List[JobPosting]:
        """Run `run()` once per title per location and aggregate the new jobs.

        Opens ONE fetch batch covering every title/location combination,
        because from the user's point of view clicking "Fetch jobs" once is
        one fetch — not one per search term.

        A single LinkedIn search for one title doesn't surface postings for
        an unrelated title — "Data Scientist" and "ML Engineer" barely
        overlap — so scanning multiple target roles means multiple separate
        searches, not one broader one. Same logic for locations: "USA" and
        "Remote" are separate searches, not a single blended one.

        `locations` may be a single string (back-compat) or a list of
        locations to search across, e.g. ["USA", "Canada", "Remote"].

        `on_title_start(title, index, total)`, if given, fires before each
        title's search — lets a caller (e.g. a UI) show per-title progress
        without duplicating this loop. `index`/`total` count title/location
        combinations, not just titles.
        """
        location_list = [locations] if isinstance(locations, str) else list(locations)
        self.store.begin_fetch()
        self.last_run_stats = {"scraped": 0, "skipped_stale": 0, "already_in_db": 0}
        all_new: List[JobPosting] = []
        combos = [(title, loc) for title in titles for loc in location_list]
        total = len(combos)
        for i, (title, loc) in enumerate(combos, start=1):
            if on_title_start:
                on_title_start(f"{title} ({loc})", i, total)
            log.info("=== searching: %s in %s (%d/%d) ===", title, loc, i, total)
            all_new.extend(self.run(title, loc, num_pages, max_age_hours))
        return all_new


# --------------------------------------------------------------------------- #
# 6. Usage                                                                    #
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    # Windows consoles default to cp1252, which can't encode every character
    # job titles contain (e.g. U+2011 non-breaking hyphen) — crashes print()
    # partway through. The scrape/save already finished by the time we print,
    # so this only affects display, but force UTF-8 so it doesn't crash.
    if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
        sys.stdout.reconfigure(encoding="utf-8")

    # Default: the legitimate JSON API. Swap in LinkedInSource() to use the
    # original scraper instead — same interface, no other changes needed.
    #
    # experience_levels="2,3" -> LinkedIn's Entry level + Associate facets
    #   (junior-level roles, as opposed to Mid-Senior/Director/Executive).
    # max_years=5 -> drop postings whose description states more than 5
    #   years required; a 4-year-experience candidate is a stretch beyond
    #   that. min_years is informational only for now (see LinkedInSource).
    scraper = JobScraper(
        source=LinkedInSource(
            delay=2.0,
            experience_levels=LinkedInSource.ENTRY_ASSOCIATE_LEVELS,
            min_years=2,
            max_years=5,
        )
    )

    # Only keep postings from the last 24 hours; jobs without a detectable
    # posting date are kept (see JobScraper.run docstring). num_pages is
    # lower than a single-title run would use since DEFAULT_JOB_TITLES now
    # means num_pages * len(titles) total page fetches.
    jobs = scraper.run_many(
        titles=DEFAULT_JOB_TITLES,
        locations=["USA", "Canada", "Remote", "Indonesia"],
        num_pages=5,
        max_age_hours=24,
    )

    for job in jobs:
        age = f"{job.posted_at.isoformat()}" if job.posted_at else "unknown"
        years = f"{job.required_years}+ yrs" if job.required_years is not None else "unstated"
        print(f"[{job.source}] {job.title} @ {job.company} | {job.location}")
        print(f"    posted: {age} | required experience: {years}")
        print(f"    {job.url}")

    excel_path = scraper.store.export_excel("jobs.xlsx")
    print(f"\nExported all saved jobs to {excel_path}")