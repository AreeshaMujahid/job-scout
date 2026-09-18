"""Read the CV once, and decide what to search for.

The search terms come out of the CV rather than a text box, because that is
the difference between a job board and this: you upload the CV and it already
knows that you are looking for "machine learning engineer" and not, say,
"python".
"""
from __future__ import annotations

from .llm import structured
from .models import CandidateProfile

_SYSTEM = """You read CVs and summarise them for a job-matching system.

Rules:
- Report only what the CV evidences. Never invent a skill, an employer, or a year.
- years_experience counts professional work, not study. Internships count as half.
- search_queries must be job titles a board would actually list, in the
  candidate's own field and at their own level. Two to four words each.
  Good: "data scientist", "machine learning engineer", "nlp engineer".
  Bad: "python", "AI", "remote work", "senior role at a good company".
- gaps must be specific and useful, e.g. "no production MLOps experience",
  not "could improve communication skills".
"""


def build_profile(cv_text: str) -> CandidateProfile:
    """Summarise a CV into the profile that drives search and rating."""
    # 20k characters is roughly a six-page CV. Past that it is publication
    # lists and references, which do not change the search terms.
    excerpt = cv_text[:20000]
    return structured(
        CandidateProfile,
        _SYSTEM,
        f"Here is the CV:\n\n<cv>\n{excerpt}\n</cv>\n\nSummarise it.",
        max_tokens=3000,
    )
