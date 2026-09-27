"""The three shapes this project passes around: a job, a CV, a verdict."""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import List, Literal

from pydantic import BaseModel, Field


@dataclass
class Job:
    """One posting, normalised out of whichever board it came from."""

    source: str
    title: str
    company: str
    url: str
    location: str = ""
    description: str = ""
    tags: List[str] = field(default_factory=list)
    salary: str = ""
    posted_at: str = ""
    remote: bool = False
    # The employer's own page on the board, when the listing links to one.
    # Who is behind a posting is part of deciding whether to apply: an agency
    # reposting for an undisclosed client reads very differently from the
    # employer posting directly, and the company page is where you check.
    company_url: str = ""
    # The employer's logo, when the board hands one over. Remotive and
    # Jobicy do; LinkedIn, Xing and StepStone do not, and nothing here
    # guesses one from the company name -- a logo belonging to a different
    # company with a similar name is worse on a card than no logo at all.
    logo: str = ""
    # Filled in by sources.fetch_all: 3 = the title matches a search
    # phrase, 1 = only the body does. Drives ordering before rating.
    relevance: int = 0

    @property
    def key(self) -> str:
        """Identity for de-duplication.

        Boards syndicate from each other, so the same posting arrives with
        different ids, different URLs and different amounts of whitespace in
        the title. Company plus a squashed title is what actually stays
        constant across all six.
        """
        squash = lambda s: re.sub(r"[^a-z0-9]+", "", s.lower())
        return hashlib.sha1(
            f"{squash(self.company)}|{squash(self.title)}".encode()
        ).hexdigest()[:16]


class CandidateProfile(BaseModel):
    """What the CV says, in the form the search and the rater need it."""

    name: str = Field(description="Candidate's full name, or 'Unknown'")
    headline: str = Field(description="One line: who this candidate is professionally")
    years_experience: float = Field(description="Total professional years, 0 if unclear")
    seniority: Literal["intern", "junior", "mid", "senior", "lead", "principal"]
    core_skills: List[str] = Field(description="8-15 skills the CV actually evidences")
    tools: List[str] = Field(description="Named tools, languages, frameworks, platforms")
    domains: List[str] = Field(description="Industries or problem areas worked in")
    search_queries: List[str] = Field(
        description=(
            "3-6 job-board search phrases that would surface suitable roles. "
            "Real job titles only, e.g. 'machine learning engineer' -- never "
            "skills or buzzwords."
        )
    )
    strengths: List[str] = Field(description="3-5 things that make this candidate competitive")
    gaps: List[str] = Field(description="2-4 honest weak spots relative to their target roles")


class JobRating(BaseModel):
    """The verdict on one job, and the reasoning a person would want to see."""

    index: int = Field(description="Index of the job being rated, as given in the prompt")
    score: int = Field(description="Overall fit, 0-100")
    verdict: Literal["strong", "good", "stretch", "weak"]
    skills_match: int = Field(description="0-100: do their skills cover the requirements")
    experience_match: int = Field(description="0-100: seniority and years against the ask")
    domain_match: int = Field(description="0-100: industry and problem-space overlap")
    why_pick: List[str] = Field(
        description=(
            "2-4 reasons THIS candidate should apply, each naming concrete "
            "evidence from the CV. No generic praise."
        )
    )
    concerns: List[str] = Field(description="1-3 honest reasons this might not work out")
    matched_skills: List[str] = Field(description="Requirements the CV clearly covers")
    missing_skills: List[str] = Field(description="Requirements the CV does not cover")
    pitch: str = Field(description="One sentence the candidate could open an application with")


class RatingBatch(BaseModel):
    ratings: List[JobRating]


class OutreachResult(BaseModel):
    """A message asking one person at a company about one job.

    Two forms, because LinkedIn has two: the note attached to a connection
    request is capped at 300 characters and is all a stranger sees first,
    while a full message only becomes possible once they accept or the
    sender pays for InMail. One draft cannot serve both.
    """

    connection_note: str = Field(
        description=(
            "The note on a connection request. MUST be 300 characters or "
            "fewer -- LinkedIn truncates past that and the ask is what gets "
            "cut. One specific reason for contacting THEM, and the ask. No "
            "greeting boilerplate; there is no room for it."
        )
    )
    message: str = Field(
        description=(
            "The longer message, for once they have accepted or for InMail. "
            "120-180 words: who the sender is, the specific role, one real "
            "point of overlap with this person's work, and a clear, easy "
            "ask. Ends with a sign-off line then the {{SIGNATURE}} token on "
            "its own line."
        )
    )


class FollowUpResult(BaseModel):
    """A short e-mail chasing an application that has gone quiet."""

    subject: str = Field(
        description=(
            "Subject line. Names the role, and reads like a reply to an "
            "existing thread rather than a fresh pitch -- e.g. "
            "'Following up: Data Scientist application'."
        )
    )
    body: str = Field(
        description=(
            "The whole e-mail, greeting through sign-off, ready to send. "
            "Short -- 80-150 words. A follow-up that restates the cover "
            "letter gets skimmed and dropped; one that asks a single clear "
            "question about timeline gets answered. No placeholder brackets."
        )
    )


