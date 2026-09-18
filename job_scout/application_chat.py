"""Draft answers to the open questions on an application form.

The questions that are not a CV upload: "a model you trained, the problem and
how you measured success", "what are you proudest of", "why us". People
currently answer these by pasting the question into a chatbot that knows
nothing about them, then pasting their CV in after it, every time.

This one already has the CV. That is the whole difference, and it is also
the constraint: an answer may only claim what the CV can back. A chatbot
with no context invents a plausible project and the candidate finds out in
the interview; that failure is worse than no answer at all.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Literal, Sequence

from pydantic import BaseModel, Field

from .llm import structured
from .models import CandidateProfile, Job

_SYSTEM = """You help one candidate answer the open questions on a job
application. You write in their voice, from their CV, for this posting.

THE RULE THAT MATTERS MOST
Everything you write must be something their CV supports. You may choose
what to lead with, phrase it well, and draw out why it mattered. You may NOT
invent a project, a tool, a metric, a job, or a duration. If the question
asks for something their CV does not show, say so plainly in one line and
offer the nearest thing they can honestly say -- do not quietly fill the gap.
They will be asked follow-up questions about whatever you write, in a room,
by someone who has read it.

HOW TO WRITE
- First person, their voice. Plain sentences. No "leveraged", "spearheaded",
  "passionate about", and no opening line that restates the question.
- Concrete over general: the tool, the number, the outcome. Their CV has
  real figures -- use them rather than "significantly improved".
- Match the length the question asks for. A box on a form wants a short
  paragraph or two, not an essay. If they ask for a word count, obey it.
- One idea per answer. A question about a model they trained wants ONE
  model, told properly -- problem, what they did, how they knew it worked --
  not a tour of everything they have built.
- If the question names the company, use what the posting actually says
  about the work. If the posting says little, say less rather than inventing
  enthusiasm; generic flattery reads as generic.

FOLLOW-UP TURNS
The candidate will ask for changes -- shorter, different project, less
formal, lead with the outcome. Rewrite the whole answer as asked and return
just the new version. Do not explain what you changed unless they ask, and
do not apologise.

WHAT TO RETURN
`reply` is what the candidate reads. When you have drafted an answer, it is
the answer itself, ready to paste into the form -- not a preamble followed by
it. When you need something from them (the posting text, which project to
use), it is a short question instead.
"""


class ApplicationAnswer(BaseModel):
    """One turn of the conversation."""

    reply: str = Field(
        description=(
            "What the candidate reads: the drafted answer ready to paste, or "
            "a short question if you need something before you can write it."
        )
    )
    unsupported: List[str] = Field(
        default_factory=list,
        description=(
            "Anything the question asked for that the CV does not evidence, "
            "named so the candidate can add it themselves or choose another "
            "example. Empty when the CV covered the question."
        ),
    )


@dataclass
class ChatTurn:
    """One message already in the conversation."""

    role: Literal["user", "assistant"]
    content: str


def _profile_block(profile: CandidateProfile) -> str:
    parts = [
        f"Name: {profile.name}",
        f"Headline: {profile.headline}",
        f"Seniority: {profile.seniority} ({profile.years_experience} years)",
        f"Core skills: {', '.join(profile.core_skills)}",
        f"Tools: {', '.join(profile.tools)}",
        f"Domains: {', '.join(profile.domains)}",
    ]
    if profile.strengths:
        parts.append(f"Strengths: {'; '.join(profile.strengths)}")
    return "\n".join(parts)


def answer_application_question(
    profile: CandidateProfile,
    cv_text: str,
    history: Sequence[ChatTurn],
    job: Job | None = None,
) -> ApplicationAnswer:
    """Continue the conversation and return the next reply.

    Stateless: the caller owns the transcript and sends it every time. The
    history is flattened into one prompt rather than sent as a message array
    so this goes through `structured` -- which carries the retry, the
    rate-limit pacing and the fallback model that a free-tier key needs.
    """
    sections = [
        "THE CANDIDATE",
        _profile_block(profile),
        "",
        "THEIR CV, IN FULL",
        # The whole thing: the specific project the question is about is
        # usually a bullet in the experience section, not in the skills list.
        cv_text.strip()[:12000],
    ]

    if job is not None:
        sections += [
            "",
            "THE POSTING THEY ARE APPLYING TO",
            f"{job.title} at {job.company}",
            (job.description or "").strip()[:6000] or "(no description available)",
        ]

    sections += ["", "THE CONVERSATION SO FAR"]
    for turn in history:
        who = "CANDIDATE" if turn.role == "user" else "YOU"
        sections.append(f"{who}: {turn.content.strip()}")

    sections += ["", "Write your next reply."]

    return structured(ApplicationAnswer, _SYSTEM, "\n".join(sections), max_tokens=4000)
