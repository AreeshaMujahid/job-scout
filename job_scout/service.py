"""HTTP face for the job_scout pipeline, for the Next.js app to call.

    python -m job_scout.service          (http://127.0.0.1:8000)

Stateless on purpose: this service reads CVs, searches boards and rates jobs.
Everything worth keeping -- users, saved jobs, application status -- lives in
the web app's Postgres, not here.

Bind to localhost unless you have put it behind something. When SCOUT_TOKEN is
set, every endpoint requires `Authorization: Bearer <token>`; set it in any
deployment where the service is reachable from anywhere but the app itself.
"""
from __future__ import annotations

import base64
import binascii
import os
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from typing import List, Optional

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from . import config, llm
from .application_chat import ChatTurn, answer_application_question
from .application_status import TrackedApplication, detect_updates
from .cover_letter import generate_cover_letter
from .cv_editor import (
    drop_unevidenced_additions,
    extract_required_skills,
    propose_keyword_edits,
    suggest_keyword_edits,
)
from .cv_inplace import apply_keyword_edits
from .follow_up import generate_follow_up
from .outreach import generate_outreach
from .referrals import (
    fetch_company_people,
    fetch_referral_contacts,
    resolve_company_url,
)
from .cover_letter_pdf import render_cover_letter_pdf
from .cv_reader import UnreadableCV, read_cv
from .inbox import InboxMessage
from .models import (
    CandidateProfile,
    CoverLetterResult,
    FollowUpResult,
    Job,
    JobRating,
    OutreachResult,
    CVKeywordEdit,
    CVKeywordEdits,
)
from .profile import build_profile
from .rating import rate_jobs
from .sources import BOARDS, fetch_all
from .sources.scrapers import EXPERIENCE_LEVELS, IMPORT_ERROR, SCRAPERS, scrape
from .sources.seniority import matches as level_matches

app = FastAPI(title="job_scout", version="1.0.0")


# ----------------------------------------------------------------- auth
def require_token(authorization: Optional[str] = Header(default=None)) -> None:
    config.load_env()
    expected = os.getenv("SCOUT_TOKEN", "").strip()
    if not expected:
        return  # unset: local development, no gate
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Bad or missing bearer token")


# ----------------------------------------------------------------- shapes
class JobPayload(BaseModel):
    """A job as it crosses the wire. Mirrors models.Job."""

    source: str = ""
    title: str = ""
    company: str = ""
    url: str = ""
    location: str = ""
    description: str = ""
    tags: List[str] = Field(default_factory=list)
    salary: str = ""
    posted_at: str = ""
    company_url: str = ""
    remote: bool = False
    relevance: int = 0
    # Job.key is a property, not a dataclass field, so it has to be sent
    # explicitly. The web app uses it as the primary key, which is what makes
    # the same posting from three boards one row rather than three.
    key: str = ""

    @classmethod
    def of(cls, job: Job) -> "JobPayload":
        return cls(**job.__dict__, key=job.key)

    def to_job(self) -> Job:
        fields = self.model_dump()
        fields.pop("key", None)
        return Job(**fields)


class SearchRequest(BaseModel):
    queries: List[str]
    location: str = ""
    remote_only: bool = False
    boards: Optional[List[str]] = None
    min_relevance: int = 2
    limit: int = 40
    # These two have no equivalent on the API boards, which return whatever
    # matches the words. Applied here instead, from the title and the
    # description -- see sources/seniority.py. Empty means no filtering, which
    # is what every caller got before this existed.
    experience_levels: List[str] = Field(default_factory=list)
    max_years: Optional[int] = None
    # Filters the boards cannot apply themselves -- see sources/filters.py.
    # All optional, and all reject only on evidence: an undated posting is
    # not stale, one stating no salary is not underpaid.
    max_age_days: Optional[int] = None
    min_salary: Optional[int] = None
    blocked_companies: List[str] = Field(default_factory=list)
    needs_sponsorship: bool = False


