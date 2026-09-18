"""Decide which words in a CV should become the posting's words.

Reuses rating.py's profile block for the same reason cover_letter.py does --
the model should describe this CV under the same standard everywhere it is
shown one, not a looser one here.

The output is a handful of find-and-replace pairs, not a rewritten CV. See
cv_inplace.py for why that is the only shape that can be applied to a real
CV without destroying its design.
"""
from __future__ import annotations

import re

from typing import List

from .llm import structured
from .models import CandidateProfile, CVKeywordEdit, CVKeywordEdits, JobRequirements
from .rating import _profile_block

_SYSTEM = """You retune the WORDING of one candidate's CV so it uses the vocabulary
of one job posting. You do not rewrite the CV, and you do not change any fact in it.

Your entire output is a list of find-and-replace pairs that will be applied to
the candidate's real PDF, in place. Everything you do not name stays exactly
as it is.

THE HARD RULES
1. `find` must be copied character-for-character from the CV text you are
   given -- same words, same capitalisation, same punctuation. If it does not
   appear verbatim, the edit is discarded.
2. `find` must be SHORT -- ideally two to five words, and never more than
   about 40 characters. Quote only the words that are actually changing, not
   the sentence around them. A CV line wraps in the real document, so a long
   `find` cannot be located in it and the edit is thrown away.
   Right:  find "Data Specialist", replace "AI Engineer"
   Wrong:  find "Passionate Data Specialist focused on building scalable,
           data-driven AI systems." -- the sentence is not what changed.
3. Never change a fact: no employer, job title, date, metric, percentage,
   tool, or degree may become a different one. "increased conversions by 28%"
   may not become 30%, and may not become a different metric.
4. Never introduce a skill, tool or claim the CV and profile do not already
   evidence. Rewording what is true is the whole job; inventing is never
   allowed, no matter how heavily the posting weights it. This rule bites
   hardest on rule 6 below -- a skills list is the easiest place in a CV to
   quietly add something untrue, and the most damaging place to be caught.

THERE ARE TWO KINDS OF EDIT. USE BOTH.

5. SWAP -- change a term in the middle of a sentence.
   Here `replace` must be CLOSE TO THE SAME LENGTH as `find`: it is drawn
   into the exact space the original occupied and the rest of the line does
   not move, so much longer is refused and much shorter leaves a visible hole.
   - "automated deploy pipeline" -> "CI/CD pipeline" (the CV already did
     CI/CD, it just never used the word)
   - "recommendation engine" -> "recommender system"
   - the summary's own self-description, e.g. "Data Specialist" ->
     "AI Engineer", when the posting's title genuinely matches their
     experience. NEVER the job titles they actually held at an employer --
     those are facts.

6. EXTEND A LIST -- add terms to the END of a line that is a list.
   A line that ends a list ("Programming: Python, SQL, T-SQL, Bash", "RAG /
   LLM Tools: LangChain, FAISS, Vector DBs") has EMPTY SPACE to its right, so
   here `replace` SHOULD be longer: quote the last few items as `find` and
   give them back plus the posting's terms. Roughly 15-25 extra characters
   fit; beyond that it is refused.
   - find "LangChain, FAISS, Vector DBs"
     replace "LangChain, FAISS, Vector DBs, RAG, Prompt Engineering"
   - find "Scikit-learn, PyTorch, TensorFlow, XGBoost"
     replace "Scikit-learn, PyTorch, TensorFlow, XGBoost, Hugging Face"
   NEVER DELETE AN EXISTING ITEM TO MAKE ROOM. Every term already on the
   line must still be there afterwards. If the new terms do not fit, propose
   fewer of them -- losing a skill the candidate really has is a worse
   outcome than missing a keyword they do not. ("Power BI, Seaborn,
   Matplotlib, Cognos" -> "Power BI, Seaborn, Tableau, Plotly" is the mistake
   this is warning about: two real tools silently dropped.)
   This is usually where the most keyword value is, because a screen reads
   the skills block first. Go through EVERY list line in the CV -- languages,
   frameworks, MLOps, cloud, databases, visualisation, tools -- and extend
   each one where the posting names something the candidate demonstrably
   already does elsewhere in the CV. Adding a tool that appears nowhere in
   their experience is a lie; adding one their bullets describe using, which
   the skills list happens to omit, is the single most useful edit you can
   make.

7. THE ONE EXCEPTION TO RULE 4. If the CV has a line the candidate has
   labelled as things they are picking up -- "Currently learning:",
   "Familiar with:", "Working knowledge of:" -- then a skill the posting
   wants and the CV does not otherwise evidence MAY be added to THAT line,
   and only that line. The line states the limitation itself, so it is
   honest, and a keyword screen still matches it. Never move such a term
   into the main skills list to make it look stronger.

WHAT IS NOT AN EDIT
- Fixing typos, tightening prose, or improving the CV in general. If it is not
  bringing in the posting's language, leave it alone.
- A skill nothing in the CV evidences. That does NOT go in an edit; it goes in
  `missing_skills`.

MISSING_SKILLS
List every skill or tool the posting asks for that the CV does not evidence.
Short names only, exactly as they would be written on a skills line --
"Kubernetes", "Terraform", "Kafka" -- never sentences or explanations.
These are shown back to the candidate to confirm, because only they know
whether a skill is absent because they lack it or because they never wrote it
down. Be generous here: a skill you leave out is one they never get asked
about. Do not repeat anything the CV already shows.

Propose as many sound edits as the CV genuinely supports -- typically 6 to 12
across both kinds, most valuable first. Do not stop at three: an unextended
skills line that the posting asks about is a missed keyword. Zero edits is
still a correct answer when the CV already speaks the posting's language.
"""