class ApplicationUpdate(BaseModel):
    """What one inbox message says about one application the user is tracking.

    The whole point is to move a tracker row without the user touching it, so
    the bar for acting is high: a wrong "rejected" makes someone stop chasing
    a live application, which is worse than showing them nothing at all.
    """

    job_index: int = Field(
        description="Index of the tracked application this message is about, as given in the prompt"
    )
    status: Literal["applied", "interviewing", "offer", "rejected", "no_change"] = Field(
        description=(
            "What the message shows this application has become. 'applied' is "
            "a received/acknowledged confirmation. 'interviewing' covers an "
            "invitation to talk at any stage, including a screening call or an "
            "online assessment. 'no_change' when the message is about this "
            "application but does not move it -- a newsletter, a job alert, a "
            "generic 'we are still reviewing'."
        )
    )
    confidence: Literal["high", "medium", "low"] = Field(
        description=(
            "high only when the message plainly states the outcome for THIS "
            "role. A mass-mailed 'we keep CVs on file' is low."
        )
    )
    evidence: str = Field(
        description=(
            "The sentence from the e-mail that decided it, quoted, so the user "
            "can see why their tracker moved instead of trusting a label."
        )
    )


class ApplicationUpdateBatch(BaseModel):
    updates: List[ApplicationUpdate]


class CVKeywordEdit(BaseModel):
    """One word-for-word swap to make inside the candidate's existing CV.

    The unit of work is deliberately this small. A CV is a designed document --
    photo, header bar, fonts, column widths -- and the only kind of change that
    can be made to one without rebuilding it (and losing all of that) is
    replacing a run of text with a run of text of about the same length.
    """

    find: str = Field(
        description="The exact text to replace, copied character-for-character from the "
        "CV, including its capitalisation. Must sit on ONE line of the CV -- a short "
        "phrase, not a whole bullet, and never spanning a line break."
    )
    replace: str = Field(
        description="What to put there instead. MUST be about the same length as `find` "
        "(no more than ~10% longer) -- it has to fit the space the original occupied, or "
        "it will be refused. Same meaning, same facts, the posting's vocabulary."
    )
    reason: str = Field(
        default="",
        description="One short line: which term from the posting this brings in, and "
        "why the CV already earns it.",
    )


class JobRequirements(BaseModel):
    """Every skill one posting asks for, read from the posting alone.

    Deliberately takes no view of the candidate. Asked about a posting and a
    CV together, the model returned a different set of gaps each time it was
    called -- so confirming "yes I have Kubernetes" produced a fresh list
    naming three tools it had not mentioned a moment earlier, and the list
    never converged. What a job advert requires does not change when the
    reader answers a question about themselves, so it is extracted once from
    the advert and reused; only the diff against the candidate moves.
    """

    skills: List[str] = Field(
        description=(
            "Every distinct skill, tool, language or framework this posting "
            "asks for. SHORT NAMES ONLY, as they would appear on a CV skills "
            "line -- 'Kubernetes', 'PyTorch', 'German (C1)' -- never "
            "sentences. Include must-haves and nice-to-haves alike. Be "
            "thorough: one you leave out is one the candidate never gets "
            "asked about. Name only what the posting actually says."
        )
    )


class CVKeywordEdits(BaseModel):
    """The full set of swaps proposed for one posting, and what is missing."""

    edits: List[CVKeywordEdit] = Field(
        description="Replacements that can be made from what the CV already shows, "
        "ordered most valuable first. Empty is a valid answer when the CV already "
        "uses the posting's own language."
    )
    missing_skills: List[str] = Field(
        default_factory=list,
        description=(
            "Skills and tools this posting asks for that nothing in the CV "
            "evidences. SHORT NAMES ONLY, as they would appear on a skills line "
            "-- 'Kubernetes', 'Terraform', 'Kafka' -- not sentences, not "
            "explanations. These are offered back to the candidate to confirm: "
            "they are the only person who knows whether a skill is missing "
            "because they lack it or because they never wrote it down."
        ),
    )


class CoverLetterResult(BaseModel):
    """A cover letter for one posting, plus how to survive the screen before
    a human ever reads it.

    Both halves come from the same model call on purpose: writing the letter
    requires finding every real point of contact between the CV and the
    posting, and cv_suggestions is that same search reported back to the
    candidate instead of thrown away once the letter is written.
    """

    letter: str = Field(
        description=(
            "The complete cover letter, ready to send: greeting through "
            "sign-off, no placeholders like [Company Name] or [Your Name] "
            "left for the candidate to fill in."
        )
    )
    cv_suggestions: List[str] = Field(
        description=(
            "2-5 concrete edits to the CV that would help it pass an ATS "
            "keyword screen or a recruiter's first pass for THIS posting. "
            "Each names the exact term the posting uses and where real "
            "experience already covers it but the CV does not say so in "
            "those words -- e.g. \"The posting asks for CI/CD; your Meezan "
            "Bank bullet describes an automated deploy pipeline but never "
            "uses that term -- add it.\" Never invent a skill or tool "
            "the CV gives no evidence of; a genuine gap belongs in the "
            "letter's honesty or nowhere, not here as a suggestion to fake it."
        )
    )