class SearchResponse(BaseModel):
    jobs: List[JobPayload]
    fetched: dict = Field(default_factory=dict)
    kept: dict = Field(default_factory=dict)
    errors: dict = Field(default_factory=dict)
    duplicates: int = 0
    total_fetched: int = 0
    # How many postings the seniority filter removed. Reported so the caller
    # can say it out loud: a search that reads 800 postings and shows 12 looks
    # broken unless the number that was filtered is visible.
    filtered_by_level: int = 0
    # The rest of the funnel, which fetch_all has always counted and nobody
    # could see. On a one-title search these routinely account for 99% of what
    # the boards returned -- without them, "846 postings read" followed by
    # three results reads as a broken search rather than a narrow query.
    off_topic: int = 0
    wrong_location: int = 0
    # Keyed by reason: stale / underpaid / blocked / no_sponsorship.
    rejected: dict = Field(default_factory=dict)


class ScrapeRequest(BaseModel):
    titles: List[str]
    locations: List[str]
    board: str = "LinkedIn"
    pages: int = 3
    max_age_hours: Optional[float] = 24
    experience_levels: List[str] = Field(default_factory=list)
    max_years: Optional[int] = None
    # Stop once this many unique postings are collected. Cost here is per
    # posting (a description request and a delay each), not per page, so an
    # unbounded multi-title run can outlast the caller's HTTP timeout and
    # return nothing for several minutes of work.
    limit: Optional[int] = None


class ScrapeResponse(BaseModel):
    jobs: List[JobPayload]
    stats: dict = Field(default_factory=dict)


class RateRequest(BaseModel):
    profile: CandidateProfile
    jobs: List[JobPayload]
    # Facts the CV does not carry: work authorisation, cities they can take,
    # what they said they are looking for during onboarding.
    extra_context: str = ""


class RatedPayload(BaseModel):
    job_index: int
    rating: JobRating


class RateResponse(BaseModel):
    ratings: List[RatedPayload]
    errors: List[str] = Field(default_factory=list)


class ProfileResult(CandidateProfile):
    """The profile, plus the plain text it was read from.

    The web app has nowhere else to keep the CV's own text once the upload
    request ends, and tailoring a CV to a posting later needs it verbatim --
    so it rides along here rather than being read a second time (there is no
    second time: the raw file is never stored, only this).
    """

    cv_text: str = ""


class CoverLetterRequest(BaseModel):
    profile: CandidateProfile
    job: JobPayload
    # The web app already has these for any job it has rated -- passing them
    # through means the letter and the CV suggestions agree with what the
    # score card told the user, instead of a second model call quietly
    # re-deriving a possibly different view of the same gaps.
    missing_skills: List[str] = Field(default_factory=list)
    concerns: List[str] = Field(default_factory=list)
    extra_context: str = ""


class CoverLetterPdfRequest(BaseModel):
    """No model call here -- this renders a letter already written, so it
    takes the finished text directly rather than the profile/job pair the
    other endpoints need to generate one."""

    letter: str
    job_title: str = ""
    company: str = ""
    candidate_name: str = ""
    candidate_email: str = ""


class TailorCVRequest(BaseModel):
    """Ask which of a CV's words should become a posting's words. Needs the
    CV's own text -- the profile alone (skills, years, headline) has thrown
    away the exact wording every edit has to quote verbatim."""

    profile: CandidateProfile
    job: JobPayload
    cv_text: str
    # Skills the candidate says they have that their CV never mentions. Their
    # own claim, so it counts as evidence; see cv_editor.suggest_keyword_edits.
    extra_skills: str = ""
    # The CV itself, base64. Optional, but without it the caller is told what
    # was PROPOSED rather than what will actually happen -- and those differ:
    # an edit is refused if its words cannot be found or will not fit the
    # line. Sent, the response lists only edits that really land.
    cv_base64: str = ""
    # What this posting asks for, from an earlier call. Sent back so the gaps
    # put to the candidate are the same list getting shorter as they confirm,
    # rather than a freshly imagined one each round. Empty on the first call.
    required_skills: List[str] = Field(default_factory=list)


class SkippedEdit(BaseModel):
    """An edit that cannot be made, and the reason in the user's terms."""

    find: str
    replace: str
    reason: str