_REQUIREMENTS_SYSTEM = """You read one job advert and list what it asks for.

Nothing about any candidate is involved: you are cataloguing the advert, and
the same advert must always produce the same list.

- Short names only, as they would be written on a CV's skills line:
  "Kubernetes", "PyTorch", "Airflow", "German (C1)", "AWS".
- Never sentences, never explanations, never soft qualities like "team
  player" or "attention to detail" -- a keyword screen does not match those.
- Include must-haves and nice-to-haves alike; the reader decides what matters.
- Include a required human language and its level when the advert states one:
  that is the requirement most often missed, and it disqualifies outright.
- Only what the advert genuinely says. Do not add what a job like this
  usually wants.
"""


def extract_required_skills(
    job_description: str, job_title: str = "", company: str = ""
) -> List[str]:
    """What this posting asks for -- a property of the posting alone.

    Separated from suggest_keyword_edits so the answer cannot drift as the
    candidate answers questions about themselves. See JobRequirements.
    """
    if not job_description.strip():
        return []

    header = job_title.strip() or "Role"
    if company.strip():
        header += f" at {company.strip()}"

    result = structured(
        JobRequirements,
        _REQUIREMENTS_SYSTEM,
        f"<posting>\n{header}\n\n{job_description.strip()[:6000]}\n</posting>\n\n"
        f"List everything it asks for.",
        max_tokens=2000,
    )
    # Only what the advert really names -- the same grounding rule the edits
    # are held to, applied to the catalogue it is built from.
    posting = job_description.lower()
    return [s.strip() for s in result.skills if s.strip() and _mentions(posting, s)]


