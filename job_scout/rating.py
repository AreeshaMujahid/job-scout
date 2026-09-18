"""Score each job against the CV, and say why in words a person can use."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable, List, Sequence, Tuple

from . import config
from .llm import LLMError, RateLimited, structured
from .models import CandidateProfile, Job, JobRating, RatingBatch

_SYSTEM = """You advise one job seeker on which postings deserve their time.

You get their profile, taken from their CV, and a numbered list of postings.
Rate every posting for THIS person -- not in the abstract.

Score bands:
  90-100  strong  -- meets essentially every requirement, and the role moves
                     their career forward rather than sideways
  70-89   good    -- clear overlap; one or two gaps a cover letter can cover
  50-69   stretch -- real gaps; worth it only if they want this one badly
  0-49    weak    -- wrong field, wrong level, or requirements they cannot meet

Rules that matter:
- why_pick is the whole point of this tool. Every reason must tie something
  specific in the CV to something specific in the posting. "Strong Python
  skills" is worthless. "They built the churn model that went to production at
  Centegy, and this team's first project is productionising a prototype" is
  the standard.
- concerns must be equally concrete: a required language they do not have, a
  seniority gap in years, a stack they have never touched.
- Never credit them with experience the profile does not list. If the posting
  demands Kubernetes and the CV never mentions it, that is a missing skill,
  not a matched one.
- Work authorisation is a hard constraint, not a preference. If the posting
  requires a right to work the candidate does not have, that caps the score in
  the weak band and must appear in concerns -- however good the skills match.
- Score honestly and use the whole range. A page of 90s tells them nothing.
- pitch is one sentence they could open an application with, in their voice.
- Return exactly one rating per posting, and set index to the posting's number.
"""


@dataclass
class RatedJob:
    job: Job
    rating: JobRating

    @property
    def score(self) -> int:
        return self.rating.score


def _profile_block(profile: CandidateProfile, extra_context: str = "") -> str:
    block = (
        f"Name: {profile.name}\n"
        f"Headline: {profile.headline}\n"
        f"Seniority: {profile.seniority} ({profile.years_experience:g} years)\n"
        f"Core skills: {', '.join(profile.core_skills)}\n"
        f"Tools: {', '.join(profile.tools)}\n"
        f"Domains: {', '.join(profile.domains)}\n"
        f"Strengths: {'; '.join(profile.strengths)}\n"
        f"Known gaps: {'; '.join(profile.gaps)}"
    )
    # Things a CV does not say but that decide whether a job is even possible:
    # work authorisation, which cities they can take, what they are looking for.
    if extra_context.strip():
        block += f"\n\nAlso true of this candidate:\n{extra_context.strip()}"
    return block


def _job_block(index: int, job: Job) -> str:
    parts = [
        f"[{index}] {job.title} -- {job.company}",
        f"    Board: {job.source} | Location: {job.location or 'not stated'}"
        f"{' | Remote' if job.remote else ''}"
        f"{' | ' + job.salary if job.salary else ''}",
    ]
    if job.tags:
        parts.append(f"    Tags: {', '.join(job.tags[:12])}")
    body = job.description[: config.DESCRIPTION_CHARS].strip()
    parts.append(f"    Description: {body or '(the board published no description)'}")
    return "\n".join(parts)


def rate_jobs(
    profile: CandidateProfile,
    jobs: Sequence[Job],
    *,
    extra_context: str = "",
    on_progress: Callable[[int, int], None] | None = None,
) -> Tuple[List[RatedJob], List[str]]:
    """Rate every job. Returns the ratings and any batch-level failures.

    Jobs are sent in small batches rather than one call each: one call per job
    would be five times the requests and the same tokens, and one call for all
    of them blurs the reasoning together.
    """
    batches = [
        list(enumerate(jobs))[i : i + config.BATCH_SIZE]
        for i in range(0, len(jobs), config.BATCH_SIZE)
    ]
    if not batches:
        return [], []

    profile_text = _profile_block(profile, extra_context)
    rated: List[RatedJob] = []
    errors: List[str] = []
    done = 0

    def run(batch):
        listing = "\n\n".join(_job_block(i, job) for i, job in batch)
        user = (
            f"CANDIDATE\n{profile_text}\n\n"
            f"POSTINGS ({len(batch)})\n{listing}\n\n"
            f"Rate all {len(batch)} postings."
        )
        return structured(RatingBatch, _SYSTEM, user, max_tokens=8000)

    with ThreadPoolExecutor(max_workers=config.MAX_RATING_WORKERS) as pool:
        futures = {pool.submit(run, batch): batch for batch in batches}
        for future, batch in futures.items():
            by_index = {index: job for index, job in batch}
            try:
                result = future.result()
                for rating in result.ratings:
                    job = by_index.get(rating.index)
                    if job is not None:
                        rating.score = max(0, min(100, rating.score))
                        rated.append(RatedJob(job=job, rating=rating))
            except RateLimited as exc:
                # Every batch fails the same way when a quota is hit, so this
                # is reported once rather than once per batch.
                errors.append(str(exc))
            except LLMError as exc:
                titles = ", ".join(job.title for _, job in batch[:2])
                errors.append(f"Could not rate {len(batch)} jobs ({titles}...): {exc}")
            finally:
                done += len(batch)
                if on_progress:
                    on_progress(min(done, len(jobs)), len(jobs))

    rated.sort(key=lambda r: r.score, reverse=True)
    return rated, list(dict.fromkeys(errors))