class TailorCVResponse(BaseModel):
    edits: List[CVKeywordEdit] = Field(
        default_factory=list,
        description="Edits that will actually appear in the downloaded CV.",
    )
    skipped: List[SkippedEdit] = Field(default_factory=list)
    # Of `edits`, the ones that went on a new line because the line they
    # belonged on was full. Reported separately because it is a different
    # promise: the document is one line longer than the one uploaded.
    inserted: List[CVKeywordEdit] = Field(default_factory=list)
    # Of `inserted`, the ones whose new line could not be set in the CV's own
    # typeface. Legible and correct, but visibly not the same font -- the
    # person sending the CV should know before they send it.
    font_substituted: List[CVKeywordEdit] = Field(default_factory=list)
    missing_skills: List[str] = Field(default_factory=list)
    # The posting's own catalogue, for the caller to store and send back.
    required_skills: List[str] = Field(default_factory=list)
    # Set when the posting carries too little text to tailor against. Without
    # it an empty result looks like a broken button rather than "this board
    # gave us three lines to work from".
    warning: str = ""


class TailorCVPdfRequest(BaseModel):
    """Apply already-decided edits to the candidate's real CV file.

    Takes the original PDF rather than any description of it, because the
    whole point is that the file is edited in place and keeps its own photo,
    fonts and layout. Base64 so it rides in JSON like every other endpoint
    here; the caller holds the bytes, this service stores nothing.
    """

    cv_base64: str
    edits: List[CVKeywordEdit]


class FollowUpRequest(BaseModel):
    profile: CandidateProfile
    job: JobPayload
    # Drives the "you applied N days ago" line, and is the whole reason the
    # e-mail is being written -- so it is required rather than defaulted.
    days_since_applied: int
    extra_context: str = ""


class CompanyPeopleRequest(BaseModel):
    """One company, on explicit request. Bounded server-side regardless of
    what the caller asks for -- see COMPANY_PEOPLE_LIMIT.

    Either identifier will do. Only LinkedIn-sourced postings carry a company
    URL, so a job from Xing or a JSON board sends the name instead and the
    page is looked up first."""

    company_url: str = ""
    company_name: str = ""
    keyword: str = ""


class ReferralRequest(BaseModel):
    """One posting's URL. No profile, no CV -- this reads what LinkedIn
    already shows this signed-in user about their own network, and needs
    nothing else to do it."""

    job_url: str


class ReferralContactPayload(BaseModel):
    name: str = ""
    profile_url: str = ""
    headline: str = ""
    degree: str = ""


class ReferralResponse(BaseModel):
    contacts: List[ReferralContactPayload] = Field(default_factory=list)
    # The company page, when it had to be looked up from the name. Returned
    # so the caller can store it and skip the lookup next time.
    resolved_company_url: str = ""
    # An empty list is the ordinary answer ("you know nobody there"), so a
    # failure has to be distinguishable from it rather than collapsing into
    # the same empty response.
    error: str = ""


class OutreachRequest(BaseModel):
    profile: CandidateProfile
    job: JobPayload
    contact_name: str
    contact_headline: str = ""
    extra_context: str = ""


# ----------------------------------------------------------------- routes
@app.get("/health")
def health() -> dict:
    """Up, and able to do the job -- which are different questions.

    `ok` was once hardcoded True, so a service with no API key reported
    itself healthy and the only symptom was every rating failing one at a
    time, several screens away. Anything watching this endpoint needs the
    second question answered, not the first.
    """
    configured = llm.key_present()
    return {
        "ok": configured,
        "model": llm.model_name(),
        "provider": llm.provider(),
        "detail": (
            ""
            if configured
            else f"No API key for {llm.provider()}. Put it in job_scout/.env"
        ),
    }


@app.get("/boards")
def boards() -> dict:
    """Both kinds of source: the public job-board APIs, and the scrapers.

    They behave differently enough that the UI has to tell them apart. The
    APIs take a free-text query and hand back JSON; the scrapers search one
    title at a time per location and support seniority and years filters.
    """
    return {
        "apis": [{"name": n, "remote_only": r} for n, (_, r) in BOARDS.items()],
        "scrapers": list(SCRAPERS),
        "experience_levels": list(EXPERIENCE_LEVELS),
        "scraper_error": IMPORT_ERROR,
    }


