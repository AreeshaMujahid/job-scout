"""Draft the e-mail that chases an application which has gone quiet.

Deliberately a different job from the cover letter, not a variation on it.
A cover letter argues; a follow-up is a short, polite nudge that has to earn
a reply from someone who has hundreds of unread messages. Restating the
pitch is the failure mode -- it reads as noise and gets skimmed past -- so
the prompt below pushes hard the other way.
"""
from __future__ import annotations

import re

from .llm import structured
from .models import CandidateProfile, FollowUpResult, Job
from .rating import _profile_block

_SYSTEM = """You write short follow-up e-mails for a job seeker whose
application has had no reply.

You get their profile, the posting, and how long it has been since they
applied. Write the e-mail they should send now.

What makes these work:
- SHORT. 80-150 words. Anything longer gets skimmed and dropped.
- One clear ask, and make it easy to answer: whether there is an update on
  the timeline. Not "please consider me", which asks the reader for nothing
  they can actually do.
- One line -- at most -- on why they are still a good fit, naming something
  concrete from their background that matches this posting. This is a
  reminder, not a second cover letter. Never restate the whole case.
- Warm and professional. Never entitled, never apologetic, never desperate.
  "I wanted to check in on the timeline" -- not "I am sorry to bother you"
  and not "I have not heard back from anyone".
- Reference when they applied, so the reader can find the application.
- Lay it out like a real e-mail: greeting on its own line, blank line, the
  body, blank line, then the sign-off. One unbroken wall of text reads as
  machine-generated at a glance, which is exactly what a follow-up cannot
  afford to look like.
- Every factual claim must be traceable to the profile. This goes to a real
  employer under the applicant's real name; do not invent a project, a
  number, or an interaction that never happened. In particular, do not
  reference a conversation, an interviewer, or a previous reply -- there has
  been no reply, and inventing one is the fastest way to look absurd.

Sign-off: end with a sign-off line ("Best regards," or similar) followed on
its own line by exactly the token {{SIGNATURE}} and nothing else -- not the
candidate's name and not a guess. The real name is inserted afterwards by
code that knows it reliably; profile extraction sometimes fails to find one,
and a wrong name signed onto a real e-mail is worse than a marker that gets
replaced.
"""


def generate_follow_up(
    profile: CandidateProfile,
    job: Job,
    *,
    days_since_applied: int,
    extra_context: str = "",
) -> FollowUpResult:
    profile_text = _profile_block(profile, extra_context)
    # Only what a follow-up actually needs. The full posting is not sent:
    # this e-mail is a nudge, and handing the model the entire description
    # is what tempts it into writing a second cover letter.
    job_text = (
        f"{job.title} -- {job.company}\n"
        f"Location: {job.location or 'not stated'}\n"
        f"Applied: {days_since_applied} days ago, with no reply since."
    )

    user = (
        f"CANDIDATE\n{profile_text}\n\n"
        f"APPLICATION\n{job_text}\n\n"
        f"Write the follow-up e-mail."
    )
    result = structured(FollowUpResult, _SYSTEM, user, max_tokens=1500)
    result.body = _apply_signature(result.body, profile.name)
    return result


def _apply_signature(body: str, name: str | None) -> str:
    """Put the real name on it, or take the marker out cleanly.

    Same reasoning as the cover letter's version: profile.name falls back to
    the literal string "Unknown" when CV extraction finds no name, and
    "Best regards, Unknown" on a real e-mail is worse than a blank line the
    sender fills in themselves.

    The marker is matched together with any whitespace and newline in front
    of it, then replaced with exactly one newline: the model does not
    reliably put it on its own line, and a plain str.replace produced a real
    draft signed "Best regards,Areesha Mujahid" run together on one line.
    """
    marker = re.compile(r"[ \t]*\n?[ \t]*\{\{SIGNATURE\}\}")
    real_name = (name or "").strip()
    if real_name.lower() in ("", "unknown"):
        return marker.sub("", body).rstrip()
    return marker.sub("\n" + real_name, body).rstrip()
