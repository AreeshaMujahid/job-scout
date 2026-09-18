"""Work out what the inbox says about applications the user is tracking.

The output moves someone's tracker without them asking, so the standard for
acting is deliberately higher than for the rest of this project: a wrong
"rejected" makes a person stop chasing a live application. Everything here
is built to fail towards "no_change" rather than towards a confident guess.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Sequence, Tuple

from .inbox import InboxMessage
from .llm import structured
from .models import ApplicationUpdate, ApplicationUpdateBatch

_SYSTEM = """You read a job seeker's e-mail and decide what it means for the
applications they are tracking.

You get a numbered list of TRACKED APPLICATIONS (company, role, when they
applied) and a numbered list of recent MESSAGES from their inbox. For every
message that clearly concerns one of the tracked applications, return one
update naming that application's index.

What the statuses mean:
- applied       the employer acknowledges receiving it ("we have received
                your application"). Confirms it landed; nothing more.
- interviewing  they want to talk, at any stage -- phone screen, recruiter
                call, online assessment, take-home task, panel. An invitation
                to schedule counts.
- offer         an actual offer of the job.
- rejected      they are not proceeding. "We have decided to move forward
                with other candidates", "leider", "unfortunately".
- no_change     the message concerns this application but moves nothing: a
                generic "still under review", a survey, a newsletter.

Rules that matter more than coverage:
- Return an update ONLY when the message is about a specific tracked
  application. A job alert advertising new roles at the same company is not
  an update about the application. When in doubt, leave it out entirely --
  a missed update costs the user nothing, a wrong one costs them a job they
  stop chasing.
- Match on the employer AND the role. Companies run many openings at once; a
  rejection for a different role at the same company is not this one's
  rejection. If the message names no role and the user has several
  applications with that company, do not guess -- omit it.
- An automated "we have received your application" is `applied`, never
  `interviewing`, however warm the wording.
- A recruiter cold-approaching about a DIFFERENT role is not an update to a
  tracked application. Omit it.
- evidence must quote the actual sentence that decided it, from the message.
  Never paraphrase and never invent one; if no sentence in the message says
  it plainly, the confidence is not high.
- confidence: high only when the message states the outcome for this role
  unambiguously. Mass-mailed "we keep your CV on file" is low.
"""


@dataclass
class TrackedApplication:
    """One application the web app is tracking, as the classifier sees it."""

    job_id: str
    company: str
    title: str
    applied_on: str = ""
    current_status: str = ""

    def as_prompt_block(self, index: int) -> str:
        parts = [f"[{index}] {self.title} -- {self.company}"]
        if self.applied_on:
            parts.append(f"    Applied: {self.applied_on}")
        if self.current_status:
            parts.append(f"    Tracker currently says: {self.current_status}")
        return "\n".join(parts)


@dataclass
class DetectedUpdate:
    """An update tied back to the application it belongs to."""

    job_id: str
    status: str
    confidence: str
    evidence: str


def detect_updates(
    applications: Sequence[TrackedApplication],
    messages: Sequence[InboxMessage],
) -> Tuple[List[DetectedUpdate], List[str]]:
    """Match messages to applications. Returns the updates worth acting on
    and any errors, rather than raising -- one failed model call should not
    lose a whole sync."""
    if not applications or not messages:
        return [], []

    app_block = "\n".join(app.as_prompt_block(i) for i, app in enumerate(applications))
    msg_block = "\n\n".join(m.as_prompt_block(i) for i, m in enumerate(messages))

    user = (
        f"TRACKED APPLICATIONS ({len(applications)})\n{app_block}\n\n"
        f"MESSAGES ({len(messages)})\n{msg_block}\n\n"
        "Return an update only for messages that clearly concern one of these "
        "applications."
    )

    try:
        batch = structured(ApplicationUpdateBatch, _SYSTEM, user, max_tokens=8000)
    except Exception as exc:
        return [], [f"Could not read the inbox for updates: {exc}"]

    return _usable(batch.updates, applications), []


def _usable(
    updates: Sequence[ApplicationUpdate], applications: Sequence[TrackedApplication]
) -> List[DetectedUpdate]:
    """Drop everything that should not move a tracker row.

    Low confidence is discarded rather than surfaced: this runs unattended and
    writes to the tracker, so anything the model is unsure about is noise the
    user never asked to review. `no_change` is dropped for the same reason --
    it is the model correctly deciding nothing happened.
    """
    out: List[DetectedUpdate] = []
    for update in updates:
        if update.status == "no_change" or update.confidence == "low":
            continue
        if not 0 <= update.job_index < len(applications):
            continue  # an index for an application that was never sent
        if not update.evidence.strip():
            continue  # a verdict with nothing behind it is not one to act on
        app = applications[update.job_index]
        out.append(
            DetectedUpdate(
                job_id=app.job_id,
                status=update.status,
                confidence=update.confidence,
                evidence=update.evidence.strip(),
            )
        )
    return out
