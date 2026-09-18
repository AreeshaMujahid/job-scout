"""Job Scout -- upload a CV, get rated jobs with the reasoning attached.

Run with:  streamlit run job_scout/app.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import streamlit as st

# Allow `streamlit run job_scout/app.py` from the repo root without installing
# the package: Streamlit puts the script's own folder on sys.path, not its
# parent, so the absolute `job_scout.` imports below would otherwise fail.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job_scout import cv_editor, cv_inplace, llm, pipeline  # noqa: E402
from job_scout.cv_reader import SUPPORTED, UnreadableCV  # noqa: E402
from job_scout.sources import BOARDS  # noqa: E402

st.set_page_config(page_title="Job Scout", page_icon=":material/travel_explore:", layout="wide")

VERDICT_STYLE = {
    "strong": ("#0f7b3d", "Strong match"),
    "good": ("#1f6feb", "Good match"),
    "stretch": ("#b45309", "Stretch"),
    "weak": ("#6b7280", "Weak"),
}


def score_colour(score: int) -> str:
    if score >= 80:
        return "#0f7b3d"
    if score >= 65:
        return "#1f6feb"
    if score >= 50:
        return "#b45309"
    return "#6b7280"


def bullet_list(heading: str, items: list[str]) -> str:
    body = "\n".join(f"- {item}" for item in items) if items else "- none listed"
    return f"**{heading}**\n{body}"


def render_tailor_cv(job, profile, result) -> None:
    """The 'Tailor my CV' expander for one job card.

    Offers YOUR PDF back with a few words swapped -- not a rebuilt one. Only
    available for a PDF upload, because the edits are applied to the original
    file; there is nothing to edit in place for a .docx or .txt.
    """
    state_key = f"tailored_{job.key}"
    filename = st.session_state.get("cv_filename", "")

    if not filename.lower().endswith(".pdf"):
        st.caption(
            "This edits your original PDF in place, so it needs a PDF upload. "
            f"Yours was `{filename or 'not a PDF'}` -- re-upload as PDF to use it."
        )
        return

    confirmed_key = f"tailor_confirmed_{job.key}"

    def suggest(extra_skills: str) -> None:
        try:
            with st.spinner("Reading the posting against your CV..."):
                st.session_state[state_key] = cv_editor.suggest_keyword_edits(
                    result.cv_text,
                    profile,
                    job_description=job.description,
                    job_title=job.title,
                    company=job.company,
                    extra_skills=extra_skills,
                )
        except llm.LLMError as exc:
            st.session_state.pop(state_key, None)
            st.error(f"The model could not be reached: {exc}", icon=":material/cloud_off:")

    if st.button("Tailor my CV for this job", key=f"tailor_btn_{job.key}"):
        st.session_state.pop(confirmed_key, None)
        suggest("")

    suggested = st.session_state.get(state_key)
    if suggested is None:
        return

    # What the posting wants and the CV does not show. Offered as a question
    # rather than assumed either way: a skill can be absent from a CV because
    # the candidate lacks it OR because they never wrote it down, and only
    # they know which. Nothing here is ticked by default.
    if suggested.missing_skills:
        st.markdown("**This job asks for these, and your CV does not show them**")
        st.caption(
            "Tick anything you actually have and can talk through in an interview -- "
            "it will be added to your skills. Leave the rest; they stay off your CV."
        )
        chosen = [
            skill
            for skill in suggested.missing_skills
            if st.checkbox(skill, key=f"tailor_missing_{job.key}_{skill}")
        ]
        if chosen and st.button(
            f"Add {len(chosen)} to my CV", key=f"tailor_confirm_{job.key}", type="primary"
        ):
            st.session_state[confirmed_key] = chosen
            suggest(", ".join(chosen))
            st.rerun()

    if st.session_state.get(confirmed_key):
        st.caption("Added because you confirmed you have them: "
                   + ", ".join(f"`{s}`" for s in st.session_state[confirmed_key]))

    if not suggested.edits:
        st.caption("Nothing worth swapping -- your CV already uses this posting's language.")
        return

    try:
        pdf_bytes, report = cv_inplace.apply_keyword_edits(
            st.session_state["cv_bytes"], suggested.edits
        )
    except ValueError as exc:
        st.error(str(exc), icon=":material/description_off:")
        return

    if report.applied:
        st.markdown(
            bullet_list(
                "Swapped into your CV",
                [f"`{e.find}` → `{e.replace}`" + (f" — {e.reason}" if e.reason else "")
                 for e in report.applied],
            )
        )
    # Reported rather than hidden: the file is the user's real application
    # document, and they should know which suggestions did not make it in.
    if report.skipped:
        st.caption(
            "Left alone — the phrase was not found in the PDF, or the replacement "
            "would not fit its line (too long would overlap the next word, much "
            "shorter would leave a hole mid-sentence): "
            + ", ".join(f"`{e.find}`" for e in report.skipped)
        )

    if not report.applied:
        return

    safe_company = "".join(c if c.isalnum() else "_" for c in job.company) or "cv"
    st.download_button(
        "Download my CV, tailored",
        data=pdf_bytes,
        file_name=f"CV_{safe_company}.pdf",
        mime="application/pdf",
        icon=":material/download:",
        key=f"tailor_dl_{job.key}",
    )


# ---------------------------------------------------------------- sidebar
with st.sidebar:
    st.header("Your CV")
    upload = st.file_uploader(
        "Upload it", type=[s.lstrip(".") for s in SUPPORTED], label_visibility="collapsed"
    )
    st.caption("PDF, DOCX, TXT or MD. The search terms are read out of the CV.")

    st.header("Where")
    location = st.text_input("Location", placeholder="Germany, London, Karachi...")
    remote_only = st.toggle("Remote only", value=False)
    st.caption("Remote jobs always pass a location filter.")

    st.header("How wide")
    boards = st.multiselect("Boards", list(BOARDS), default=list(BOARDS))
    max_jobs = st.slider("Jobs to rate", 5, 60, 20, step=5)
    strict = st.toggle(
        "Title matches only",
        value=False,
        help="On: the role title must match. Off: also accept jobs that only "
        "mention the role in the description.",
    )
    extra = st.text_input("Extra search terms", placeholder="nlp engineer, data analyst")

    st.divider()
    st.caption(f"Rating with **{llm.model_name()}** via {llm.provider()}.")
    run_clicked = st.button(
        "Find my jobs", type="primary", use_container_width=True, disabled=upload is None
    )

# ---------------------------------------------------------------- header
st.title("Job Scout")
st.markdown(
    "Upload your CV. Six job boards get searched with terms taken from it, and "
    "every result comes back scored, with the reasons you would want before "
    "spending an evening on an application."
)

# Results outlive the uploader: clearing the file box should not throw away a
# search you just waited a minute for.
if upload is None and "result" not in st.session_state:
    st.info("Upload a CV in the sidebar to start.", icon=":material/upload_file:")
    with st.expander("Where the jobs come from"):
        st.markdown(
            "\n".join(
                f"- **{name}** — {'remote-first board' if remote else 'includes on-site roles'}"
                for name, (_, remote) in BOARDS.items()
            )
            + "\n\nAll six are public APIs. No accounts, no keys, no scraping."
        )
    st.stop()

# ---------------------------------------------------------------- run
if run_clicked:
    status = st.empty()
    bar = st.progress(0.0, text="Starting...")

    try:
        with st.spinner("Working..."):
            result = pipeline.run(
                upload.getvalue(),
                upload.name,
                location=location,
                remote_only=remote_only,
                boards=boards or None,
                extra_queries=[q.strip() for q in extra.split(",") if q.strip()],
                max_jobs=max_jobs,
                min_relevance=3 if strict else 2,
                on_status=lambda m: status.info(m, icon=":material/hourglass:"),
                on_progress=lambda done, total: bar.progress(
                    done / max(total, 1), text=f"Rated {done} of {total} jobs"
                ),
            )
        st.session_state["result"] = result
        st.session_state["cv_bytes"] = upload.getvalue()
        st.session_state["cv_filename"] = upload.name
        st.session_state.pop("tailored_cv", None)
    except UnreadableCV as exc:
        st.session_state.pop("result", None)
        st.error(str(exc), icon=":material/description_off:")
    except llm.LLMError as exc:
        st.session_state.pop("result", None)
        st.error(f"The model could not be reached: {exc}", icon=":material/cloud_off:")
    finally:
        bar.empty()
        status.empty()

result = st.session_state.get("result")
if result is None:
    st.stop()

# ---------------------------------------------------------------- profile
profile = result.profile
st.subheader("What your CV says")
left, right = st.columns([2, 1])
with left:
    st.markdown(f"**{profile.headline}**")
    st.caption(
        f"{profile.seniority.title()} level · {profile.years_experience:g} years · "
        f"{', '.join(profile.domains[:3])}"
    )
    st.markdown("**Searched for:** " + " · ".join(f"`{q}`" for q in result.queries))
with right:
    st.metric("Jobs rated", len(result.rated))
    if result.rated:
        st.metric("Best match", f"{result.rated[0].score}/100")

with st.expander("Strengths and gaps the rater was given"):
    cols = st.columns(2)
    cols[0].markdown(bullet_list("Strengths", profile.strengths))
    cols[1].markdown(bullet_list("Gaps", profile.gaps))

for message in result.errors:
    st.warning(message, icon=":material/warning:")

if not result.rated:
    st.warning(
        "Nothing came back that was worth rating. Try turning off "
        "**Title matches only**, widening the location, or adding search terms.",
        icon=":material/search_off:",
    )
    with st.expander("What each board returned"):
        st.json({"fetched": result.report.fetched, "errors": result.report.errors})
    st.stop()

# ---------------------------------------------------------------- results
st.divider()
head, filt = st.columns([2, 1])
head.subheader("Your matches")
min_score = filt.slider("Minimum score", 0, 100, 0, step=5)

shown = [r for r in result.rated if r.score >= min_score]
st.caption(
    f"Showing {len(shown)} of {len(result.rated)} rated jobs · "
    f"{result.report.total_fetched} postings were read across "
    f"{len(result.report.fetched)} boards"
)

for item in shown:
    job, rating = item.job, item.rating
    colour, label = VERDICT_STYLE.get(rating.verdict, VERDICT_STYLE["weak"])

    with st.container(border=True):
        title_col, score_col = st.columns([5, 1])
        with title_col:
            st.markdown(f"### [{job.title}]({job.url})")
            bits = [f"**{job.company}**", job.location or "location not stated", job.source]
            if job.salary:
                bits.append(job.salary)
            if job.posted_at:
                bits.append(job.posted_at)
            st.caption(" · ".join(bits))
        with score_col:
            st.markdown(
                f"<div style='text-align:right'>"
                f"<span style='font-size:2.2rem;font-weight:700;"
                f"color:{score_colour(rating.score)}'>{rating.score}</span>"
                f"<div style='color:{colour};font-weight:600'>{label}</div></div>",
                unsafe_allow_html=True,
            )

        st.markdown(bullet_list("Why you should apply", rating.why_pick))
        st.markdown(bullet_list("What to watch out for", rating.concerns))

        a, b, c = st.columns(3)
        a.progress(rating.skills_match / 100, text=f"Skills {rating.skills_match}")
        b.progress(rating.experience_match / 100, text=f"Experience {rating.experience_match}")
        c.progress(rating.domain_match / 100, text=f"Domain {rating.domain_match}")

        with st.expander("Skills, and an opening line"):
            have, lack = st.columns(2)
            have.markdown(bullet_list("They ask for, and you have", rating.matched_skills))
            lack.markdown(bullet_list("They ask for, and you do not", rating.missing_skills))
            st.markdown("**Open your application with**")
            st.code(rating.pitch, language=None, wrap_lines=True)

        with st.expander("Tailor my CV for this job"):
            render_tailor_cv(job, profile, result)

# ---------------------------------------------------------------- export
st.divider()
payload = [
    {
        "score": r.score,
        "verdict": r.rating.verdict,
        "title": r.job.title,
        "company": r.job.company,
        "location": r.job.location,
        "source": r.job.source,
        "url": r.job.url,
        "why_pick": r.rating.why_pick,
        "concerns": r.rating.concerns,
        "matched_skills": r.rating.matched_skills,
        "missing_skills": r.rating.missing_skills,
        "pitch": r.rating.pitch,
    }
    for r in shown
]
st.download_button(
    "Download these results as JSON",
    data=json.dumps(payload, indent=2, ensure_ascii=False),
    file_name="job_scout_results.json",
    mime="application/json",
    icon=":material/download:",
)
