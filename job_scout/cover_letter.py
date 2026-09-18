"""Write a cover letter for one posting, and how to survive its ATS screen.

Deliberately reuses the same profile/job blocks rating.py builds rather than
inventing its own -- the model has already been shown how to describe this
CV and this posting in a way that keeps it from crediting the candidate with
experience they do not have, and there is no reason the letter should be
written under a looser standard than the score was.
"""
from __future__ import annotations

import re

from .llm import structured
from .models import CandidateProfile, CoverLetterResult, Job
from .rating import _job_block, _profile_block

_SYSTEM = """You write cover letters for one job seeker, one posting at a time.

You get their profile (from their CV) and the posting they want to apply to.
Also, when given, the gaps a separate scoring pass already found: their
missing_skills and concerns for this exact posting. Do not re-derive these --
treat them as already-established fact about where the CV falls short.

THE LETTER
- 200-350 words. Three or four paragraphs: why this role/company
  specifically (not "I am excited about this opportunity" -- name something
  real from the posting), two or three concrete points of overlap between
  the CV and what the posting asks for, and a short close.
- Every claim must be traceable to something the profile actually states. If
  the profile lists "built a RAG pipeline at Meezan Bank," the letter can say
  that; it cannot upgrade it to "led a team of 12" because the posting wants
  a manager.
- Never claim a missing_skill as though it were possessed. If a real gap
  matters enough to address, name it honestly and pair it with what is true
  instead ("while I have not shipped Kubernetes to production, I have run
  the equivalent orchestration problem with ECS at scale") -- do not simply
  omit it and hope nobody asks.
- Address the company by name. If a specific product, mission, or detail from
  the posting is available, use it once -- generic enough to paste into any
  application reads as exactly that to whoever is screening it.
- No placeholder brackets of any kind ([Company Name], [Hiring Manager]) --
  if a detail is not known, write around it rather than leaving a gap to fill.
- End with a sign-off line ("Sincerely," or similar) followed on its own line
  by exactly the token {{SIGNATURE}} and nothing else -- not the candidate's
  name, not a guess, not the word "Unknown". The real name is inserted
  afterwards by code that knows it reliably; profile extraction sometimes
  fails to find a name at all, and a wrong or missing name signed onto a real
  application is worse than a template marker that gets replaced.

THE CV SUGGESTIONS
- 2-5 items. Each names the EXACT term or phrase the posting uses, and
  either (a) where the CV already has the substance but not the word --
  quote or closely paraphrase the CV bullet that has it -- or (b) that the
  posting weights this heavily and the CV does not evidence it at all, which
  is worth knowing even though there is no honest fix to suggest here.
- These are ATS/recruiter-keyword fixes, not career advice. "Consider
  learning Kubernetes" is not a CV suggestion; "your CV never uses the words
  'CI/CD' even though the Meezan Bank bullet describes exactly that -- add
  the term" is.
- Never suggest adding a skill, tool, or claim the profile gives no evidence
  the candidate actually has. Rewording existing truth is always fine;
  inventing new truth is never fine, in the letter or in these suggestions.
"""


def generate_cover_letter(
    profile: CandidateProfile,
    job: Job,
    *,
    missing_skills: list[str] | None = None,
    concerns: list[str] | None = None,
    extra_context: str = "",
) -> CoverLetterResult:
    profile_text = _profile_block(profile, extra_context)
    job_text = _job_block(1, job)

    known_gaps = ""
    if missing_skills or concerns:
        parts = []
        if missing_skills:
            parts.append(f"Missing skills already identified: {', '.join(missing_skills)}")
        if concerns:
            parts.append(f"Concerns already identified: {'; '.join(concerns)}")
        known_gaps = "\n\nALREADY KNOWN ABOUT THIS MATCH\n" + "\n".join(parts)

    user = (
        f"CANDIDATE\n{profile_text}\n\n"
        f"POSTING\n{job_text}"
        f"{known_gaps}\n\n"
        f"Write the cover letter and the CV suggestions."
    )
    result = structured(CoverLetterResult, _SYSTEM, user, max_tokens=3000)
    result.letter = _apply_signature(result.letter, profile.name)
    return result


def _apply_signature(letter: str, name: str | None) -> str:
    """Replace the model's {{SIGNATURE}} marker with a real name, or remove
    it cleanly if there is no real name to put there.

    Never trusts the model to have written the right name itself -- CV name
    extraction can and does fail (profile.name defaults to the literal
    string "Unknown" when it does), and nothing else in the app surfaces
    that failure to the user before now: onboarding shows headline,
    seniority and domains, never name. A cover letter is the first place a
    bad extraction would become visible, and "Sincerely, Unknown" on a real
    application is worse than a blank line the applicant fills in by hand.

    The marker is matched together with any whitespace and newline before
    it, then replaced with exactly one newline. The model does not reliably
    put it on its own line: the same naive str.replace in the follow-up
    drafter produced "Best regards,Areesha Mujahid" run together, and the
    only reason it had not shown up here yet was luck about where the model
    chose to break the line.
    """
    marker = re.compile(r"[ \t]*\n?[ \t]*\{\{SIGNATURE\}\}")
    real_name = (name or "").strip()
    if real_name.lower() in ("", "unknown"):
        # Leave the sign-off line ("Sincerely,") but drop the marker under
        # it rather than leave {{SIGNATURE}} visible in the output.
        return marker.sub("", letter).rstrip()
    return marker.sub("\n" + real_name, letter).rstrip()