@app.post("/profile", response_model=ProfileResult, dependencies=[Depends(require_token)])
async def profile(file: UploadFile = File(...)) -> ProfileResult:
    """Read an uploaded CV and return the profile that drives everything else,
    plus the CV's own text -- see ProfileResult for why."""
    raw = await file.read()
    try:
        cv_text = read_cv(raw, file.filename or "cv.pdf")
    except UnreadableCV as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    try:
        built = build_profile(cv_text)
    except llm.LLMError as exc:
        raise HTTPException(status_code=502, detail=f"Model unavailable: {exc}") from exc
    return ProfileResult(**built.model_dump(), cv_text=cv_text)


@app.post("/search", response_model=SearchResponse, dependencies=[Depends(require_token)])
def search(request: SearchRequest) -> SearchResponse:
    if not request.queries:
        raise HTTPException(status_code=422, detail="At least one search query is required")

    jobs, report = fetch_all(
        request.queries,
        location=request.location,
        remote_only=request.remote_only,
        boards=request.boards,
        min_relevance=request.min_relevance,
        # Fetch wider than asked for, because the level filter below removes
        # postings after the fact. Without the headroom, a search capped at 40
        # that is then filtered down to 12 looks like an empty job market.
        limit=request.limit * 3 if (request.experience_levels or request.max_years) else request.limit,
        max_age_days=request.max_age_days,
        min_salary=request.min_salary,
        blocked_companies=request.blocked_companies,
        needs_sponsorship=request.needs_sponsorship,
    )

    # The boards cannot filter on seniority, so it happens here. Only postings
    # that SAY they are the wrong level are dropped; an unmarked title is
    # ambiguous and kept -- see sources/seniority.py.
    if request.experience_levels or request.max_years is not None:
        before = len(jobs)
        jobs = [
            job
            for job in jobs
            if level_matches(
                job.title,
                job.description,
                levels=request.experience_levels,
                max_years=request.max_years,
            )
        ]
        report.filtered_by_level = before - len(jobs)
        jobs = jobs[: request.limit]

    return SearchResponse(
        jobs=[JobPayload.of(job) for job in jobs],
        filtered_by_level=getattr(report, "filtered_by_level", 0),
        off_topic=report.off_topic,
        wrong_location=report.wrong_location,
        rejected=report.rejected,
        fetched=report.fetched,
        kept=report.kept,
        errors=report.errors,
        duplicates=report.duplicates,
        total_fetched=report.total_fetched,
    )


