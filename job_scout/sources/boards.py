"""One adapter per job board.

Each returns raw Job objects and nothing else -- no filtering, no ranking.
Relevance and location are decided centrally in __init__.fetch_all, so every
board is judged by the same rules.

Only two of these can search server-side. The rest hand back their latest
postings and expect the caller to do the thinking, which is why fetch_all
pulls several pages from them.
"""
from __future__ import annotations

import os
import re
import shutil
import tempfile
import uuid
from urllib.parse import quote_plus
from datetime import datetime, timedelta, timezone

from bs4 import BeautifulSoup

from typing import Dict, List, Sequence

from ..models import Job
from ._common import get_html, clean_html, get_json, looks_remote, post_json


def _money(low, high, currency: str = "USD") -> str:
    try:
        low, high = int(low or 0), int(high or 0)
    except (TypeError, ValueError):
        return ""
    if not low and not high:
        return ""
    if low and high:
        return f"{currency} {low:,} - {high:,}"
    return f"{currency} {(low or high):,}"


def remotive(queries: Sequence[str], limit: int, location: str = "") -> List[Job]:
    jobs: List[Job] = []
    for query in list(queries)[:3]:  # one HTTP round trip per query
        payload = get_json(
            "https://remotive.com/api/remote-jobs",
            {"search": query, "limit": max(10, limit // 2)},
        )
        for row in payload.get("jobs", []):
            jobs.append(
                Job(
                    source="Remotive",
                    title=row.get("title", ""),
                    company=row.get("company_name", ""),
                    logo=row.get("company_logo") or row.get("company_logo_url") or "",
                    url=row.get("url", ""),
                    location=row.get("candidate_required_location", "Remote"),
                    description=clean_html(row.get("description")),
                    tags=[str(t) for t in row.get("tags") or []],
                    salary=row.get("salary") or "",
                    posted_at=(row.get("publication_date") or "")[:10],
                    remote=True,
                )
            )
    return jobs


def remoteok(queries: Sequence[str], limit: int, location: str = "") -> List[Job]:
    payload = get_json("https://remoteok.com/api")
    jobs = []
    for row in payload:
        # The first element is a legal notice, not a job.
        if not isinstance(row, dict) or not row.get("position"):
            continue
        jobs.append(
            Job(
                source="RemoteOK",
                title=row.get("position", ""),
                company=row.get("company", ""),
                logo=row.get("company_logo") or row.get("logo") or "",
                url=row.get("url") or row.get("apply_url", ""),
                location=row.get("location") or "Remote",
                description=clean_html(row.get("description")),
                tags=[str(t) for t in row.get("tags") or []],
                salary=_money(row.get("salary_min"), row.get("salary_max")),
                posted_at=(row.get("date") or "")[:10],
                remote=True,
            )
        )
    return jobs


def arbeitnow(queries: Sequence[str], limit: int, location: str = "") -> List[Job]:
    """European board, and the only one here with real on-site German jobs."""
    jobs = []
    for page in (1, 2, 3):
        payload = get_json("https://www.arbeitnow.com/api/job-board-api", {"page": page})
        rows = payload.get("data") or []
        if not rows:
            break
        for row in rows:
            jobs.append(
                Job(
                    source="Arbeitnow",
                    title=row.get("title", ""),
                    company=row.get("company_name", ""),
                    url=row.get("url", ""),
                    location=row.get("location") or "",
                    description=clean_html(row.get("description")),
                    tags=[str(t) for t in (row.get("tags") or []) + (row.get("job_types") or [])],
                    posted_at="",
                    remote=bool(row.get("remote")),
                )
            )
    return jobs


def jobicy(queries: Sequence[str], limit: int, location: str = "") -> List[Job]:
    payload = get_json("https://jobicy.com/api/v2/remote-jobs", {"count": 50})
    jobs = []
    for row in payload.get("jobs", []):
        jobs.append(
            Job(
                source="Jobicy",
                title=row.get("jobTitle", ""),
                company=row.get("companyName", ""),
                logo=row.get("companyLogo") or "",
                url=row.get("url", ""),
                location=row.get("jobGeo") or "Remote",
                description=clean_html(row.get("jobDescription") or row.get("jobExcerpt")),
                tags=[str(t) for t in (row.get("jobIndustry") or []) + (row.get("jobLevel") and [row["jobLevel"]] or [])],
                posted_at=(row.get("pubDate") or "")[:10],
                remote=True,
            )
        )
    return jobs


def themuse(queries: Sequence[str], limit: int, location: str = "") -> List[Job]:
    jobs = []
    for page in (0, 1, 2):
        payload = get_json("https://www.themuse.com/api/public/jobs", {"page": page})
        for row in payload.get("results", []):
            locations = [loc.get("name", "") for loc in row.get("locations") or []]
            company = (row.get("company") or {}).get("name", "")
            landing = (row.get("refs") or {}).get("landing_page", "")
            jobs.append(
                Job(
                    source="The Muse",
                    title=row.get("name", ""),
                    company=company,
                    url=landing,
                    location=", ".join(locations),
                    description=clean_html(row.get("contents")),
                    tags=[c.get("name", "") for c in row.get("categories") or []]
                    + [l.get("name", "") for l in row.get("levels") or []],
                    posted_at=(row.get("publication_date") or "")[:10],
                    remote=looks_remote(", ".join(locations)),
                )
            )
    return jobs


def himalayas(queries: Sequence[str], limit: int, location: str = "") -> List[Job]:
    payload = get_json("https://himalayas.app/jobs/api", {"limit": 50})
    jobs = []
    for row in payload.get("jobs", []):
        guid = str(row.get("guid") or "")
        url = guid if guid.startswith("http") else str(row.get("applicationLink") or "")
        jobs.append(
            Job(
                source="Himalayas",
                title=row.get("title", ""),
                company=row.get("companyName", ""),
                url=url,
                location=", ".join(str(x) for x in row.get("locationRestrictions") or []) or "Remote",
                description=clean_html(row.get("description") or row.get("excerpt")),
                tags=[str(t) for t in (row.get("categories") or []) + (row.get("seniority") or [])],
                salary=_money(row.get("minSalary"), row.get("maxSalary"), row.get("currency") or "USD"),
                posted_at=str(row.get("pubDate") or "")[:10],
                remote=True,
            )
        )
    return jobs


# Display name -> (adapter, is this board remote-only)
def adzuna(queries: Sequence[str], limit: int, location: str = "") -> List[Job]:
    """Adzuna, which is the only real answer to on-site German coverage here.

    Four of the six other boards are remote-first; the code already noted
    Arbeitnow as "the only one here with real on-site German jobs", and a
    measured search bore that out -- three of six boards returned nothing
    usable for a Germany search.

    Needs a free key (ADZUNA_APP_ID / ADZUNA_APP_KEY from
    developer.adzuna.com). Without one this returns nothing rather than
    raising, the same way the borrowed scrapers vanish when linkedin.py is
    absent: a missing optional source should quietly not be there, not take
    the search down.

    Unlike the others, this one actually searches server-side, so each query
    is a request and the results come back already on topic.
    """
    app_id = os.getenv("ADZUNA_APP_ID", "").strip()
    app_key = os.getenv("ADZUNA_APP_KEY", "").strip()
    if not (app_id and app_key):
        return []

    country = os.getenv("ADZUNA_COUNTRY", "de").strip().lower()
    jobs: List[Job] = []

    # One request per query, capped: this is a keyed API with a daily
    # allowance, and a profile with eight target roles should not spend it
    # all on one search.
    for query in list(queries)[:5]:
        if not query.strip():
            continue
        payload = get_json(
            f"https://api.adzuna.com/v1/api/jobs/{country}/search/1",
            {
                "app_id": app_id,
                "app_key": app_key,
                "results_per_page": min(50, max(10, limit)),
                "what": query,
                # The searcher's own location, not the whole country. Without
                # this Adzuna returned the nationally most relevant results
                # and the pipeline then threw away everything outside the
                # city -- paying a request for jobs it was about to discard.
                # Skipped when the "location" is the country the endpoint
                # already covers: asking the German API for jobs `where=
                # Germany` matches no place at all and returns nothing.
                **(
                    {"where": location}
                    if location.strip()
                    and location.strip().lower() not in ("germany", "deutschland", country)
                    else {}
                ),
                "content-type": "application/json",
            },
        )
        for row in payload.get("results") or []:
            area = row.get("location") or {}
            salary_min = row.get("salary_min")
            salary_max = row.get("salary_max")
            jobs.append(
                Job(
                    source="Adzuna",
                    title=row.get("title", "") or "",
                    company=(row.get("company") or {}).get("display_name", "") or "",
                    url=row.get("redirect_url", "") or "",
                    location=area.get("display_name", "") or "",
                    description=clean_html(row.get("description")),
                    tags=[str(t) for t in (area.get("area") or [])],
                    # Adzuna gives numbers where the others give prose; the
                    # salary filter reads both, so it is written as prose.
                    salary=(
                        f"{int(salary_min):,} - {int(salary_max):,}"
                        if salary_min and salary_max
                        else ""
                    ),
                    posted_at=(row.get("created") or "")[:10],
                    remote="remote" in (row.get("title", "") + area.get("display_name", "")).lower(),
                )
            )
    return jobs


_STEPSTONE_AGO = re.compile(r"vor\s+(\d+)\s+(Tag|Tagen|Stunde|Stunden|Minute|Minuten)", re.I)


def _stepstone_posted(text: str) -> str:
    """Turn StepStone's "vor 2 Tagen" into a date the freshness filter reads."""
    match = _STEPSTONE_AGO.search(text or "")
    if not match:
        return ""
    amount, unit = int(match.group(1)), match.group(2).lower()
    days = amount if unit.startswith("tag") else 0
    return (datetime.now(timezone.utc).date() - timedelta(days=days)).isoformat()


def stepstone(queries: Sequence[str], limit: int, location: str = "") -> List[Job]:
    """StepStone, Germany's largest board, read from its own search pages.

    There is no public API, so this parses the result list. Two things make
    that defensible rather than brittle: the path-based search URL is not
    disallowed by their robots.txt (only /public-api/, the legacy /5/ result
    pages and root query strings are), and every field is read from a stable
    `data-at` test hook rather than from class names or DOM position.

    Searched nationwide per query and narrowed afterwards by the pipeline's
    own location filter, because a board adapter is only handed the queries
    and a limit -- it never sees where the user wants to work.

    A failure here returns what it has rather than raising. fetch_all already
    isolates a dead board, and half a page of StepStone beats none of it.
    """
    jobs: List[Job] = []
    seen_urls = set()

    # Worked out once, up here, because the card loop below rebinds the name
    # `location` to an element -- doing this inside the loop crashed on the
    # second query with "'NoneType' object is not callable".
    place = re.sub(r"[^a-z0-9]+", "-", (location or "").strip().lower()).strip("-")
    # The country is not a place on StepStone: it is the whole site.
    if place in ("germany", "deutschland", "de"):
        place = ""

    for query in list(queries)[:3]:
        slug = re.sub(r"[^a-z0-9]+", "-", query.strip().lower()).strip("-")
        if not slug:
            continue

        for page in (1, 2):
            url = (
                f"https://www.stepstone.de/jobs/{slug}/in-{place}"
                if place
                else f"https://www.stepstone.de/jobs/{slug}"
            )
            try:
                html = get_html(url, {"page": page} if page > 1 else None)
            except Exception:
                break
            if not html:
                break

            cards = BeautifulSoup(html, "html.parser").select('[data-at="job-item"]')
            if not cards:
                break

            for card in cards:
                title_link = card.select_one('a[data-at="job-item-title"]')
                if not title_link:
                    continue
                href = title_link.get("href") or ""
                full = href if href.startswith("http") else f"https://www.stepstone.de{href}"
                if full in seen_urls:
                    continue
                seen_urls.add(full)

                company = card.select_one('[data-at="job-item-company-name"]')
                location = card.select_one('[data-at="job-item-location"]')
                ago = card.select_one('[data-at="job-item-timeago"]')
                snippet = card.select_one('[data-at="jobcard-content"]')

                jobs.append(
                    Job(
                        source="StepStone",
                        title=title_link.get_text(strip=True),
                        company=company.get_text(strip=True) if company else "",
                        url=full,
                        location=location.get_text(strip=True) if location else "",
                        description=snippet.get_text(" ", strip=True) if snippet else "",
                        tags=[],
                        posted_at=_stepstone_posted(ago.get_text(strip=True) if ago else ""),
                        remote="remote" in (title_link.get_text(strip=True) + " " +
                                            (location.get_text(strip=True) if location else "")).lower(),
                    )
                )
            if len(jobs) >= limit * 2:
                return jobs
    return jobs


def jooble(queries: Sequence[str], limit: int, location: str = "") -> List[Job]:
    """Jooble, an aggregator that carries listings from across the German
    market -- including postings that also appear on Indeed.

    Indeed itself cannot be read directly: every route answers 403 behind a
    bot challenge, and their publisher API was retired. Getting past that
    would mean defeating bot detection, which is both off-limits and futile
    -- challenge pages change weekly. An aggregator that licenses the same
    listings is the route that works and keeps working.

    Needs a free key (jooble.org/api/about). Without one it contributes
    nothing rather than raising, exactly like Adzuna above.
    """
    key = os.getenv("JOOBLE_API_KEY", "").strip()
    if not key:
        return []

    where = os.getenv("JOOBLE_LOCATION", "Deutschland").strip()
    jobs: List[Job] = []
    seen = set()

    for query in list(queries)[:3]:
        if not query.strip():
            continue
        try:
            payload = post_json(
                f"https://jooble.org/api/{key}",
                {"keywords": query, "location": where, "ResultOnPage": min(50, max(10, limit))},
            )
        except Exception:
            continue

        for row in payload.get("jobs") or []:
            url = row.get("link") or ""
            if not url or url in seen:
                continue
            seen.add(url)
            jobs.append(
                Job(
                    source="Jooble",
                    title=row.get("title", "") or "",
                    company=row.get("company", "") or "",
                    url=url,
                    location=row.get("location", "") or "",
                    description=clean_html(row.get("snippet")),
                    tags=[],
                    salary=row.get("salary", "") or "",
                    # "2026-09-18T00:00:00.0000000" -> the date part.
                    posted_at=(row.get("updated") or "")[:10],
                    remote="remote" in ((row.get("title") or "") + (row.get("location") or "")).lower(),
                )
            )
    return jobs


_INDEED_CARDS = """() => [...document.querySelectorAll('.job_seen_beacon')].map(card => {
    const link = card.querySelector('a[data-jk]');
    const pick = sel => { const el = card.querySelector(sel); return el ? el.innerText.trim() : ''; };
    return {
      title: link ? link.innerText.trim() : '',
      company: pick('[data-testid="company-name"]'),
      location: pick('[data-testid="text-location"]'),
      jk: link ? link.getAttribute('data-jk') : '',
      snippet: pick('[data-testid="belowJobSnippet"]').slice(0, 400)
    };
  })"""


# Written by an adapter when something happened that the person should hear
# about, and read back by fetch_all. Keyed by board, and each board writes
# only its own key, so the parallel fetch needs no lock.
NOTES: Dict[str, str] = {}

# What a Cloudflare interstitial looks like from the page's side. Matching on
# the challenge's own furniture rather than on wording, since the text is
# localised and the wording changes.
_CHALLENGE = (
    "#challenge-form, #cf-challenge-running, .cf-turnstile, "
    "iframe[src*='challenges.cloudflare.com'], "
    "iframe[title*='Cloudflare'], iframe[title*='human']"
)


def _challenged(page) -> bool:
    """Is a human check on screen, rather than an empty result?"""
    try:
        if page.query_selector(_CHALLENGE):
            return True
        title = (page.title() or "").lower()
        return "just a moment" in title or "verification" in title
    except Exception:
        return False


def _wait_out_challenge(page, seconds: int = 20) -> bool:
    """Wait briefly in case the interstitial clears itself. It usually won't.

    An earlier version of this asked the person to tick the box, on the
    reasoning that the window is open in front of them. That advice was
    wrong. Playwright's Chromium reports `navigator.webdriver === true` --
    measured, not assumed -- and Cloudflare reads that flag, so the check
    fails on what the browser *is*, not on who clicks it. Someone can tick
    the box all afternoon and never pass.

    Hiding those automation markers is the only thing that would change the
    answer, and that is defeating bot detection, which this project does not
    do. So this waits out the non-interactive kind, which does clear on its
    own after a few seconds, and otherwise reports honestly and moves on
    rather than holding the run hostage to a box that cannot be ticked.
    """
    try:
        page.wait_for_selector(".job_seen_beacon", timeout=seconds * 1_000)
        return True
    except Exception:
        return False


def indeed(queries: Sequence[str], limit: int, location: str = "") -> List[Job]:
    """Indeed, read through a real browser window.

    Off unless INDEED_ENABLED=true, because this one is intrusive in a way
    none of the others are: **a visible browser window opens on your screen**
    for the duration. That is not a stylistic choice. Indeed answers 403 to
    every server-side request, and to a headless browser -- measured, both.
    A normal visible window gets a normal 200. No fingerprint spoofing and no
    proxies are involved; the difference is simply whether a real window is
    on screen.

    Two consequences worth knowing before switching it on:

    * It cannot run on a server. Docker, a VM, anything without a display
      will get the 403 that headless gets. This is a local-machine source.
    * One page per query, deliberately. Indeed's robots.txt disallows URLs
      containing `&start=`, which is how their pagination works, so the
      first page is where this stops -- about fifteen postings per query.

    A fresh browser profile each run, because a reused one gets blocked
    after a while -- also measured. The profile is deleted afterwards.
    """
    if os.getenv("INDEED_ENABLED", "").strip().lower() not in ("1", "true", "yes"):
        return []

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return []

    domain = os.getenv("INDEED_DOMAIN", "de.indeed.com").strip()
    where = location.strip() or os.getenv("INDEED_LOCATION", "Deutschland").strip()
    jobs: List[Job] = []
    seen = set()

    profile = os.path.join(tempfile.gettempdir(), "indeed-" + uuid.uuid4().hex[:10])
    try:
        with sync_playwright() as p:
            ctx = p.chromium.launch_persistent_context(profile, headless=False)
            try:
                page = ctx.pages[0] if ctx.pages else ctx.new_page()
                for query in list(queries)[:3]:
                    if not query.strip():
                        continue
                    url = (
                        f"https://{domain}/jobs?q={quote_plus(query)}"
                        f"&l={quote_plus(where)}"
                    )
                    try:
                        page.goto(url, wait_until="domcontentloaded", timeout=45_000)
                        page.wait_for_selector(".job_seen_beacon", timeout=20_000)
                    except Exception:
                        # Either genuinely empty, or a human check is sitting
                        # in the window. Those need opposite responses, so
                        # look before giving up.
                        if not _challenged(page):
                            continue
                        if not _wait_out_challenge(page):
                            NOTES["Indeed"] = (
                                "Indeed put a Cloudflare human check in front of this "
                                "search, so nothing was read from it. Ticking the box "
                                "will not help: the check fails on the browser being "
                                "automated, not on who clicks. Untick Indeed and use "
                                "StepStone and Adzuna, which have no such barrier."
                            )
                            break

                    for row in page.evaluate(_INDEED_CARDS):
                        jk = (row.get("jk") or "").strip()
                        if not jk or jk in seen or not row.get("title"):
                            continue
                        seen.add(jk)
                        jobs.append(
                            Job(
                                source="Indeed",
                                title=row["title"],
                                company=row.get("company", ""),
                                url=f"https://{domain}/viewjob?jk={jk}",
                                location=row.get("location", ""),
                                description=row.get("snippet", ""),
                                tags=[],
                                posted_at="",
                                remote="remote" in (
                                    row["title"] + " " + row.get("location", "")
                                ).lower(),
                            )
                        )
                    if len(jobs) >= limit * 2:
                        break
            finally:
                ctx.close()
    except Exception:
        return jobs  # whatever was collected before it broke
    finally:
        shutil.rmtree(profile, ignore_errors=True)

    return jobs


BOARDS = {
    "Remotive": (remotive, True),
    "RemoteOK": (remoteok, True),
    "Arbeitnow": (arbeitnow, False),
    "Jobicy": (jobicy, True),
    "The Muse": (themuse, False),
    "Himalayas": (himalayas, True),
    # Optional: present only when ADZUNA_APP_ID/KEY are set.
    "Adzuna": (adzuna, False),
    # Germany's largest board. Read from its search pages -- see stepstone().
    "StepStone": (stepstone, False),
    # Optional: present only when JOOBLE_API_KEY is set.
    "Jooble": (jooble, False),
    # Opt-in only: opens a visible browser window. See indeed().
    "Indeed": (indeed, False),
}
