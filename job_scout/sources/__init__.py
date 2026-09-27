"""Search every board at once, then keep what fits."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Dict, List, Sequence, Tuple

from ..models import Job
from ._common import location_ok, relevance
from . import filters
from .boards import BOARDS, NOTES

__all__ = ["BOARDS", "FetchReport", "fetch_all"]


@dataclass
class FetchReport:
    """What each board actually contributed, so a thin result is explainable."""

    fetched: Dict[str, int] = field(default_factory=dict)
    kept: Dict[str, int] = field(default_factory=dict)
    errors: Dict[str, str] = field(default_factory=dict)
    duplicates: int = 0
    off_topic: int = 0
    wrong_location: int = 0
    # Keyed by reason -- "stale", "underpaid", "blocked", "no_sponsorship" --
    # so the caller can name the filter that emptied a search rather than
    # reporting one opaque total.
    rejected: Dict[str, int] = field(default_factory=dict)

    @property
    def total_fetched(self) -> int:
        return sum(self.fetched.values())


def fetch_all(
    queries: Sequence[str],
    *,
    location: str = "",
    remote_only: bool = False,
    boards: Sequence[str] | None = None,
    min_relevance: int = 2,
    limit: int = 60,
    max_age_days: int | None = None,
    min_salary: int | None = None,
    blocked_companies: Sequence[str] = (),
    needs_sponsorship: bool = False,
) -> Tuple[List[Job], FetchReport]:
    """Fetch from every selected board and return the jobs worth rating.

    Boards are queried in parallel: they are unrelated services and the
    slowest one otherwise sets the wait for all six.
    """
    chosen = [name for name in (boards or BOARDS) if name in BOARDS]
    report = FetchReport()
    # Notes are per-run, not cumulative: a board that was challenged last
    # time and sailed through this time must not still be complaining.
    for name in chosen:
        NOTES.pop(name, None)

    # A remote-only search has nothing to gain from boards that are not
    # remote-first, but they still carry remote listings, so they stay in.
    with ThreadPoolExecutor(max_workers=len(chosen) or 1) as pool:
        futures = {
            # Location goes to the boards, not just to the filter that runs
            # afterwards. Three of them can search by place, and were being
            # asked for the whole country and then filtered.
            name: pool.submit(BOARDS[name][0], queries, limit, location)
            for name in chosen
        }
        raw: List[Job] = []
        for name, future in futures.items():
            try:
                found = future.result()
            except Exception as exc:  # one dead board must not end the search
                report.errors[name] = f"{type(exc).__name__}: {exc}"
                report.fetched[name] = 0
                continue
            report.fetched[name] = len(found)
            raw.extend(found)
            # Something the person should hear about, even though the board
            # did not fail outright -- a human check left unticked, say.
            note = NOTES.pop(name, "")
            if note:
                report.errors[name] = note

    seen: set[str] = set()
    kept: List[Job] = []

    for job in raw:
        if not job.title or not job.url:
            continue

        job.relevance = relevance(job.title, job.tags, job.description, queries)
        if job.relevance < min_relevance:
            report.off_topic += 1
            continue

        if not location_ok(job.location, job.remote, location, remote_only):
            report.wrong_location += 1
            continue

        # Filters the boards cannot apply themselves -- age, pay, employers
        # the user is done with, and postings that say outright they will not
        # sponsor. Each counted separately so an empty search can say which
        # one emptied it.
        rejected = filters.keep(
            job,
            max_age_days=max_age_days,
            min_salary=min_salary,
            blocked_companies=blocked_companies,
            needs_sponsorship=needs_sponsorship,
        )
        if rejected:
            report.rejected[rejected] = report.rejected.get(rejected, 0) + 1
            continue

        if job.key in seen:
            report.duplicates += 1
            continue

        seen.add(job.key)
        kept.append(job)
        report.kept[job.source] = report.kept.get(job.source, 0) + 1

    # Best title matches first, then freshest. Rating is the expensive step,
    # so whatever is at the top of this list is what gets the budget.
    kept.sort(key=lambda j: (j.relevance, j.posted_at), reverse=True)
    return kept[:limit], report