@app.post("/scrape", response_model=ScrapeResponse, dependencies=[Depends(require_token)])
def scrape_boards(request: ScrapeRequest) -> ScrapeResponse:
    """Search LinkedIn / Xing / Arbeitnow, one title at a time per location.

    These are the auto-apply bot's scrapers, driven at the posting level so
    nothing touches its database. A run that scrapes zero postings is not the
    same as a run that found nothing relevant -- with these sources it almost
    always means a blocked response -- so the stats say which.
    """
    if not request.titles:
        raise HTTPException(status_code=422, detail="At least one job title is required")
    if not request.locations:
        raise HTTPException(status_code=422, detail="At least one location is required")

    try:
        jobs, stats = scrape(
            request.titles,
            request.locations,
            board=request.board,
            pages=max(1, min(request.pages, 10)),
            max_age_hours=request.max_age_hours,
            experience_levels=request.experience_levels,
            max_years=request.max_years,
            limit=request.limit,
        )
    except (RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return ScrapeResponse(jobs=[JobPayload.of(job) for job in jobs], stats=stats)


@app.post("/rate", response_model=RateResponse, dependencies=[Depends(require_token)])
def rate(request: RateRequest) -> RateResponse:
    """Score jobs against a profile.

    Results come back keyed by job_index rather than in order: a batch whose
    model call failed is simply absent, and the caller needs to know which
    jobs those were rather than guessing from a shorter list.
    """
    jobs = [payload.to_job() for payload in request.jobs]
    if not jobs:
        return RateResponse(ratings=[], errors=[])

    rated, errors = rate_jobs(request.profile, jobs, extra_context=request.extra_context)

    # rating.index is already the job's position in the list we passed in --
    # rate_jobs numbers the whole list before splitting it into batches, and
    # drops any rating whose index does not belong to its own batch.
    return RateResponse(
        ratings=[
            RatedPayload(job_index=item.rating.index, rating=item.rating)
            for item in rated
        ],
        errors=errors,
    )


@app.post(
    "/cover-letter", response_model=CoverLetterResult, dependencies=[Depends(require_token)]
)
def cover_letter(request: CoverLetterRequest) -> CoverLetterResult:
    return generate_cover_letter(
        request.profile,
        request.job.to_job(),
        missing_skills=request.missing_skills,
        concerns=request.concerns,
        extra_context=request.extra_context,
    )


@app.post("/cover-letter/pdf", dependencies=[Depends(require_token)])
def cover_letter_pdf(request: CoverLetterPdfRequest) -> Response:
    try:
        pdf_bytes = render_cover_letter_pdf(
            request.letter,
            job_title=request.job_title,
            company=request.company,
            candidate_name=request.candidate_name,
            candidate_email=request.candidate_email,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return Response(content=pdf_bytes, media_type="application/pdf")


_SKIP_REASONS = {
    "not_found": "those exact words are not in your CV",
    "did_not_fit": "no room on that line -- it would run into the next word",
    "left_a_gap": "much shorter than what it replaces, so it would leave a hole",
    "overlapped": "another edit already changes those words",
}


@app.post("/tailor-cv", response_model=TailorCVResponse, dependencies=[Depends(require_token)])
def tailor_cv_route(request: TailorCVRequest) -> TailorCVResponse:
    """Which of this CV's words should become this posting's words.

    When the CV itself is sent, the edits are applied to a throwaway copy
    first and only the ones that survive are returned. Proposing an edit and
    making it are not the same thing -- a replacement that will not fit its
    line is refused at render time -- and a UI that lists the proposals as
    "changes to your CV" tells the user about changes their download does not
    contain.
    """
    job = request.job.to_job()

    # Two model calls that do not depend on each other: what the advert asks
    # for, and what to change in the CV. Run in sequence on a rate-limited
    # free tier they can each sit through a 90-second backoff and blow the
    # caller's timeout -- which is what "the rating service timed out" was.
    # On later rounds the advert's catalogue comes back from the caller and
    # only one call is made at all.
    with ThreadPoolExecutor(max_workers=2) as pool:
        catalogue = (
            None
            if request.required_skills
            else pool.submit(
                extract_required_skills, job.description, job.title, job.company
            )
        )
        proposal = pool.submit(
            propose_keyword_edits,
            request.cv_text,
            request.profile,
            job_description=job.description,
            job_title=job.title,
            company=job.company,
            extra_skills=request.extra_skills,
        )
        required = request.required_skills or catalogue.result()
        raw = proposal.result()

    suggested = drop_unevidenced_additions(
        raw,
        request.cv_text,
        request.profile,
        request.extra_skills,
        job.description,
        required,
    )

    # Every change is justified by "the posting asks for it", so a posting
    # with almost no text can justify nothing -- and the honest answer is to
    # say so rather than return an empty panel.
    warning = ""
    if len(job.description.strip()) < 200:
        warning = (
            "This posting came through with almost no description, so there is "
            "nothing to tailor against. Open the job and paste its requirements "
            "in, or tailor against a posting that carries its full text."
        )

    if not request.cv_base64:
        return TailorCVResponse(
            edits=suggested.edits,
            missing_skills=suggested.missing_skills,
            required_skills=required,
            warning=warning,
        )

    try:
        raw = base64.b64decode(request.cv_base64, validate=True)
        _, report = apply_keyword_edits(raw, suggested.edits)
    except (binascii.Error, ValueError):
        # A CV we cannot open is not a reason to lose the suggestions.
        return TailorCVResponse(
            edits=suggested.edits,
            missing_skills=suggested.missing_skills,
            required_skills=required,
            warning=warning,
        )

    skipped = []
    for bucket in _SKIP_REASONS:
        for e in getattr(report, bucket):
            reason = _SKIP_REASONS[bucket]
            room = report.room_left.get(e.find)
            if bucket == "did_not_fit" and room is not None:
                reason = (
                    f"that line is full -- about {room} more characters would fit, "
                    f"and this needs {len(e.replace) - len(e.find)}"
                    if room
                    else "that line is completely full -- nothing more fits on it"
                )
            skipped.append(SkippedEdit(find=e.find, replace=e.replace, reason=reason))
    return TailorCVResponse(
        edits=report.applied,
        skipped=skipped,
        inserted=report.inserted,
        font_substituted=report.font_substituted,
        missing_skills=suggested.missing_skills,
        required_skills=required,
        warning=warning,
    )


@app.post("/tailor-cv/pdf", dependencies=[Depends(require_token)])
def tailor_cv_pdf(request: TailorCVPdfRequest) -> Response:
    """Apply the edits to the candidate's real CV, in place. No model call.

    `X-CV-Edits-Skipped` reports how many edits could not be made (the phrase
    was not found, or the replacement would not fit the space). They are not
    an error -- the original wording simply stays -- but the caller needs the
    count to be honest with the user about what it actually changed.
    """
    try:
        raw = base64.b64decode(request.cv_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=422, detail="cv_base64 is not valid base64") from exc

    try:
        pdf_bytes, report = apply_keyword_edits(raw, request.edits)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "X-CV-Edits-Applied": str(len(report.applied)),
            "X-CV-Edits-Skipped": str(len(report.skipped)),
            "X-CV-Lines-Added": str(len(report.inserted)),
        },
    )


