"""The whole flow in one call: CV in, ranked jobs with reasons out."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, List, Sequence

from .cv_reader import read_cv
from .models import CandidateProfile
from .profile import build_profile
from .rating import RatedJob, rate_jobs
from .sources import FetchReport, fetch_all


@dataclass
class ScoutResult:
    profile: CandidateProfile
    rated: List[RatedJob]
    report: FetchReport
    queries: List[str]
    errors: List[str]
    cv_text: str = ""


def run(
    cv_bytes: bytes,
    filename: str,
    *,
    location: str = "",
    remote_only: bool = False,
    boards: Sequence[str] | None = None,
    extra_queries: Sequence[str] = (),
    max_jobs: int = 25,
    min_relevance: int = 2,
    on_status: Callable[[str], None] | None = None,
    on_progress: Callable[[int, int], None] | None = None,
) -> ScoutResult:
    """Read the CV, search the boards it points at, and rate what comes back."""
    say = on_status or (lambda _: None)

    say("Reading the CV...")
    cv_text = read_cv(cv_bytes, filename)

    say("Working out what to search for...")
    profile = build_profile(cv_text)

    queries = list(dict.fromkeys([*profile.search_queries, *extra_queries]))

    say(f"Searching {len(boards) if boards else 6} boards for {len(queries)} role titles...")
    jobs, report = fetch_all(
        queries,
        location=location,
        remote_only=remote_only,
        boards=boards,
        min_relevance=min_relevance,
        limit=max_jobs,
    )

    if not jobs:
        return ScoutResult(profile, [], report, queries, [], cv_text)

    say(f"Rating {len(jobs)} jobs against the CV...")
    rated, errors = rate_jobs(profile, jobs, on_progress=on_progress)

    return ScoutResult(profile, rated, report, queries, errors, cv_text)