def suggest_keyword_edits(
    cv_text: str,
    profile: CandidateProfile,
    *,
    job_description: str,
    job_title: str = "",
    company: str = "",
    extra_skills: str = "",
    required_skills: List[str] | None = None,
) -> CVKeywordEdits:
    """Which of this CV's words should become this posting's words.

    `extra_skills` is the candidate's own statement of things they can do
    that their CV never got round to mentioning. A CV is a summary, not an
    inventory, and the commonest reason a real skill is missing is that it
    was simply never typed -- which no amount of reading the document can
    tell you. Declared here, such a skill counts as evidenced and may be
    added to the CV, because the person who knows the answer has asserted it.
    Nothing in the model's own head ever gets that status.
    """
    result = _model_proposal(
        cv_text,
        profile,
        job_description=job_description,
        job_title=job_title,
        company=company,
        extra_skills=extra_skills,
    )

    # Extracted once per posting and passed back in on later rounds, so the
    # gaps a candidate is asked about stay the same list getting shorter --
    # not a new list each time they answer.
    if required_skills is None:
        required_skills = extract_required_skills(job_description, job_title, company)

    return _drop_unevidenced_additions(
        result, cv_text, profile, extra_skills, job_description, required_skills
    )


def propose_keyword_edits(
    cv_text: str,
    profile: CandidateProfile,
    *,
    job_description: str,
    job_title: str = "",
    company: str = "",
    extra_skills: str = "",
) -> CVKeywordEdits:
    """The model's raw proposal, before any of it is checked.

    Split out from suggest_keyword_edits so a caller can run this and
    extract_required_skills at the SAME time. They do not depend on each
    other, and on a rate-limited free tier a single call can sit through a
    90-second backoff -- run in sequence, the pair blew a 120-second HTTP
    timeout and the user was told the service had died.

    Nothing here is trustworthy on its own: it still has to go through
    _drop_unevidenced_additions before anything reaches a CV.
    """
    return _model_proposal(
        cv_text,
        profile,
        job_description=job_description,
        job_title=job_title,
        company=company,
        extra_skills=extra_skills,
    )


def _model_proposal(
    cv_text: str,
    profile: CandidateProfile,
    *,
    job_description: str,
    job_title: str = "",
    company: str = "",
    extra_skills: str = "",
) -> CVKeywordEdits:
    """Build the prompt and make the one model call behind both entry points."""
    posting_header = job_title.strip() or "Role"
    if company.strip():
        posting_header += f" at {company.strip()}"

    declared = ""
    if extra_skills.strip():
        declared = (
            f"\n\nALSO TRUE OF THIS CANDIDATE, stated by them, absent from the CV\n"
            f"{extra_skills.strip()}\n"
            f"Treat these as real experience they simply never wrote down. You may "
            f"add them to the relevant skills line."
        )

    user = (
        f"CANDIDATE PROFILE\n{_profile_block(profile)}\n\n"
        f"THEIR CV, VERBATIM -- every `find` must be copied from inside this\n"
        f"<cv>\n{cv_text[:20000]}\n</cv>"
        f"{declared}\n\n"
        f"TARGET POSTING\n<posting>\n{posting_header}\n\n"
        f"{job_description.strip()[:6000]}\n</posting>\n\n"
        f"List the swaps."
    )
    return structured(CVKeywordEdits, _SYSTEM, user, max_tokens=4000)