@app.post("/follow-up", response_model=FollowUpResult, dependencies=[Depends(require_token)])
def follow_up(request: FollowUpRequest) -> FollowUpResult:
    """Draft the nudge for an application that has gone quiet."""
    return generate_follow_up(
        request.profile,
        request.job.to_job(),
        days_since_applied=request.days_since_applied,
        extra_context=request.extra_context,
    )


@app.post("/referrals", response_model=ReferralResponse, dependencies=[Depends(require_token)])
def referrals(request: ReferralRequest) -> ReferralResponse:
    """Who the signed-in user could ask for a referral on this posting.

    Slow and account-sensitive: it drives a real signed-in browser to a real
    LinkedIn page. Called on explicit request for one posting, never in a
    loop and never on a schedule -- see job_scout/referrals.py.
    """
    try:
        contacts = fetch_referral_contacts(request.job_url)
    except RuntimeError as exc:
        return ReferralResponse(contacts=[], error=str(exc))
    return ReferralResponse(
        contacts=[ReferralContactPayload(**c.as_dict()) for c in contacts]
    )


@app.post("/company-people", response_model=ReferralResponse, dependencies=[Depends(require_token)])
def company_people(request: CompanyPeopleRequest) -> ReferralResponse:
    """Staff at one company, for finding somebody to ask about a referral.

    Heavier than /referrals and the caller should treat it that way: these
    people have no relationship to the user, and an automated load of a
    company People page is the request in this project most likely to get an
    account flagged. One company, on request, capped.
    """
    company_url = request.company_url.strip()
    resolved = ""
    try:
        if not company_url:
            company_url = resolve_company_url(request.company_name) or ""
            resolved = company_url
            if not company_url:
                return ReferralResponse(
                    contacts=[],
                    error=(
                        f"No LinkedIn company page matched {request.company_name!r}. "
                        "Searching its staff needs one."
                    ),
                )
        contacts = fetch_company_people(company_url, keyword=request.keyword)
    except RuntimeError as exc:
        return ReferralResponse(contacts=[], error=str(exc))
    return ReferralResponse(
        contacts=[ReferralContactPayload(**c.as_dict()) for c in contacts],
        resolved_company_url=resolved,
    )


@app.post("/outreach", response_model=OutreachResult, dependencies=[Depends(require_token)])
def outreach(request: OutreachRequest) -> OutreachResult:
    """Draft a message to one person about one job. Drafts only -- nothing
    in this service sends anything on the user's behalf."""
    return generate_outreach(
        request.profile,
        request.job.to_job(),
        contact_name=request.contact_name,
        contact_headline=request.contact_headline,
        extra_context=request.extra_context,
    )


class InboxMessagePayload(BaseModel):
    """One message, already reduced by the caller.

    The web app truncates the body before it is stored, so this service never
    receives a whole mailbox -- only the opening of messages a user chose to
    forward, for exactly as long as it takes to classify them.
    """

    message_id: str = ""
    sender: str = ""
    subject: str = ""
    received_at: str = ""
    body: str = ""


