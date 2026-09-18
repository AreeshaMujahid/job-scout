"""One adapter per job board.

Each returns raw Job objects and nothing else -- no filtering, no ranking.
Relevance and location are decided centrally in __init__.fetch_all, so every
board is judged by the same rules.

Only two of these can search server-side. The rest hand back their latest
postings and expect the caller to do the thinking, which is why fetch_all
pulls several pages from them.
"""
from __future__ import annotations

from typing import List, Sequence

from ..models import Job
from ._common import clean_html, get_json, looks_remote


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


def remotive(queries: Sequence[str], limit: int) -> List[Job]:
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


def remoteok(queries: Sequence[str], limit: int) -> List[Job]:
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


def arbeitnow(queries: Sequence[str], limit: int) -> List[Job]:
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


def jobicy(queries: Sequence[str], limit: int) -> List[Job]:
    payload = get_json("https://jobicy.com/api/v2/remote-jobs", {"count": 50})
    jobs = []
    for row in payload.get("jobs", []):
        jobs.append(
            Job(
                source="Jobicy",
                title=row.get("jobTitle", ""),
                company=row.get("companyName", ""),
                url=row.get("url", ""),
                location=row.get("jobGeo") or "Remote",
                description=clean_html(row.get("jobDescription") or row.get("jobExcerpt")),
                tags=[str(t) for t in (row.get("jobIndustry") or []) + (row.get("jobLevel") and [row["jobLevel"]] or [])],
                posted_at=(row.get("pubDate") or "")[:10],
                remote=True,
            )
        )
    return jobs


def themuse(queries: Sequence[str], limit: int) -> List[Job]:
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


def himalayas(queries: Sequence[str], limit: int) -> List[Job]:
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
BOARDS = {
    "Remotive": (remotive, True),
    "RemoteOK": (remoteok, True),
    "Arbeitnow": (arbeitnow, False),
    "Jobicy": (jobicy, True),
    "The Muse": (themuse, False),
    "Himalayas": (himalayas, True),
}