def _drop_unevidenced_additions(
    result: CVKeywordEdits,
    cv_text: str,
    profile: CandidateProfile,
    extra_skills: str = "",
    job_description: str = "",
    required_skills: List[str] | None = None,
) -> CVKeywordEdits:
    """Refuse any edit that adds a skill the CV does not actually evidence.

    The prompt forbids this in three places and the model does it anyway:
    asked to tailor a CV to a posting wanting "Docker and Kubernetes", it
    extended a real MLOps list with Kubernetes, which appeared nowhere in the
    candidate's CV. That is not a tailored CV, it is a falsified one, and it
    is the applicant -- not the model -- who has to answer for it in an
    interview. An instruction is not a safeguard, so the claim is checked.

    Only ADDITIONS to a list are checked, not rewordings. Replacing
    "recommendation engine" with "recommender system" introduces words absent
    from the CV by design; that is the feature working. Adding a NEW item to
    a comma-separated list is the case where a word not already somewhere in
    the CV means a tool the candidate has never touched.

    A refused term is not thrown away: it joins missing_skills, which is what
    the candidate is shown and asked to confirm. A skill the model wanted to
    invent and a skill the posting simply wants are the same thing from their
    side of the screen -- something to say yes or no to.
    """
    evidence = _evidence_text(cv_text, profile, extra_skills)
    posting = job_description.lower()
    kept: list[CVKeywordEdit] = []

    # The posting's own catalogue when we have one, so the question put to the
    # candidate is the same question each round. The model's per-call
    # missing_skills is only a fallback for callers that cannot cache.
    missing = list(required_skills if required_skills is not None else result.missing_skills)

    for edit in result.edits:
        edit = _keep_what_is_already_there(edit)
        added = _added_list_items(edit.find, edit.replace)

        # Asked for by this posting at all? A term the job advert never
        # mentions cannot be "the posting's vocabulary", whatever the model
        # says its reason is -- it invented JAX and XLA/MLIR for a posting
        # containing neither, and wrote "from candidate context" underneath.
        if any(not _mentions(posting, term) for term in added):
            continue

        unevidenced = [term for term in added if not _is_evidenced(term, evidence)]
        if unevidenced and not _is_a_learning_line(edit.find, cv_text):
            missing.extend(unevidenced)
            continue
        kept.append(edit)

    # Shown to the candidate only if the posting genuinely asks for it, and
    # they have not already confirmed it. Asking about a skill the advert
    # never names wastes the one question that matters, and teaches them to
    # distrust the list.
    still_missing = [
        skill
        for skill in dict.fromkeys(missing)
        if _mentions(posting, skill) and not _is_evidenced(skill, evidence)
    ]
    return CVKeywordEdits(edits=kept, missing_skills=still_missing)


def _mentions(posting: str, term: str) -> bool:
    """Does the job advert actually name this term?

    Everything this feature adds to a CV is justified by "the posting asks
    for it", so that claim is checked rather than taken on trust. With no
    posting text to check against nothing qualifies -- a thin or empty
    description means there is nothing to tailor toward, and guessing what
    such a job "probably" wants is how Kubernetes ends up on a CV for a role
    that never mentioned it.
    """
    if not posting.strip():
        return False
    return _is_evidenced(term, posting)


# A line the candidate has explicitly labelled as things they are picking up,
# rather than things they have done.
_LEARNING_LABEL = re.compile(
    r"^\s*(currently\s+learning|learning|studying|familiar\s+with|exposure\s+to|"
    r"working\s+knowledge(\s+of)?|upskilling(\s+in)?|in\s+progress)\b[:\-]?",
    re.IGNORECASE,
)


def _is_a_learning_line(find: str, cv_text: str) -> bool:
    """Is this edit extending a line the CV itself labels as "learning"?

    Getting past a keyword screen without having the keyword is a real
    problem with an honest answer: say you are learning it, on a line that
    says so. An ATS searching for "Kubernetes" still matches "Currently
    learning: Kubernetes", and a reader sees exactly what is true -- which is
    the difference between a tailored CV and a falsified one.

    So unevidenced terms are allowed HERE and nowhere else: the disclaimer is
    part of the line, and the candidate wrote it themselves.
    """
    needle = find.strip().lower()
    if not needle:
        return False
    for line in cv_text.splitlines():
        if needle in line.strip().lower() and _LEARNING_LABEL.match(line.strip()):
            return True
    return bool(_LEARNING_LABEL.match(find.strip()))