class TrackedApplicationPayload(BaseModel):
    job_id: str
    company: str
    title: str
    applied_on: str = ""
    current_status: str = ""


class DetectedUpdatePayload(BaseModel):
    job_id: str
    status: str
    confidence: str
    evidence: str


class ClassifyInboxRequest(BaseModel):
    applications: List[TrackedApplicationPayload] = Field(default_factory=list)
    messages: List[InboxMessagePayload] = Field(default_factory=list)


class ClassifyInboxResponse(BaseModel):
    updates: List[DetectedUpdatePayload] = Field(default_factory=list)
    errors: List[str] = Field(default_factory=list)


@app.post(
    "/inbox/classify",
    response_model=ClassifyInboxResponse,
    dependencies=[Depends(require_token)],
)
def classify_inbox(request: ClassifyInboxRequest) -> ClassifyInboxResponse:
    """What the given messages say about the given applications.

    Stateless like everything else here: the caller owns the mailbox, the
    tracker and the decision about whether to act. This endpoint reads text
    and returns verdicts with the sentence behind each one. It never moves a
    row, and it keeps nothing.

    Errors come back in the body rather than as a status code. One failed
    model call should cost a sync its updates, not its whole run.
    """
    messages = [
        InboxMessage(
            message_id=m.message_id,
            sender=m.sender,
            subject=m.subject,
            received_at=_parse_stamp(m.received_at),
            body=m.body,
        )
        for m in request.messages
    ]
    applications = [
        TrackedApplication(
            job_id=a.job_id,
            company=a.company,
            title=a.title,
            applied_on=a.applied_on,
            current_status=a.current_status,
        )
        for a in request.applications
    ]

    updates, errors = detect_updates(applications, messages)
    return ClassifyInboxResponse(
        updates=[
            DetectedUpdatePayload(
                job_id=u.job_id,
                status=u.status,
                confidence=u.confidence,
                evidence=u.evidence,
            )
            for u in updates
        ],
        errors=errors,
    )


def _parse_stamp(value: str) -> datetime:
    """A date the prompt can show. An unreadable one is not worth failing a
    whole batch over -- the classifier uses it for context, not arithmetic."""
    if not value:
        return datetime.now(timezone.utc)
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc)


class ChatTurnPayload(BaseModel):
    role: str = "user"
    content: str = ""


class ApplicationChatRequest(BaseModel):
    profile: CandidateProfile
    cv_text: str = ""
    history: List[ChatTurnPayload] = Field(default_factory=list)
    job: Optional[JobPayload] = None


class ApplicationChatResponse(BaseModel):
    reply: str = ""
    unsupported: List[str] = Field(default_factory=list)
    error: str = ""


@app.post(
    "/application-chat",
    response_model=ApplicationChatResponse,
    dependencies=[Depends(require_token)],
)
def application_chat(request: ApplicationChatRequest) -> ApplicationChatResponse:
    """Draft an answer to an open question on an application form.

    Stateless like the rest of this service: the caller owns the transcript
    and sends it whole each turn. Nothing is kept here.

    The model is told it may only claim what the CV supports, and reports
    anything the question asked for that it could not back -- see
    application_chat.py. That is the difference between this and pasting the
    question into a chatbot that has never seen the CV.
    """
    history = [
        ChatTurn(role="assistant" if t.role == "assistant" else "user", content=t.content)
        for t in request.history
        if t.content.strip()
    ]
    if not history:
        return ApplicationChatResponse(error="Ask a question to start.")

    try:
        answer = answer_application_question(
            request.profile,
            request.cv_text,
            history,
            request.job.to_job() if request.job else None,
        )
    except Exception as exc:
        # Returned rather than raised: a drafting panel should say "that did
        # not work, try again" in the conversation, not collapse the page.
        return ApplicationChatResponse(error=f"Could not draft an answer: {exc}")

    return ApplicationChatResponse(reply=answer.reply, unsupported=answer.unsupported)


def main() -> None:
    import uvicorn

    config.load_env()
    uvicorn.run(
        app,
        host=os.getenv("SCOUT_HOST", "127.0.0.1"),
        port=int(os.getenv("SCOUT_PORT", "8000")),
        log_level="info",
    )


if __name__ == "__main__":
    main()
