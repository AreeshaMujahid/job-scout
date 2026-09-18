"""Draft a message to one person at a company about one job.

Drafts only. Nothing here sends anything, and nothing should: a message
going out under someone's own name to a stranger they may later work with
is theirs to read and press send on. The app writes it and hands it over.

The hard part is not the prose, it is not being embarrassing. These go to
people who owe the sender nothing, so the prompt below pushes against every
way a referral ask normally goes wrong -- inventing a shared history,
flattering, demanding, or writing three paragraphs a stranger will not read.
"""
from __future__ import annotations

import re

from .llm import structured
from .models import CandidateProfile, Job, OutreachResult
from .rating import _profile_block

# LinkedIn's own cap on a connection-request note.
CONNECTION_NOTE_LIMIT = 300

_SYSTEM = """You write short outreach messages for a job seeker contacting
somebody who works at a company they are applying to.

You get the sender's profile, the posting, and who they are writing to
(name, and their role if it is known). The recipient is a STRANGER: no
shared history exists, and inventing one is the single worst thing you can
do here.

Rules:
- Never imply a relationship that does not exist. No "great connecting with
  you", no "I enjoyed your post", no "we met at". They have never spoken.
- Name why THIS person. Their role, their team, the overlap with what the
  sender does. "I saw you work at X" is not a reason; "I saw you lead the
  data science team there, and the role I applied for sits in it" is.
- One ask, and make it small and easy to say yes to. A referral is a big
  favour from a stranger; asking whether the team is still hiring, or
  whether they would be open to a short chat, gets answered far more often.
  Never demand a referral outright in a first message.
- Every claim about the sender must come from their profile. Do not invent a
  project, a number, or a year.
- Plain and warm. Not formal, not chummy, never desperate. No "I hope this
  message finds you well". No exclamation marks.
- connection_note: 300 characters MAXIMUM, counted strictly, including
  spaces. This is the whole of what a stranger sees when deciding whether to
  accept, so the reason and the ask must both survive. No greeting line.
- message: 120-180 words, laid out as a real message -- greeting, blank
  line, body, blank line, sign-off. End with a sign-off line and then the
  token {{SIGNATURE}} alone on the next line; the real name is filled in
  afterwards by code, because profile extraction sometimes has no name and a
  wrong one signed to a stranger is worse than a blank.
"""


def generate_outreach(
    profile: CandidateProfile,
    job: Job,
    *,
    contact_name: str,
    contact_headline: str = "",
    extra_context: str = "",
) -> OutreachResult:
    profile_text = _profile_block(profile, extra_context)
    # Only what the message needs. The full posting is not sent: this is a
    # few lines to a stranger, and the whole description invites the model to
    # write a cover letter at them.
    job_text = (
        f"{job.title} -- {job.company}\n"
        f"Location: {job.location or 'not stated'}"
    )
    who = contact_name.strip() or "someone at the company"
    if contact_headline.strip():
        who += f" -- {contact_headline.strip()}"

    user = (
        f"SENDER\n{profile_text}\n\n"
        f"ROLE THEY APPLIED FOR\n{job_text}\n\n"
        f"WRITING TO\n{who}\n\n"
        f"Write the connection note and the longer message."
    )
    result = structured(OutreachResult, _SYSTEM, user, max_tokens=1500)
    result.connection_note = _fit_note(result.connection_note)
    result.message = _apply_signature(result.message, profile.name)
    return result


def _fit_note(note: str) -> str:
    """Keep the connection note inside LinkedIn's limit.

    Enforced here rather than trusted to the prompt: the model overruns 300
    characters often enough that shipping it unchecked means the ask -- which
    is at the end -- is what LinkedIn cuts off. Trimmed at a sentence
    boundary where possible, so the note ends as a sentence rather than
    mid-word with an ellipsis.
    """
    note = " ".join((note or "").split())
    if len(note) <= CONNECTION_NOTE_LIMIT:
        return note
    cut = note[:CONNECTION_NOTE_LIMIT]
    for stop in (". ", "? ", "! "):
        idx = cut.rfind(stop)
        if idx > CONNECTION_NOTE_LIMIT * 0.5:
            return cut[: idx + 1].strip()
    return cut[: cut.rfind(" ")].strip() if " " in cut else cut.strip()


def _apply_signature(body: str, name: str | None) -> str:
    """Put the real name on it, or drop the marker cleanly.

    Same reasoning and same regex as the cover letter and follow-up: the
    model does not reliably put the token on its own line, and a plain
    replace once produced a draft signed "Best regards,Areesha Mujahid".
    """
    marker = re.compile(r"[ \t]*\n?[ \t]*\{\{SIGNATURE\}\}")
    real_name = (name or "").strip()
    if real_name.lower() in ("", "unknown"):
        return marker.sub("", body).rstrip()
    return marker.sub("\n" + real_name, body).rstrip()