def _evidence_text(cv_text: str, profile: CandidateProfile, extra_skills: str = "") -> str:
    """Everything the candidate can be said to HAVE, as one searchable blob.

    `extra_skills` is included because the candidate said so. The check this
    feeds exists to stop the MODEL inventing skills, not to stop the person
    describing their own experience: a CV omitting something real is the
    ordinary case, and only they can say which. The distinction that matters
    is who is making the claim.

    "Currently learning" lines are excluded on purpose. They are the one
    place an unevidenced skill is allowed to appear, and counting them as
    evidence would let a skill launder itself: name it on the learning line
    once, and it then looks evidenced everywhere, free to be promoted into
    the main skills list as though it were experience. Kept out, a learning
    line stays exactly as strong a claim as it says it is.
    """
    kept_lines = [
        line for line in cv_text.splitlines() if not _LEARNING_LABEL.match(line.strip())
    ]
    return " ".join(
        [
            *kept_lines,
            extra_skills,
            *profile.core_skills,
            *profile.tools,
            *profile.domains,
            *profile.strengths,
        ]
    ).lower()


def _keep_what_is_already_there(edit: CVKeywordEdit) -> CVKeywordEdit:
    """Rebuild a list edit so it only ever APPENDS.

    Told that a replacement has to fit the space the original occupied, the
    model found its own way to make room: it deleted things. "Power BI,
    Seaborn, Matplotlib, Cognos" came back as "Power BI, Seaborn, Tableau,
    Plotly" -- two real tools dropped to fit two new ones in, on a CV the
    candidate then sends to an employer. Losing a skill you actually have is
    a worse outcome than missing a keyword you do not.

    The intent is never in doubt ("add Tableau and Plotly"), so the edit is
    repaired rather than refused: every original item is kept, the new ones
    are appended, and whether that fits is then decided honestly by the
    renderer instead of by quietly discarding the candidate's experience.
    """
    find_items = [item.strip() for item in edit.find.split(",") if item.strip()]
    replace_items = [item.strip() for item in edit.replace.split(",") if item.strip()]
    if len(find_items) < 2 or len(replace_items) < 2:
        return edit

    surviving = {_norm(item) for item in replace_items}
    if all(_norm(item) in surviving for item in find_items):
        return edit  # nothing was dropped

    kept = {_norm(item) for item in find_items}
    appended = [item for item in replace_items if _norm(item) not in kept]
    return CVKeywordEdit(
        find=edit.find,
        replace=", ".join([*find_items, *appended]),
        reason=edit.reason,
    )


def _added_list_items(find: str, replace: str) -> list[str]:
    """Items present in `replace` but not in `find`, for comma-separated lists.

    Returns nothing for an edit that is not list-shaped -- a reworded phrase
    has no "added items", only different words, and is not this check's
    business.
    """
    find_items = [item.strip() for item in find.split(",") if item.strip()]
    replace_items = [item.strip() for item in replace.split(",") if item.strip()]
    if len(find_items) < 2 or len(replace_items) < 2:
        return []

    known = {_norm(item) for item in find_items}
    return [item for item in replace_items if _norm(item) not in known]


def _norm(item: str) -> str:
    """Compare list items ignoring case, spacing and any "Label:" prefix, so
    "MLOps: MLflow" and "MLflow" are the same item and a spacing fix
    ("Databricks,Airflow" -> "Databricks, Airflow") is not read as an
    addition."""
    return re.sub(r"\s+", " ", item.split(":")[-1]).strip().lower()


def _is_evidenced(term: str, evidence: str) -> bool:
    """Does the CV or profile actually show this term anywhere?

    Matched on the term's significant words rather than the whole string, so
    "Hugging Face Transformers" is evidenced by a CV that says "Hugging
    Face", and punctuation or pluralisation differences do not create a false
    alarm. Every significant word must appear -- "Vector Databases" is not
    evidenced by a CV that only ever says "databases".
    """
    words = [w for w in re.split(r"[^a-z0-9+#.]+", _norm(term)) if len(w) > 1]
    if not words:
        return True  # nothing substantive to check
    return all(word in evidence for word in words)


# The check every proposal must pass before it can touch a CV. Exported
# because service.py runs the model calls itself, in parallel, and then has
# to apply exactly this -- not a second copy of the rules.
drop_unevidenced_additions = _drop_unevidenced_additions
