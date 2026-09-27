"""Tests for the parts that do not need the network or a model.

Run with:  python -m job_scout.tests

No pytest: this project ships with no test dependency, so the runner is the
twenty lines at the bottom.
"""
from __future__ import annotations

import io
import zipfile

import fitz

from .cv_reader import UnreadableCV, read_cv
from .llm import LLMError
from .cv_inplace import apply_keyword_edits
from .models import CVKeywordEdit, Job
from .sources import fetch_all
from .sources._common import clean_html, location_ok, relevance

QUERIES = ["data scientist", "machine learning engineer", "ai engineer"]

# These tests are about the evidence rules, not about grounding, so they
# share a posting that names every term they use -- otherwise the separate
# "the advert must actually ask for it" guard would reject them first.
ASKS_FOR_EVERYTHING = (
    "We need Kubernetes, Terraform and Go, plus recommender systems "
    "and a recommendation engine."
)


def test_countries_are_recognised_however_a_board_spells_them():
    """Each board writes locations its own way, and all of them are valid."""
    from .sources.places import countries_in

    assert countries_in("Paris, Ile-de-France, France") == {"france"}
    assert countries_in("Kaarst, Nordrhein-Westfalen, Deutschland") == {"germany"}
    assert countries_in("Koln") == {"germany"}                    # city stands in
    assert countries_in("Cary, NC") == {"united states"}          # US state code
    assert countries_in("Toronto, ON") == {"canada"}
    assert countries_in("Tokyo, Tokyo, Japan") == {"japan"}
    assert countries_in("Canada,  USA") == {"canada", "united states"}
    assert "germany" in countries_in("Europe")                    # region expands
    # Names no country at all -- a real answer, not a failure.
    assert countries_in("Greater Nantes Metropolitan Area") == {"france"}
    assert countries_in("Anywhere") == set()


def test_ile_de_france_is_not_germany():
    """"Ile-de-France" split on its hyphens left a field "de", which resolved
    to Germany and put French postings in a German search."""
    from .sources.places import countries_in

    assert countries_in("Paris, Ile-de-France, France") == {"france"}


def test_a_city_search_does_not_accept_another_city():
    """"Germany" should accept a Munich posting; "Berlin" must not."""
    from .sources.places import matches

    assert matches("Germany", "Munich, Bavaria, Germany", source_filtered=True)
    assert not matches("Berlin", "Munich, Bavaria, Germany", source_filtered=True)
    # ...but the same city under another spelling is the same city.
    assert matches("Munich", "Muenchen, Germany", source_filtered=True)
    assert matches("Cologne", "Koln", source_filtered=False)


def test_an_unattributable_location_depends_on_who_filtered():
    """LinkedIn's "Greater X Area" names no country.

    When the board already filtered by country it cannot be evidence of the
    wrong one, so it is kept -- that format was being dropped in every
    country. When we are the only filter, it stays unverifiable.
    """
    from .sources.places import matches

    assert matches("France", "Greater Nantes Metropolitan Area", source_filtered=True)
    assert not matches("France", "Greater Springfield Area", source_filtered=False)
    # A different country is still a rejection either way.
    assert not matches("France", "Barcelona, Catalonia, Spain", source_filtered=True)


def test_relevance_reads_german_and_abbreviated_titles():
    """A German board advertises "KI Engineer", not "AI Engineer".

    KI is Kuenstliche Intelligenz. Measured on a real StepStone search for
    four AI titles in Germany, the English-only matcher discarded the whole
    German-language half of the board as though those postings were about
    nothing -- including "AI Engineer / KI-Entwickler (m/w/d)", which says
    it in both languages.
    """
    roles = ["data scientist", "machine learning engineer", "ai engineer"]

    for title in [
        "KI Engineer (m/w/d)",                        # AI, in German
        "AI Engineer / KI-Entwickler (m/w/d)",        # both languages at once
        "Senior ML Engineer (all genders)",           # initials for the phrase
        "(Associate) Manager Data Science & AI",      # science, not scientist
        "Data Scientist (m/w/d) - Computer Vision & KI",
    ]:
        assert relevance(title, [], "", roles) == 3, title


def test_relevance_still_rejects_what_it_always_rejected():
    """The aliases must widen the net, not tear a hole in it.

    Each of these was correctly discarded before the German and abbreviation
    aliases existed, and a table of synonyms is exactly the change that
    quietly starts admitting everything.
    """
    roles = ["data scientist", "machine learning engineer", "ai engineer"]

    for title in [
        "IT Consultant - SAP Fiori / ABAP / User Experience (m/w/d)",
        "Mitarbeiter Kundendatenmanagement (m/w/d)",
        "Citizen Developer (w/m/div.)",
        "Ingenieur (m/w/d) fuer Anomaliedetektion und Prozessanalytik",
    ]:
        assert relevance(title, [], "", roles) == 0, title


def test_a_phrase_contraction_does_not_answer_the_whole_query():
    """"ML" stands in for "machine learning" and for nothing else.

    Striking a contracted phrase off the query must not strike off the words
    around it, or "ML" alone would satisfy "machine learning engineer" and
    every MLOps posting would arrive as an engineering vacancy.
    """
    assert relevance("ML Scientist", [], "", ["machine learning engineer"]) == 0
    assert relevance("ML Engineer", [], "", ["machine learning engineer"]) == 3


def test_german_study_routes_are_not_entry_level_jobs():
    """A Duales Studium is a degree and an Abschlussarbeit is a thesis.

    German boards list both beside real vacancies, and to an English eye they
    read as junior roles -- so a search for Entry level returned university
    places. They sit at Internship: excluded from an Entry level search,
    still reachable by someone who wants them.
    """
    from .sources.seniority import level_of, matches

    wanted = ["Entry level", "Associate"]
    for title in [
        "Duales Studium Informatik Schwerpunkt Data Science",
        "Abschlussarbeit AI-Powered Transformation Office (m/w/d)",
        "Ausbildung Fachinformatiker Anwendungsentwicklung",
        "Masterarbeit Machine Learning (m/w/d)",
    ]:
        assert level_of(title) == "Internship", title
        assert not matches(title, levels=wanted), title

    # And the real entry-level jobs beside them are untouched.
    for title in ["Junior Machine Learning Engineer (m/w/d)", "Data Scientist (m/w/d)"]:
        assert matches(title, levels=wanted), title


def test_a_human_check_is_told_apart_from_an_empty_result():
    """Indeed shows a Cloudflare box instead of jobs, and the two look the
    same from the code's side: no .job_seen_beacon either way.

    They need opposite responses. An empty search should move on quietly; a
    human check should wait, because the window is open on someone's screen
    and a tick is all it needs. Before this the run gave up after twenty
    seconds and reported "Indeed returned nothing", which sent the reader
    off to widen their filters over a box nobody had clicked.
    """
    from .sources.boards import _challenged

    class Page:
        def __init__(self, selector=None, title=""):
            self._selector, self._title = selector, title

        def query_selector(self, _css):
            return self._selector

        def title(self):
            return self._title

    # The challenge's own furniture, whatever language it is written in.
    assert _challenged(Page(selector=object()))
    assert _challenged(Page(title="Just a moment..."))
    assert _challenged(Page(title="Additional Verification Required"))

    # A page that simply had no results is not a challenge.
    assert not _challenged(Page(title="data scientist Jobs in Berlin | Indeed.com"))
    assert not _challenged(Page(title=""))


def test_a_page_that_throws_is_not_read_as_a_human_check():
    """A closed or crashed page must not be mistaken for a challenge.

    If it were, the run would sit and wait two minutes for someone to tick a
    box on a window that is not there.
    """
    from .sources.boards import _challenged

    class Broken:
        def query_selector(self, _css):
            raise RuntimeError("target closed")

        def title(self):
            raise RuntimeError("target closed")

    assert not _challenged(Broken())


def test_title_matching_accepts_the_same_job_under_another_name():
    """The bot's rule wanted every query word in the title, which threw away
    real postings: a search for "Senior Data Scientist" rejected "Data
    Scientist (m/w/d)", and "Machine Learning Engineer" rejected "ML
    Engineer". Same job, different house style.
    """
    from .sources.titles import title_matches

    keep = [
        ("Data Scientist (m/w/d)", "Senior Data Scientist"),        # seniority is noise
        ("ML Engineer", "Machine Learning Engineer"),               # spelled out vs initials
        ("Machine Learning Engineer", "ML Engineer"),               # and back again
        ("Android Engineer", "Android Developer"),                  # engineer == developer
        ("Front-End Developer", "Frontend Developer"),              # a hyphen is a separator
        ("Software Development Engineer", "Software Developer"),    # three words answer two
        ("AI/ML Engineering Manager", "ML Engineer"),               # slashes split
        ("Werkstudent Data Science", "Data Scientist"),             # scientist == science
        ("Developer Advocate", "develop"),                          # half a word still finds it
    ]
    for title, query in keep:
        assert title_matches(title, query), f"{query!r} should have matched {title!r}"


def test_a_typo_in_the_search_still_finds_the_job():
    """A search for "marketting manager" in the UAE returned nothing.

    LinkedIn coped with the typo and sent back ten Marketing Manager postings
    in Dubai; every one was then dropped here, because "marketting" is not
    "marketing". Typing a title from memory is exactly where a double letter
    creeps in, and silence gives no clue what went wrong.
    """
    from .sources.titles import title_matches

    for title, query in [
        ("Marketing Manager", "marketting manager"),   # doubled letter
        ("Marketing Manager", "marketing manger"),     # dropped letter
        ("Android Developer", "andriod developer"),    # two letters swapped
        ("Data Scientist", "data scientst"),
        ("Software Engineer", "sofware engineer"),
        ("Business Analyst", "buisness analyst"),
        ("Accountant", "acountant"),
    ]:
        assert title_matches(title, query), f"{query!r} should have found {title!r}"


def test_a_typo_allowance_does_not_merge_different_jobs():
    """One edit must not turn one role into a neighbouring one."""
    from .sources.titles import title_matches

    for title, query in [
        ("Data Engineer", "Data Scientist"),
        ("Data Analyst", "Data Scientist"),
        ("Product Manager", "Marketing Manager"),
        ("Sales Manager", "Marketing Manager"),
    ]:
        assert not title_matches(title, query), f"{query!r} should NOT match {title!r}"


def test_a_mistyped_country_still_matches():
    """Same allowance, and only for what the user typed -- never for a
    posting's own location, which is authoritative."""
    from .sources.places import matches

    assert matches("Germny", "Berlin, Germany", source_filtered=True)
    assert matches("Nederlands", "Amsterdam, Netherlands", source_filtered=True)
    assert matches("uae", "Dubai, United Arab Emirates", source_filtered=True)
    # A real, different country is still a rejection.
    assert not matches("France", "Madrid, Spain", source_filtered=True)


def test_title_matching_still_rejects_a_different_job():
    """Looser is not "anything sharing a word". "Data Engineer" and "Data
    Scientist" share "data" and are different jobs; letting that through
    spends a rating call, and a slice of the model's per-minute quota, on a
    posting the score would then bury.
    """
    from .sources.titles import title_matches

    drop = [
        ("Data Engineer", "Data Scientist"),
        ("Data Analyst", "Data Scientist"),
        ("Backend Developer C#/.NET", "Data Scientist"),
        ("Marketing Manager", "Android Developer"),
        ("Nurse Practitioner", "Data Scientist"),
    ]
    for title, query in drop:
        assert not title_matches(title, query), f"{query!r} should NOT have matched {title!r}"


def test_the_bot_keeps_its_own_stricter_title_rule():
    """The looser rule is rebound onto the bot's module, so this pins down
    that it is scoped to a process rather than an edit to linkedin.py -- the
    bot runs separately and its behaviour must not move underneath it.
    """
    import inspect

    from .sources import scrapers as scrapers_module

    if not scrapers_module.SCRAPERS:
        return  # the bot is not present; nothing to protect

    source = inspect.getsource(scrapers_module)
    assert "_bot._title_matches_keywords = _title_matches" in source
    # The bot's own definition is still there, untouched, for its own process.
    import linkedin

    assert "def _title_matches_keywords" in inspect.getsource(linkedin)


def test_relevance_needs_whole_words():
    """"ai" lives inside "blockchain" and "Rails" -- neither is an AI job."""
    assert relevance("Blockchain Security Engineer", [], "", QUERIES) == 0
    assert relevance("Tech Lead Full-Stack Rails Engineer", [], "", QUERIES) == 0


def test_relevance_ranks_title_above_body():
    assert relevance("Senior Data Scientist", [], "", QUERIES) == 3
    assert relevance("Quant Analyst", ["data", "scientist"], "", QUERIES) == 2
    body = "You will work alongside our data scientist team on pricing."
    assert relevance("Quant Analyst", [], body, QUERIES) == 1


def test_relevance_tolerates_a_short_suffix():
    """"engineer" has to match "AI/ML Engineering Manager"."""
    assert relevance("AI/ML Engineering Manager", [], "", QUERIES) == 3
    # ...but not an unrelated long word that merely starts the same way.
    assert relevance("Engineering Recruiter", [], "", ["ai engineer"]) == 0


def test_location_accepts_cities_of_the_named_country():
    assert location_ok("Berlin, Germany", False, "Germany", False)
    assert location_ok("München", False, "germany", False)
    assert not location_ok("Austin, TX", False, "Germany", False)


def test_location_accepts_several_places_at_once():
    """People are rarely willing to move to exactly one city."""
    assert location_ok("Berlin, Germany", False, "Munich, Berlin", False)
    assert location_ok("München", False, "Berlin, Munich", False)
    assert not location_ok("Austin, TX", False, "Munich, Berlin", False)


def test_remote_always_passes_a_location_filter():
    assert location_ok("Anywhere", True, "Germany", False)
    assert location_ok("Remote", False, "Karachi", False)


def test_remote_only_rejects_onsite():
    assert not location_ok("Berlin, Germany", False, "", True)
    assert location_ok("Remote, Europe", True, "", True)


def test_duplicate_key_survives_formatting_differences():
    a = Job(source="A", title="Senior Data Scientist", company="Acme", url="u1")
    b = Job(source="B", title="senior  data   scientist", company="ACME", url="u2")
    c = Job(source="C", title="Data Engineer", company="Acme", url="u3")
    assert a.key == b.key
    assert a.key != c.key


def test_clean_html_keeps_the_words_and_drops_the_markup():
    out = clean_html("<p>Build <b>RAG</b> systems</p><script>evil()</script><li>Python</li>")
    assert "RAG" in out and "Python" in out
    assert "<" not in out and "evil" not in out


def test_clean_html_unescapes_entities():
    assert clean_html("<p>R&amp;D team</p>") == "R&D team"


def test_docx_is_read_without_python_docx():
    xml = (
        '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
        "<w:p><w:r><w:t>Jane Doe</w:t></w:r></w:p>"
        "<w:p><w:r><w:t>Data scientist with five years of production ML "
        "experience across banking and retail forecasting, working in Python, "
        "SQL and Spark on pipelines that served daily risk scores.</w:t></w:r></w:p>"
        "</w:body></w:document>"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("word/document.xml", xml)

    text = read_cv(buffer.getvalue(), "cv.docx")
    assert "Jane Doe" in text
    assert "production ML" in text
    # Paragraphs must not run together into one word.
    assert "DoeData" not in text


def test_an_empty_cv_is_rejected_not_sent_to_the_model():
    try:
        read_cv(b"hi", "cv.txt")
    except UnreadableCV:
        return
    raise AssertionError("a two-byte CV should be rejected")


def test_unsupported_extension_is_named_in_the_error():
    try:
        read_cv(b"x" * 500, "cv.pages")
    except UnreadableCV as exc:
        assert ".pages" in str(exc)
        return
    raise AssertionError("unsupported types should be rejected")


def _cv_fixture() -> bytes:
    """A one-page PDF standing in for a designed CV: a photo, a drawn rule,
    and text -- the three things an in-place edit must not destroy."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)

    photo = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 40, 40), False)
    photo.set_rect(photo.irect, (200, 120, 90))
    page.insert_image(fitz.Rect(480, 40, 540, 100), pixmap=photo)
    page.draw_line(fitz.Point(56, 120), fitz.Point(540, 120), color=(0, 0, 0.6), width=2)

    page.insert_text((56, 160), "Built a recommendation engine for retail", fontsize=11)
    page.insert_text((56, 200), "alpha", fontsize=11)
    page.insert_text((110, 200), "| trailing text", fontsize=11)
    return doc.tobytes()


def test_a_keyword_swap_replaces_the_words_and_keeps_the_artwork():
    """The whole point of editing in place: the photo and the rule survive,
    because rebuilding a CV from its text is what lost them before."""
    out, report = apply_keyword_edits(
        _cv_fixture(),
        [CVKeywordEdit(find="recommendation engine", replace="recommender system")],
    )
    assert len(report.applied) == 1

    with fitz.open(stream=io.BytesIO(out), filetype="pdf") as doc:
        page = doc[0]
        text = page.get_text()
        assert "recommender system" in text
        assert "recommendation engine" not in text
        assert len(page.get_images(full=True)) == 1, "the photo was redacted away"
        assert page.get_drawings(), "the rule was redacted away"


def test_a_replacement_extracts_with_ordinary_spaces():
    """A replacement is written one word at a time precisely so the words come
    back separated by U+0020. Written as a single run against an embedded
    subset font, PyMuPDF substitutes a non-breaking space -- invisible on the
    page, but this feature exists to be read by keyword screens, and a screen
    looking for "recommender system" should not have to guess at U+00A0."""
    out, _ = apply_keyword_edits(
        _cv_fixture(),
        [CVKeywordEdit(find="recommendation engine", replace="recommender system")],
    )
    with fitz.open(stream=io.BytesIO(out), filetype="pdf") as doc:
        text = doc[0].get_text()
    assert "\xa0" not in text
    assert "recommender system" in text


def test_a_sentence_long_edit_is_reduced_to_the_words_that_changed():
    """Models return a whole sentence as `find` even when told not to. The
    sentence has wrapped in the real document and cannot be found as one run,
    so the edit would be lost -- for a change only two words wide. It is
    trimmed to the differing middle before anything is searched for."""
    from .cv_inplace import _minimise

    assert _minimise(
        "Built a recommendation engine for retail",
        "Built a recommender system for retail",
    ) == ("recommendation engine", "recommender system")

    # Nothing to replace: an insertion would have to reflow the page.
    assert _minimise("Built a system", "Built a fast system")[0] == ""

    out, report = apply_keyword_edits(
        _cv_fixture(),
        [
            CVKeywordEdit(
                find="Built a recommendation engine for retail",
                replace="Built a recommender system for retail",
            )
        ],
    )
    assert len(report.applied) == 1

    with fitz.open(stream=io.BytesIO(out), filetype="pdf") as doc:
        page = doc[0]
        # Position-ordered, i.e. how the page actually reads.
        laid_out = " ".join(page.get_text(sort=True).split())
        # Content-stream order, where replacements land at the end.
        raw = page.get_text()

    assert "Built a recommender system for retail" in laid_out
    assert "recommendation engine" not in raw
    # Whatever the reading order, the replaced phrase stays one contiguous
    # run -- that is what a keyword screen actually matches on.
    assert "recommender system" in raw


def test_a_phrase_that_is_not_in_the_cv_is_reported_not_invented():
    out, report = apply_keyword_edits(
        _cv_fixture(),
        [CVKeywordEdit(find="Kubernetes at scale", replace="container orchestration")],
    )
    assert [e.find for e in report.not_found] == ["Kubernetes at scale"]
    assert not report.applied
    with fitz.open(stream=io.BytesIO(out), filetype="pdf") as doc:
        assert "container orchestration" not in doc[0].get_text()


def test_a_replacement_too_long_for_its_space_is_refused_not_overlapped():
    """"alpha" has "| trailing text" immediately to its right. A replacement
    that cannot fit that gap must never be drawn into it: running the two
    into each other produces a CV nobody can send.

    The words are not lost -- this page has room, so they go on a line of
    their own. What must hold either way is that nothing is written on top
    of the text that was already there."""
    out, report = apply_keyword_edits(
        _cv_fixture(),
        [CVKeywordEdit(find="alpha", replace="alpha, beta, gamma, delta and epsilon too")],
    )
    # Refused in place, and taken by the line-insertion path instead.
    assert [e.find for e in report.inserted] == ["alpha"]
    assert not report.did_not_fit

    with fitz.open(stream=io.BytesIO(out), filetype="pdf") as doc:
        page = doc[0]
        text = page.get_text()
        trailing = page.search_for("| trailing text")[0]
        added = page.search_for("beta, gamma, delta and epsilon too")[0]

    assert "alpha" in text and "| trailing text" in text
    # A clear line below, not drawn through the words that were there.
    # Compared on the top edges rather than by intersecting the rectangles:
    # a text bounding box carries its ascender and descender padding, so
    # consecutive lines in any document abut by a fraction of a point.
    assert added.y0 > trailing.y0 + trailing.height * 0.8, (
        f"the addition sits at {added.y0:.1f}, the existing text at "
        f"{trailing.y0:.1f} -- that is the same line"
    )


def test_a_replacement_far_shorter_than_the_original_is_refused():
    """The line cannot be closed up after a short replacement -- pulling the
    rest of it left would drag right-aligned content (the dates at the end of
    every job line) out of alignment. So a replacement that would leave a big
    hole mid-sentence is refused; a slightly shorter one still goes in."""
    small_shortfall, report_ok = apply_keyword_edits(
        _cv_fixture(),
        [CVKeywordEdit(find="recommendation engine", replace="recommender system")],
    )
    assert len(report_ok.applied) == 1, "a near-equal replacement should still apply"

    _, report_gap = apply_keyword_edits(
        _cv_fixture(),
        [CVKeywordEdit(find="recommendation engine", replace="ranker")],
    )
    assert [e.find for e in report_gap.left_a_gap] == ["recommendation engine"]
    assert not report_gap.applied
    with fitz.open(stream=io.BytesIO(small_shortfall), filetype="pdf") as doc:
        assert "recommender system" in doc[0].get_text()


def test_a_skill_the_cv_never_mentions_is_not_added_to_it():
    """The prompt forbids inventing skills in three places and the model did
    it anyway -- asked to tailor toward a posting wanting Kubernetes, it
    appended Kubernetes to a real MLOps list that had never contained it.
    That is a falsified CV, and it is the applicant who has to answer for it,
    so the claim is checked in code rather than merely instructed.

    Rewordings are deliberately NOT checked: "recommendation engine" ->
    "recommender system" introduces words absent from the CV by design.
    """
    from .cv_editor import _drop_unevidenced_additions
    from .models import CandidateProfile, CVKeywordEdits

    cv_text = "MLOps: MLflow, Docker, CI/CD\nBuilt a recommendation engine at Acme."
    profile = CandidateProfile(
        name="Jane Doe", headline="Data Scientist", years_experience=3, seniority="mid",
        core_skills=["Python"], tools=["MLflow", "Docker"], domains=["retail"],
        search_queries=["data scientist"], strengths=["shipping models"], gaps=[],
    )

    result = _drop_unevidenced_additions(
        CVKeywordEdits(
            edits=[
                # Invented: Kubernetes is nowhere in the CV.
                CVKeywordEdit(
                    find="MLOps: MLflow, Docker, CI/CD",
                    replace="MLOps: MLflow, Docker, CI/CD, Kubernetes",
                ),
                # A rewording, not an addition -- must survive.
                CVKeywordEdit(find="recommendation engine", replace="recommender system"),
            ],
            missing_skills=[],
        ),
        cv_text,
        profile,
        "",
        ASKS_FOR_EVERYTHING,
    )

    assert [e.find for e in result.edits] == ["recommendation engine"]
    assert "Kubernetes" in result.missing_skills, (
        "a refused skill must be offered back to the candidate, not silently dropped"
    )


def test_a_learning_line_may_take_a_skill_the_rest_of_the_cv_cannot():
    """Getting past a keyword screen without yet having the keyword has an
    honest answer: say you are learning it, on a line that says so. A screen
    searching for "Kubernetes" matches "Currently learning: Kubernetes", and
    a human reads exactly what is true. Unevidenced terms are allowed there
    and nowhere else -- the same term must still be refused on the main
    skills line, or the exception would swallow the rule."""
    from .cv_editor import _drop_unevidenced_additions
    from .models import CandidateProfile, CVKeywordEdits

    cv_text = (
        "MLOps: MLflow, Docker, CI/CD\n"
        "Currently learning: Terraform, Go\n"
    )
    profile = CandidateProfile(
        name="Jane Doe", headline="Data Scientist", years_experience=3, seniority="mid",
        core_skills=["Python"], tools=["MLflow", "Docker"], domains=["retail"],
        search_queries=["data scientist"], strengths=["shipping models"], gaps=[],
    )

    result = _drop_unevidenced_additions(
        CVKeywordEdits(
            edits=[
                CVKeywordEdit(
                    find="Currently learning: Terraform, Go",
                    replace="Currently learning: Terraform, Go, Kubernetes",
                ),
                CVKeywordEdit(
                    find="MLOps: MLflow, Docker, CI/CD",
                    replace="MLOps: MLflow, Docker, CI/CD, Kubernetes",
                ),
            ],
            missing_skills=[],
        ),
        cv_text,
        profile,
        "",
        ASKS_FOR_EVERYTHING,
    )

    kept = [e.find for e in result.edits]
    assert "Currently learning: Terraform, Go" in kept, "the learning line should accept it"
    assert "MLOps: MLflow, Docker, CI/CD" not in kept, "the skills list must still refuse it"


def test_a_skill_the_candidate_declares_may_be_added():
    """The check exists to stop the MODEL inventing skills, not to stop the
    candidate describing their own experience. A CV is a summary, and the
    commonest reason a real skill is missing is that it was never typed --
    which no amount of reading the document reveals. Stated by the person who
    knows, it counts; guessed by the model, it never does."""
    from .cv_editor import _drop_unevidenced_additions
    from .models import CandidateProfile, CVKeywordEdits

    cv_text = "MLOps: MLflow, Docker, CI/CD"
    profile = CandidateProfile(
        name="Jane Doe", headline="Data Scientist", years_experience=3, seniority="mid",
        core_skills=["Python"], tools=["MLflow", "Docker"], domains=["retail"],
        search_queries=["data scientist"], strengths=["shipping models"], gaps=[],
    )
    edits = [
        CVKeywordEdit(
            find="MLOps: MLflow, Docker, CI/CD",
            replace="MLOps: MLflow, Docker, CI/CD, Kubernetes",
        )
    ]

    undeclared = _drop_unevidenced_additions(
        CVKeywordEdits(edits=list(edits), missing_skills=[]),
        cv_text,
        profile,
        "",
        ASKS_FOR_EVERYTHING,
    )
    assert not undeclared.edits, "the model may not add a skill on its own say-so"

    declared = _drop_unevidenced_additions(
        CVKeywordEdits(edits=list(edits), missing_skills=[]),
        cv_text,
        profile,
        "Kubernetes - ran our EKS cluster for two years",
        ASKS_FOR_EVERYTHING,
    )
    assert len(declared.edits) == 1, "a skill the candidate states should be usable"


def test_a_refused_skill_is_offered_back_and_applied_once_confirmed():
    """The whole two-step shape, end to end. A skill missing from a CV can
    mean the candidate lacks it OR that they never wrote it down, and nothing
    can tell those apart by reading the document -- so round one refuses the
    addition and ASKS, and round two applies exactly what was confirmed.
    A skill that is confirmed stops being asked about; one that is not stays
    on the list."""
    from .cv_editor import _drop_unevidenced_additions
    from .models import CandidateProfile, CVKeywordEdits

    cv_text = "MLOps: MLflow, Docker, CI/CD"
    profile = CandidateProfile(
        name="Jane Doe", headline="Data Scientist", years_experience=3, seniority="mid",
        core_skills=["Python"], tools=["MLflow", "Docker"], domains=["retail"],
        search_queries=["data scientist"], strengths=["shipping models"], gaps=[],
    )
    proposed = CVKeywordEdits(
        edits=[
            CVKeywordEdit(
                find="MLOps: MLflow, Docker, CI/CD",
                replace="MLOps: MLflow, Docker, CI/CD, Kubernetes",
            )
        ],
        missing_skills=["Terraform"],
    )

    asked = _drop_unevidenced_additions(proposed, cv_text, profile, "", ASKS_FOR_EVERYTHING)
    assert not asked.edits, "nothing unevidenced may go in before it is confirmed"
    # The invented term joins the gaps the model already spotted: from the
    # candidate's side both are just "do you have this?".
    assert set(asked.missing_skills) == {"Terraform", "Kubernetes"}

    confirmed = _drop_unevidenced_additions(
        proposed, cv_text, profile, "Kubernetes", ASKS_FOR_EVERYTHING
    )
    assert [e.replace for e in confirmed.edits] == ["MLOps: MLflow, Docker, CI/CD, Kubernetes"]
    assert confirmed.missing_skills == ["Terraform"], "a confirmed skill must stop being asked about"


def test_nothing_is_added_or_asked_about_unless_the_posting_says_it():
    """Everything this feature does is justified by "the posting asks for
    it", so that claim is checked rather than trusted. For a Cohere advert
    naming PyTorch and fine-tuning, the model proposed adding JAX and
    XLA/MLIR -- neither in the advert, neither in the CV -- and asked the
    candidate about Kubernetes and Distributed Training, also absent. With no
    posting text at all, nothing qualifies: a thin description is not a
    licence to guess what such a job "probably" wants."""
    from .cv_editor import _drop_unevidenced_additions
    from .models import CandidateProfile, CVKeywordEdits

    cv_text = "ML Frameworks: Scikit-learn, PyTorch, TensorFlow, XGBoost"
    profile = CandidateProfile(
        name="Jane Doe", headline="ML Engineer", years_experience=3, seniority="mid",
        core_skills=["Python"], tools=["PyTorch"], domains=["ml"],
        search_queries=["ml engineer"], strengths=["shipping models"], gaps=[],
    )
    posting = (
        "Applied Machine Learning Engineer. You will train and fine-tune large "
        "language models and build retrieval systems. Strong Python and PyTorch."
    )
    proposed = CVKeywordEdits(
        edits=[
            CVKeywordEdit(
                find="ML Frameworks: Scikit-learn, PyTorch, TensorFlow, XGBoost",
                replace="ML Frameworks: Scikit-learn, PyTorch, TensorFlow, XGBoost, JAX",
                reason="from candidate context",
            )
        ],
        missing_skills=["Kubernetes", "Distributed Training", "fine-tune"],
    )

    grounded = _drop_unevidenced_additions(proposed, cv_text, profile, "", posting)
    assert not grounded.edits, "JAX is in neither the advert nor the CV"
    assert grounded.missing_skills == ["fine-tune"], (
        "only skills the advert actually names may be asked about"
    )

    blank = _drop_unevidenced_additions(proposed, cv_text, profile, "", "")
    assert not blank.edits and not blank.missing_skills, (
        "with no posting text there is nothing to tailor toward"
    )


def test_an_edit_may_never_drop_a_skill_to_make_room():
    """Told a replacement must fit the space the original occupied, the model
    made room by deleting things: "Power BI, Seaborn, Matplotlib, Cognos"
    came back as "Power BI, Seaborn, Tableau, Plotly", two real tools gone
    from a CV about to be sent to an employer. Losing a skill you have is
    worse than missing a keyword you do not, so the edit is repaired into an
    append and left to fit or be refused on its merits."""
    from .cv_editor import _keep_what_is_already_there

    repaired = _keep_what_is_already_there(
        CVKeywordEdit(
            find="Visualization: Power BI, Seaborn, Matplotlib, Cognos",
            replace="Visualization: Power BI, Seaborn, Tableau, Plotly",
        )
    )
    assert repaired.replace == (
        "Visualization: Power BI, Seaborn, Matplotlib, Cognos, Tableau, Plotly"
    )

    # An edit that already only appends is left exactly as it is.
    untouched = CVKeywordEdit(
        find="Visualization: Power BI, Seaborn",
        replace="Visualization: Power BI, Seaborn, Tableau",
    )
    assert _keep_what_is_already_there(untouched).replace == untouched.replace


def test_a_line_with_no_room_says_how_much_room_it_has():
    """"It did not fit" leaves the user with nothing to do. Reporting the
    headroom tells them whether to shorten the line or ask for fewer terms."""
    # One run, with text immediately after the part being replaced -- the
    # ordinary shape of a skills line inside a paragraph of a real CV.
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text(
        (56, 100), "Visualization: Power BI, Seaborn | and more text after it", fontsize=11
    )
    # Down to the foot of the page, so there is no spare paper to push into
    # and no new line to be had. This is the case where the headroom message
    # is what the user actually sees -- with room to insert, they get the
    # keywords instead, which is tested separately.
    page.insert_text((56, 815), "Referees available on request", fontsize=11)
    fixture = doc.tobytes()

    _, report = apply_keyword_edits(
        fixture,
        [
            CVKeywordEdit(
                find="Visualization: Power BI, Seaborn",
                replace="Visualization: Power BI, Seaborn, Tableau, Plotly, Bokeh, Altair",
            )
        ],
    )
    assert report.did_not_fit, "this cannot fit and must be refused"
    assert "Visualization: Power BI, Seaborn" in report.room_left
    assert report.room_left["Visualization: Power BI, Seaborn"] >= 0


def test_the_gaps_asked_about_shrink_rather_than_change():
    """Confirming a skill used to produce a NEW set of gaps: the question was
    re-asked of the model each round, and a model asked "what is missing"
    twice answers twice. The candidate ticked one box and was handed three
    tools it had not mentioned a moment earlier, and the list never
    converged. What an advert requires does not change when the reader
    answers a question about themselves, so it is read from the advert once
    and only the diff moves."""
    from .cv_editor import _drop_unevidenced_additions
    from .models import CandidateProfile, CVKeywordEdits

    cv_text = "ML Frameworks: Scikit-learn, PyTorch"
    profile = CandidateProfile(
        name="Jane Doe", headline="ML Engineer", years_experience=3, seniority="mid",
        core_skills=["Python"], tools=["PyTorch"], domains=["ml"],
        search_queries=["ml engineer"], strengths=["ships models"], gaps=[],
    )
    posting = "We need Python, PyTorch, Kubernetes, Airflow and Kafka."
    catalogue = ["Python", "PyTorch", "Kubernetes", "Airflow", "Kafka"]

    # The model's own answer differs call to call; the catalogue does not.
    first = _drop_unevidenced_additions(
        CVKeywordEdits(edits=[], missing_skills=["Kubernetes"]),
        cv_text, profile, "", posting, catalogue,
    )
    assert first.missing_skills == ["Kubernetes", "Airflow", "Kafka"], (
        "every gap must be offered up front, not drip-fed"
    )

    after = _drop_unevidenced_additions(
        CVKeywordEdits(edits=[], missing_skills=["Airflow", "Kafka", "Spark", "Ray"]),
        cv_text, profile, "Kubernetes", posting, catalogue,
    )
    assert after.missing_skills == ["Airflow", "Kafka"], (
        "confirming a skill must shorten the list, never introduce new ones"
    )


def test_a_learning_line_does_not_launder_a_skill_into_the_main_list():
    """The exception must not swallow the rule. A skill named on the learning
    line is still not experience, so it must not then count as evidence that
    lets the same term be promoted into the main skills list -- which is
    exactly what happens if the learning line is treated as CV content."""
    from .cv_editor import _drop_unevidenced_additions
    from .models import CandidateProfile, CVKeywordEdits

    cv_text = "MLOps: MLflow, Docker\nCurrently learning: Kubernetes\n"
    profile = CandidateProfile(
        name="Jane Doe", headline="Data Scientist", years_experience=3, seniority="mid",
        core_skills=["Python"], tools=["MLflow", "Docker"], domains=["retail"],
        search_queries=["data scientist"], strengths=["shipping models"], gaps=[],
    )

    result = _drop_unevidenced_additions(
        CVKeywordEdits(
            edits=[
                CVKeywordEdit(
                    find="MLOps: MLflow, Docker",
                    replace="MLOps: MLflow, Docker, Kubernetes",
                )
            ],
            missing_skills=[],
        ),
        cv_text,
        profile,
        "",
        ASKS_FOR_EVERYTHING,
    )
    assert not result.edits, "a learning-line skill must not become a claimed one"


def test_two_edits_cannot_rewrite_the_same_words():
    """Models return overlapping edits routinely: asked to retitle a CV, one
    gave both "Associate Data Scientist" -> "Applied AI Engineer" and the
    longer line containing it. Applying both redacted the text once and drew
    two replacements on top of each other, printing
    "AppliedApplied AIAIAppliedEngineerEngineer" across the header. The first
    edit claims the region; later ones that touch it are skipped."""
    out, report = apply_keyword_edits(
        _cv_fixture(),
        [
            CVKeywordEdit(find="recommendation engine", replace="recommender system"),
            CVKeywordEdit(
                find="Built a recommendation engine for retail",
                replace="Built a recommender platform for retail",
            ),
        ],
    )
    # Both edits reduce to the same phrase once trimmed to what changed, so
    # they are distinguished by outcome rather than by text: the first claims
    # the region, the second is refused as overlapping.
    assert len(report.applied) == 1
    assert len(report.overlapped) == 1

    with fitz.open(stream=io.BytesIO(out), filetype="pdf") as doc:
        words = doc[0].get_text(sort=True).split()
    # Nothing drawn twice: the replaced word appears once, and the losing
    # edit's wording never reaches the page at all.
    assert words.count("recommender") == 1
    assert "platform" not in words


def test_trimming_an_edit_must_not_widen_what_it_points_at():
    """Trimming an edit to the words that changed makes long ones findable,
    but trimmed too far it names several places instead of one. "Data
    Scientist with 3+ years" -> "Applied AI Engineer with 3+ years" reduces
    to "Data Scientist" -> "Applied AI Engineer" -- and "Data Scientist" is
    also the real job title held at an employer. Applying that would rewrite
    an employment history into a job the candidate never had."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((56, 100), "Data Scientist with 3+ years of experience", fontsize=11)
    page.insert_text((56, 140), "Data Scientist - Meezan Bank Ltd", fontsize=11)
    fixture = doc.tobytes()

    out, _ = apply_keyword_edits(
        fixture,
        [
            CVKeywordEdit(
                find="Data Scientist with 3+ years",
                replace="Applied AI Engineer with 3+ years",
            )
        ],
    )

    with fitz.open(stream=io.BytesIO(out), filetype="pdf") as result:
        text = result[0].get_text(sort=True)
    assert "Data Scientist - Meezan Bank Ltd" in text, "a real job title was rewritten"


def test_an_append_moves_to_the_end_of_the_line_it_lands_in():
    """A model extending a skills list quotes as much of it as it feels like.
    Quoting up to "XGBoost" of a row that continues ", Hugging Face
    Transformers" put the addition in the MIDDLE of the line, where the words
    after it leave no room -- and the edit was refused as "that line is
    completely full" while the end of that very line had space to spare. An
    append is moved to the end of the run; a rewording is not moved at all,
    because it has to replace the words it names where they are."""
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    # A body line first: it is what establishes the document's right-hand
    # text margin, and therefore how far a shorter line may grow. A page
    # holding only the skills row has no margin to infer and nothing may
    # grow at all -- true, and not what this test is about.
    page.insert_text(
        (56, 70),
        "Built and maintained interactive dashboards and automated reporting pipelines"
        " for enterprise clients across several teams.",
        fontsize=11,
    )
    page.insert_text((56, 100), "ML Frameworks: Scikit-learn, XGBoost, Hugging Face", fontsize=11)
    fixture = doc.tobytes()

    out, report = apply_keyword_edits(
        fixture,
        [
            CVKeywordEdit(
                find="Scikit-learn, XGBoost",
                replace="Scikit-learn, XGBoost, Statistical Modeling",
            )
        ],
    )
    assert report.applied, "the end of the line had room; this must not be refused"

    # A font maps "-" to whichever hyphen glyph it has, and reading the page
    # back reports that glyph's codepoint -- U+2010 here, not the ASCII one
    # that was written. Same character to any reader; see _EQUIVALENT.
    read = lambda pdf: " ".join(
        fitz.open(stream=io.BytesIO(pdf), filetype="pdf")[0]
        .get_text(sort=True)
        .replace("‐", "-")
        .split()
    )

    # Appended after the last item, not wedged in before "Hugging Face".
    assert "Hugging Face, Statistical Modeling" in read(out), read(out)

    # A rewording must NOT be relocated the way an append is: it has to
    # replace the words it names, where they are. Asserted on the relocation
    # itself rather than through a render, so it cannot pass or fail for an
    # unrelated reason (whether that particular word happens to fit).
    from .cv_inplace import _append_at_the_end_of_the_line

    with fitz.open(stream=io.BytesIO(fixture), filetype="pdf") as doc:
        moved = _append_at_the_end_of_the_line(
            doc, "Scikit-learn, XGBoost", "Scikit-learn, XGBoost, Statistical Modeling"
        )
        # Extended from where the match starts to the end of the run, so the
        # addition lands after "Hugging Face" rather than before it. The
        # label the run begins with is not part of the anchor.
        assert moved == (
            "Scikit-learn, XGBoost, Hugging Face",
            "Scikit-learn, XGBoost, Hugging Face, Statistical Modeling",
        ), moved

        unmoved = _append_at_the_end_of_the_line(doc, "XGBoost", "LightGBM")
        assert unmoved == ("XGBoost", "LightGBM"), unmoved


def test_a_cv_that_is_not_a_pdf_is_rejected_clearly():
    try:
        apply_keyword_edits(b"this is not a pdf", [CVKeywordEdit(find="a", replace="b")])
    except ValueError as exc:
        assert "PDF" in str(exc)
        return
    raise AssertionError("a non-PDF CV should be rejected")


def test_scrape_reports_each_search_separately():
    """One aggregate number hides a lopsided run -- "8 scraped" could mean one
    title with 8 results or eight titles with one apiece. per_search is what
    makes "why did Android Developer get 0 while Data Scientist got 27" have
    an answer instead of looking like a bug.
    """
    from types import SimpleNamespace

    from .sources import scrapers as scrapers_module

    def fake_fetch(title, location, pages, since_hours=None):
        if title == "Android Developer":
            return []
        if title == "Broken Title":
            raise ConnectionError("blocked")
        return [
            SimpleNamespace(
                title=f"{title} at Acme", company="Acme", url="https://x", location=location,
                description="", posted_at=None,
            )
        ]

    fake_source = SimpleNamespace(fetch=fake_fetch)
    original_build = scrapers_module._build_source
    scrapers_module._build_source = lambda *a, **k: fake_source
    try:
        jobs, stats = scrapers_module.scrape(
            ["Data Scientist", "Android Developer", "Broken Title"], ["Germany"], board="LinkedIn"
        )
    finally:
        scrapers_module._build_source = original_build

    by_title = {row["title"]: row for row in stats["per_search"]}
    assert by_title["Data Scientist"]["scraped"] == 1
    assert by_title["Android Developer"]["scraped"] == 0
    assert by_title["Android Developer"]["failed"] is False
    assert by_title["Broken Title"]["failed"] is True
    assert len(jobs) == 1
    assert stats["failed_searches"] == 1


def test_a_dead_board_does_not_end_the_search(monkeypatched_boards=None):
    """One board raising must not lose the others."""
    from .sources import boards as boards_module

    original = dict(boards_module.BOARDS)

    # Three arguments, because the pipeline now hands every board the
    # location as well -- the ones that can search by place were previously
    # asked for the whole country and filtered afterwards.
    def explode(queries, limit, location=""):
        raise ConnectionError("board is down")

    def works(queries, limit, location=""):
        return [Job(source="Good", title="Data Scientist", company="Acme",
                    url="https://example.com/1", location="Remote", remote=True)]

    boards_module.BOARDS.clear()
    boards_module.BOARDS.update({"Dead": (explode, True), "Good": (works, True)})
    try:
        jobs, report = fetch_all(QUERIES, boards=["Dead", "Good"])
        assert len(jobs) == 1
        assert "Dead" in report.errors
        assert report.kept["Good"] == 1
    finally:
        boards_module.BOARDS.clear()
        boards_module.BOARDS.update(original)


def test_llm_falls_back_when_the_primary_model_is_overloaded():
    from . import llm as llm_module
    from .models import CandidateProfile

    calls: list[str] = []
    original = llm_module._call_once
    sentinel = CandidateProfile(
        name="Test", headline="h", years_experience=1, seniority="mid",
        core_skills=[], tools=[], domains=[], search_queries=[],
        strengths=[], gaps=[],
    )

    # Six parameters: _call_once now takes a per-call time budget, so an
    # interactive caller can bound a rate-limited turn.
    def fake(schema, system, user, max_tokens, model, budget=None):
        calls.append(model)
        if model == llm_module.model_name():
            raise RuntimeError("Error code: 503 - model is currently experiencing high demand")
        return sentinel

    llm_module._call_once = fake
    try:
        out = llm_module.structured(CandidateProfile, "s", "u", attempts=2)
        assert out is sentinel
        assert calls[-1] == llm_module.fallback_model()
        assert calls.count(llm_module.model_name()) == 2  # both attempts, then the spare
    finally:
        llm_module._call_once = original


def test_a_rate_limit_waits_far_longer_than_a_server_error():
    """A 429 on the free tier is a per-minute quota, not a blip.

    Retrying it four seconds later lands inside the same closed window and
    burns an attempt for nothing -- which is how a whole run came back with
    nothing scored.
    """
    from . import llm as llm_module

    rate_limited = RuntimeError("Error code: 429 - Too Many Requests")
    server_error = RuntimeError("Error code: 503 - model is overloaded")

    assert llm_module._is_rate_limit(rate_limited)
    assert not llm_module._is_rate_limit(server_error)
    assert llm_module._sleep_for(rate_limited, 0) >= 20
    assert llm_module._sleep_for(server_error, 0) <= 3

    # A stated retry-after wins over the default.
    stated = RuntimeError("429 Too Many Requests. Please retry after 51 seconds")
    assert 50 <= llm_module._sleep_for(stated, 0) <= 55


def test_a_rate_limit_says_so_instead_of_blaming_the_search():
    from . import llm as llm_module
    from .models import CandidateProfile

    original = llm_module._call_once
    llm_module._call_once = lambda *args, **kwargs: (_ for _ in ()).throw(
        RuntimeError("Error code: 429 - Too Many Requests")
    )
    original_sleep = llm_module.time.sleep
    llm_module.time.sleep = lambda _seconds: None  # do not actually wait
    try:
        llm_module.structured(CandidateProfile, "s", "u", attempts=2)
    except llm_module.RateLimited as exc:
        assert "per-minute quota" in str(exc)
    except Exception as exc:
        raise AssertionError(f"expected RateLimited, got {type(exc).__name__}: {exc}")
    else:
        raise AssertionError("a persistent 429 should raise RateLimited")
    finally:
        llm_module._call_once = original
        llm_module.time.sleep = original_sleep


def test_a_non_retryable_error_fails_immediately():
    from . import llm as llm_module
    from .models import CandidateProfile

    original = llm_module._call_once
    calls: list[str] = []

    # Six parameters: _call_once now takes a per-call time budget, so an
    # interactive caller can bound a rate-limited turn.
    def fake(schema, system, user, max_tokens, model, budget=None):
        calls.append(model)
        raise RuntimeError("Error code: 401 - API key is invalid")

    llm_module._call_once = fake
    try:
        llm_module.structured(CandidateProfile, "s", "u", attempts=3)
    except LLMError:
        assert len(calls) == 1, f"a bad key must not be retried, got {len(calls)} calls"
    else:
        raise AssertionError("an invalid key should raise")
    finally:
        llm_module._call_once = original


def test_the_ui_renders_a_result_without_crashing():
    """Drive app.py headlessly with a finished result in session state.

    The rating pipeline is covered above; this catches the other half -- a
    typo in the rendering code, which otherwise only shows up as a red
    traceback after someone has waited a minute for real results.
    """
    from pathlib import Path

    from streamlit.testing.v1 import AppTest

    from .models import CandidateProfile, JobRating
    from .pipeline import ScoutResult
    from .rating import RatedJob
    from .sources import FetchReport

    profile = CandidateProfile(
        name="Test Person", headline="Data scientist", years_experience=3,
        seniority="mid", core_skills=["Python"], tools=["Databricks"],
        domains=["banking"], search_queries=["data scientist"],
        strengths=["shipped a churn model"], gaps=["no Kubernetes"],
    )
    rating = JobRating(
        index=0, score=87, verdict="good", skills_match=90, experience_match=80,
        domain_match=85, why_pick=["Their stack is your stack"],
        concerns=["Asks for 5 years"], matched_skills=["Python"],
        missing_skills=["Kubernetes"], pitch="I build production ML.",
    )
    job = Job(source="Remotive", title="Senior Data Scientist", company="Acme",
              url="https://example.com/job", location="Remote", salary="EUR 70,000",
              posted_at="2026-09-01", remote=True)

    result = ScoutResult(
        profile=profile,
        rated=[RatedJob(job=job, rating=rating)],
        report=FetchReport(fetched={"Remotive": 40}, kept={"Remotive": 1}),
        queries=["data scientist"],
        errors=[],
    )

    app = AppTest.from_file(str(Path(__file__).with_name("app.py")), default_timeout=60)
    app.session_state["result"] = result
    app.run()

    assert not app.exception, f"app.py raised: {app.exception}"
    rendered = " ".join(block.value for block in app.markdown)
    assert "Why you should apply" in rendered
    assert "Senior Data Scientist" in rendered
    assert "What to watch out for" in rendered


def _full_line_cv(bottom_text_y: float = 300) -> bytes:
    """A CV whose skills line runs the full width of the text column.

    This is the case the in-place editor cannot serve: there is no slack on
    the line, so an appended keyword has nowhere to go inside it. The line
    below exists to prove it moves down rather than being overwritten.
    """
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.draw_line(fitz.Point(56, 120), fitz.Point(540, 120), color=(0, 0, 0.6), width=2)
    page.insert_text(
        (56, 160),
        "Monitoring: Promtail, OpenTelemetry Collector, Loki, Mimir, Grafana, Alertmanager",
        fontsize=9,
    )
    page.insert_text((56, bottom_text_y), "Education: BS Computer Science", fontsize=9)
    return doc.tobytes()


def test_a_full_line_gains_a_new_line_rather_than_losing_the_keyword():
    """The reason cv_reflow exists. The skills line has no room, so the terms
    the posting asked for go on a line of their own instead of being dropped
    with "that line is full" -- which was true and left the user nothing."""
    find = "Monitoring: Promtail, OpenTelemetry Collector, Loki, Mimir, Grafana, Alertmanager"
    out, report = apply_keyword_edits(
        _full_line_cv(),
        [CVKeywordEdit(find=find, replace=find + ", Datadog, Opensearch, fluentd")],
    )

    assert len(report.inserted) == 1, "the edit should have gone on a new line"
    assert not report.did_not_fit, "and should no longer be reported as refused"
    assert len(report.applied) == 1, "an inserted edit is an applied edit"

    with fitz.open(stream=io.BytesIO(out), filetype="pdf") as doc:
        assert doc.page_count == 1, "a one-page CV must stay one page"
        text = " ".join(doc[0].get_text(sort=True).split())

    # The new terms are there...
    assert "Datadog, Opensearch, fluentd" in text
    # ...the original line is intact...
    assert "Loki, Mimir, Grafana, Alertmanager" in text
    # ...and what was below it still exists rather than being written over.
    assert "Education: BS Computer Science" in text
    # No duplicated copy of the moved half: the clip must remove text from
    # the text layer, not merely hide it. A keyword screen reads both.
    assert text.count("Education: BS Computer Science") == 1


def test_the_moved_half_of_the_page_actually_moves_down():
    """The insertion works by splitting the page and drawing the lower half a
    line lower. If the split were merely visual the content below would sit
    where it always did, and the new line would land on top of it."""
    find = "Monitoring: Promtail, OpenTelemetry Collector, Loki, Mimir, Grafana, Alertmanager"
    original = _full_line_cv()

    def y_of(pdf: bytes, needle: str) -> float:
        with fitz.open(stream=io.BytesIO(pdf), filetype="pdf") as doc:
            return doc[0].search_for(needle)[0].y0

    before = y_of(original, "Education: BS Computer Science")
    out, report = apply_keyword_edits(
        original, [CVKeywordEdit(find=find, replace=find + ", Datadog, Opensearch")]
    )
    assert len(report.inserted) == 1
    after = y_of(out, "Education: BS Computer Science")

    assert after > before, "content below the insertion must move down"
    # By about one line, not by an arbitrary jump.
    assert 5 < after - before < 25, f"moved {after - before:.1f}pt, expected about one line"


def test_a_page_with_no_spare_paper_still_refuses():
    """Adding a line is only safe where there is unused paper to absorb it.
    Pushing a CV's last line off the bottom of the page to win a keyword is
    not a trade anyone wants, so a full page goes back to refusing."""
    find = "Monitoring: Promtail, OpenTelemetry Collector, Loki, Mimir, Grafana, Alertmanager"
    # Text almost at the foot of the page: nothing below to give.
    out, report = apply_keyword_edits(
        _full_line_cv(bottom_text_y=810),
        [CVKeywordEdit(find=find, replace=find + ", Datadog, Opensearch, fluentd")],
    )

    assert not report.inserted, "there was no room to insert a line"
    assert len(report.did_not_fit) == 1, "so it is still reported as not fitting"
    assert not report.applied

    with fitz.open(stream=io.BytesIO(out), filetype="pdf") as doc:
        text = doc[0].get_text()
    assert "Datadog" not in text, "nothing should have been written"


def test_a_rewording_is_never_moved_to_its_own_line():
    """Only appends are eligible. Moving a replacement title onto a new line
    would leave the old title above it, and the CV would say two different
    things about the same job."""
    out, report = apply_keyword_edits(
        _full_line_cv(),
        [
            CVKeywordEdit(
                find="Monitoring: Promtail, OpenTelemetry Collector, Loki, Mimir, Grafana, Alertmanager",
                replace="Observability: Datadog, Opensearch, fluentd and a great many other tools besides",
            )
        ],
    )
    assert not report.inserted, "a rewording must not become an inserted line"

    with fitz.open(stream=io.BytesIO(out), filetype="pdf") as doc:
        text = doc[0].get_text()
    assert text.count("Monitoring:") <= 1


def test_an_inserted_line_never_runs_off_the_page():
    """Nothing wraps: the words are drawn left to right from the anchor's own
    left edge. A tail too long for the author's margin must be refused rather
    than printed into the paper's edge."""
    find = "Monitoring: Promtail, OpenTelemetry Collector, Loki, Mimir, Grafana, Alertmanager"
    enormous = ", " + ", ".join(f"VeryLongToolName{n}" for n in range(30))
    out, report = apply_keyword_edits(
        _full_line_cv(), [CVKeywordEdit(find=find, replace=find + enormous)]
    )

    assert not report.inserted, "a tail wider than the text column must be refused"

    with fitz.open(stream=io.BytesIO(out), filetype="pdf") as doc:
        page = doc[0]
        limit = page.rect.x1
        right = max(
            (s["bbox"][2] for b in page.get_text("dict").get("blocks", [])
             for l in b.get("lines", []) for s in l.get("spans", [])
             if s.get("text", "").strip()),
            default=0.0,
        )
    assert right <= limit, "no text may sit outside the page"


def test_inserting_a_line_does_not_redraw_the_artwork_twice():
    """The page is rebuilt by drawing the original twice -- once clipped to
    above the split, once to below it, shifted down. If the clip did not
    really exclude content, the header rule would appear a second time a
    line lower, and every CV would come back with a doubled design.

    Checked by rendering, not by counting paths: get_drawings() walks into
    the form XObjects without honouring their clip, so it reports two
    strokes for a page that visibly has one. Pixels are the ground truth.
    """
    line = ("Monitoring: Promtail, OpenTelemetry Collector, Loki, Mimir, Grafana, "
            "Alertmanager, Prometheus, Thanos")
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.draw_line(fitz.Point(56, 120), fitz.Point(540, 120), color=(0, 0, 0.6), width=2)
    page.insert_text((56, 170), line, fontsize=9)
    page.insert_text((56, 220), "EXPERIENCE", fontsize=11)
    before = doc.tobytes()

    out, report = apply_keyword_edits(
        before, [CVKeywordEdit(find=line, replace=line + ", Datadog, Opensearch")]
    )
    assert len(report.inserted) == 1, "this fixture is meant to exercise the insertion"

    def rule_rows(pdf: bytes) -> list:
        with fitz.open(stream=io.BytesIO(pdf), filetype="pdf") as d:
            pix = d[0].get_pixmap(dpi=150)
            scale = pix.height / d[0].rect.height
            rows = []
            for y in range(pix.height):
                hits = sum(
                    1
                    for x in range(0, pix.width, 7)
                    if (lambda p: p[2] > 110 and p[0] < 90 and p[1] < 90)(pix.pixel(x, y))
                )
                if hits > 20:
                    rows.append(round(y / scale, 1))
            return rows

    assert rule_rows(out) == rule_rows(before), (
        "the header rule moved or was drawn twice -- the clip is not holding"
    )


def test_a_standard_font_is_not_reported_as_a_substitute():
    """Helvetica and the other base-14 faces are never embedded in a PDF --
    every reader already has them. MuPDF draws its Helvetica with Nimbus
    Sans, the metrically identical clone, so the font NAME on the inserted
    line differs from the one on the line above while the page looks the
    same. Warning the user about that would be alarming them about nothing.
    """
    line = ("Monitoring: Promtail, OpenTelemetry Collector, Loki, Mimir, Grafana, "
            "Alertmanager, Prometheus, Thanos")
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((56, 170), line, fontsize=9)
    page.insert_text((56, 220), "EXPERIENCE", fontsize=11)

    out, report = apply_keyword_edits(
        doc.tobytes(), [CVKeywordEdit(find=line, replace=line + ", Datadog, Opensearch")]
    )
    assert len(report.inserted) == 1
    assert not report.font_substituted, (
        "the standard face IS the document's font; it is not a substitution"
    )

    # And the line is genuinely there, at the right size.
    with fitz.open(stream=io.BytesIO(out), filetype="pdf") as d:
        spans = [
            s
            for b in d[0].get_text("dict")["blocks"]
            for l in b.get("lines", [])
            for s in l.get("spans", [])
            if "Datadog" in s["text"]
        ]
    assert spans and abs(spans[0]["size"] - 9.0) < 0.1, "set at the line's own size"


def test_a_dot_separated_skills_row_is_not_refused_as_unrenderable():
    """A real CV caught this and the fixtures did not.

    _probe_render decides whether a font can draw text by writing it and
    reading it back. A MIDDLE DOT comes back out of the text layer as a
    BULLET OPERATOR -- the same mark, a different codepoint -- so the
    comparison failed and a font that draws the row perfectly was declared
    unable to. Every CV setting its skills with dots ("Python · SQL · Bash",
    which is most modern templates) was refused, while these tests passed
    because their fixtures used commas.
    """
    from .cv_inplace import _probe_render, _same_text

    # The round-trip itself: what goes in is not what comes back.
    assert _same_text("A ∙ B", "A · B"), "bullet operator is the same mark as middle dot"
    assert _same_text("A • B", "A · B")
    # ...but genuinely different text must still compare unequal.
    assert not _same_text("A · C", "A · B")

    assert _probe_render(fitz.Font("helv"), "Datadog · Opensearch")[0], (
        "a standard font must not be reported as unable to draw a dot"
    )

    # End to end: a dot-separated row takes an addition like any other.
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    row = "Python · SQL · Bash"
    page.insert_text((56, 170), row, fontsize=9)
    # A full-width line of body text, because the usable width is taken from
    # the author's own margin -- the rightmost text on the page. Without it
    # this fixture claims a 137pt-wide page and nothing can ever be added,
    # which is a property of the fixture rather than of any real CV.
    page.insert_text(
        (56, 195),
        "Designed and deployed an LLM-powered document assistant using LangChain "
        "and FAISS, hosted on AWS.",
        fontsize=9,
    )
    page.insert_text((56, 220), "EXPERIENCE", fontsize=11)

    out, report = apply_keyword_edits(
        doc.tobytes(),
        [CVKeywordEdit(find=row, replace=row + " · Datadog · Opensearch")],
    )
    assert len(report.applied) == 1, "a dot-separated row must be editable"

    with fitz.open(stream=io.BytesIO(out), filetype="pdf") as d:
        text = d[0].get_text()
    assert "Datadog" in text and "Opensearch" in text


def test_an_added_line_never_opens_with_a_separator():
    """The row above already ends in a term, so the separator that joined
    them belongs to neither line. Left in, the new line opens with a stray
    dot or comma hanging off its left edge."""
    from .cv_inplace import _insert_what_would_not_fit

    row = ("Monitoring: Promtail, OpenTelemetry Collector, Loki, Mimir, Grafana, "
           "Alertmanager, Prometheus, Thanos")
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((56, 170), row, fontsize=9)
    page.insert_text((56, 220), "EXPERIENCE", fontsize=11)

    for separator in (", ", " · ", " | ", " – "):
        out, report = apply_keyword_edits(
            doc.tobytes(),
            [CVKeywordEdit(find=row, replace=row + separator + "Datadog")],
        )
        assert len(report.inserted) == 1, f"{separator!r} should still insert"
        with fitz.open(stream=io.BytesIO(out), filetype="pdf") as d:
            added = [
                "".join(sp["text"] for sp in l["spans"]).strip()
                for b in d[0].get_text("dict")["blocks"]
                for l in b.get("lines", [])
                if "Datadog" in "".join(sp["text"] for sp in l["spans"])
                and "Monitoring" not in "".join(sp["text"] for sp in l["spans"])
            ]
        assert added, f"no new line found for {separator!r}"
        assert added[0].startswith("Datadog"), (
            f"line opens with a separator: {added[0]!r}"
        )


def test_the_same_dot_is_found_whichever_codepoint_the_font_reports():
    """PDF extraction does not return the character that was written.

    A MIDDLE DOT set in Calibri comes back as a BULLET OPERATOR, in Arial as
    a SINOLOGICAL DOT, in Georgia as itself. search_for() compares codepoints
    exactly, so a phrase quoted with one variant is not found in a document
    written with another -- and the user is told those words are not in their
    CV, about words plainly in it. Every dot in a phrase is translated to the
    one the page actually stores before anything is searched for.
    """
    import os

    from .cv_inplace import _as_written_on_the_page

    calibri = os.path.join(r"C:\Windows\Fonts", "calibri.ttf")
    if not os.path.exists(calibri):
        return  # the variant depends on an embedded font being available

    # Written with a MIDDLE DOT; Calibri reports it back as BULLET OPERATOR.
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text(
        (56, 170), "Python · SQL · Bash", fontsize=9, fontname="F0", fontfile=calibri
    )

    with fitz.open(stream=io.BytesIO(doc.tobytes()), filetype="pdf") as d:
        stored = d[0].get_text()
        assert "·" not in stored, "this fixture is meant to store a variant, not a middle dot"

        asked = "Python · SQL"
        rewritten = _as_written_on_the_page(d, asked)
        assert rewritten != asked, "the dot should have been translated to the page's own"
        assert d[0].search_for(rewritten), "and the translated form must actually be findable"
        # A phrase with no dot in it is returned untouched.
        assert _as_written_on_the_page(d, "Python and SQL") == "Python and SQL"


def test_a_skills_row_is_editable_in_every_common_cv_font():
    """The fonts real CVs are actually set in. Each embeds differently and
    each reports its separator differently on the way back out; a CV must not
    be editable or not depending on which one its author happened to use."""
    import os

    families = ["calibri.ttf", "arial.ttf", "times.ttf", "georgia.ttf", "verdana.ttf"]
    available = [
        os.path.join(r"C:\Windows\Fonts", f)
        for f in families
        if os.path.exists(os.path.join(r"C:\Windows\Fonts", f))
    ]
    if not available:
        return  # not a Windows machine; nothing to assert about its fonts

    row = "Python · SQL · Bash"
    body = ("Designed and deployed an LLM-powered document assistant using "
            "LangChain and FAISS, hosted securely on AWS Bedrock.")

    for path in available:
        doc = fitz.open()
        page = doc.new_page(width=595, height=842)
        for y, text, size in ((170, row, 9), (195, body, 9), (240, "EXPERIENCE", 11)):
            page.insert_text((56, y), text, fontsize=size, fontname="F0", fontfile=path)

        out, report = apply_keyword_edits(
            doc.tobytes(),
            [CVKeywordEdit(find=row, replace=row + " · Datadog")],
        )
        assert report.applied, f"{os.path.basename(path)}: the row should be editable"
        with fitz.open(stream=io.BytesIO(out), filetype="pdf") as d:
            assert "Datadog" in d[0].get_text(), f"{os.path.basename(path)}: text missing"


def test_a_page_background_is_not_mistaken_for_content():
    """Word and Google Docs paint the sheet with a rectangle the size of the
    page. It reaches the bottom edge by definition, so counting it as content
    makes every such page look full to the last millimetre -- and a CV with a
    hand's width of white space under its last line is told there is no room
    for one more. Real CVs nearly all have one of these.
    """
    from .cv_reflow import room_for_a_line

    row = ("Monitoring & Logging: Promtail, OpenTelemetry Collector, Loki, Mimir, "
           "Grafana, Alertmanager")
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    # The background, exactly as a word processor emits it: white, full bleed.
    page.draw_rect(fitz.Rect(0, 0, 595, 842), color=None, fill=(1, 1, 1))
    page.insert_text((56, 170), row, fontsize=9)
    page.insert_text((56, 195), "Security: IAM, TLS/SSL, VPN, HashiCorp Vault, SOC2", fontsize=9)
    pdf = doc.tobytes()

    with fitz.open(stream=io.BytesIO(pdf), filetype="pdf") as d:
        assert room_for_a_line(d, 0, 12.0), (
            "a page empty below y=200 has room; only its background says otherwise"
        )

    # And the edit that needs that room actually lands.
    out, report = apply_keyword_edits(
        pdf, [CVKeywordEdit(find=row, replace=row + ", Datadog, Opensearch, fluentd")]
    )
    assert report.applied, "the edit should go on, one way or the other"

    with fitz.open(stream=io.BytesIO(out), filetype="pdf") as d:
        text = d[0].get_text()
        last = max(
            s["bbox"][3]
            for b in d[0].get_text("dict")["blocks"]
            for l in b.get("lines", [])
            for s in l["spans"]
            if s["text"].strip()
        )
    assert "Datadog" in text
    assert last < 842, "nothing may be pushed off the bottom of the page"


def test_a_genuine_footer_still_blocks_an_inserted_line():
    """The background is ignored because it is the page, not because
    drawings do not matter. A real graphic near the foot -- a footer rule, a
    signature block -- is content, and there is no room to push past it."""
    from .cv_reflow import room_for_a_line

    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.draw_rect(fitz.Rect(0, 0, 595, 842), color=None, fill=(1, 1, 1))  # background
    page.insert_text((56, 170), "Skills: Python, SQL, Bash", fontsize=9)
    # A footer band across the bottom of the page: not page-sized, so real.
    page.draw_rect(fitz.Rect(36, 800, 560, 815), color=None, fill=(0.2, 0.3, 0.6))

    with fitz.open(stream=io.BytesIO(doc.tobytes()), filetype="pdf") as d:
        assert not room_for_a_line(d, 0, 12.0), (
            "a footer graphic is content and leaves no room below it"
        )


def test_a_senior_title_never_survives_an_entry_level_search():
    """The API boards have no seniority facet, so a search for entry-level
    work came back full of Senior and Staff roles and the filter the user set
    did nothing on that half of the app."""
    from .sources.seniority import matches

    wanted = ["Entry level", "Associate"]
    for title in [
        "Senior Data Scientist",
        "Sr. Machine Learning Engineer",
        "Staff Data Engineer",
        "Lead Analytics Engineer",
        "Principal Data Scientist",
        "Head of Data Science",
        "Data Scientist III",
    ]:
        assert not matches(title, levels=wanted), f"{title!r} is not entry level"


def test_an_unmarked_title_is_kept_rather_than_guessed_at():
    """A bare "Data Scientist" is genuinely open to two years' experience.
    Dropping every title that does not announce its level would throw out most
    of the market to remove a few bad matches, so silence is not evidence."""
    from .sources.seniority import level_of, matches

    assert level_of("Data Scientist") is None
    assert matches("Data Scientist", levels=["Entry level"])
    assert matches("Machine Learning Engineer", levels=["Entry level", "Associate"])


def test_the_filter_cuts_both_ways():
    """Somebody searching for senior roles should not be shown internships."""
    from .sources.seniority import matches

    assert not matches("Working Student Data Science", levels=["Mid-Senior level"])
    assert not matches("Junior Data Analyst", levels=["Mid-Senior level"])
    assert matches("Senior Data Scientist", levels=["Mid-Senior level"])


def test_the_most_senior_marker_in_a_title_wins():
    """A title carrying two markers is the more senior of them: a "Senior
    Graduate Programme Lead" is not an entry-level job."""
    from .sources.seniority import level_of

    # "Senior" and "Lead" both sit at Mid-Senior; "Graduate" does not win
    # just because it appears later in the string.
    assert level_of("Senior Graduate Programme Lead") == "Mid-Senior level"
    # "Head of" outranks both, so this is a Director role however junior the
    # people it looks after.
    assert level_of("Head of Junior Talent") == "Director"

    from .sources.seniority import matches
    assert not matches("Senior Graduate Programme Lead", levels=["Entry level"])


def test_a_years_cap_reads_the_smallest_number_asked_for():
    """A description wanting "2+ years of Python" and "5+ years in a regulated
    industry" is open to someone with two -- the larger figure is usually a
    nice-to-have further down the page. Taking the maximum turned postings
    somebody qualified for into rejections."""
    from .sources.seniority import matches, years_required

    assert years_required("You have 2+ years of Python and 5+ years in banking") == 2
    assert years_required("Minimum 7 years of experience required") == 7
    assert years_required("A great place to work") is None
    # Founded-in years and company ages are not requirements.
    assert years_required("We have been building since 1998, over 27 years") is None

    assert matches("Data Scientist", "Requires 8+ years of experience", max_years=3) is False
    assert matches("Data Scientist", "Requires 2 years of experience", max_years=3) is True
    # Nothing stated means nothing to reject on.
    assert matches("Data Scientist", "A lovely team", max_years=3) is True


def test_a_remote_job_that_names_a_country_is_remote_within_it():
    """Remote used to bypass the location filter entirely, on the grounds
    that location is the thing remote jobs do not care about. That is untrue
    of most of them: "Remote - US" means remote on US payroll, in US hours,
    with the right to work there. They were arriving at the top of a Germany
    search, and they were the commonest bad match this app produced."""
    from .sources._common import location_ok

    for stated in ["Remote - US", "Remote (UK)", "Remote | CA", "Remote (Canada)"]:
        assert not location_ok(stated, True, "Germany", False), stated

    # The same postings are right for someone in that country.
    assert location_ok("Remote - US", True, "United States", False)
    assert location_ok("Remote - DE", True, "Germany", False)


def test_a_remote_job_that_names_nowhere_is_still_kept():
    """Rejecting on evidence, not on silence -- the same rule the seniority
    filter follows. A posting that says only "Remote" means it."""
    from .sources._common import location_ok

    for open_to_all in ["Remote", "Worldwide", "Anywhere", ""]:
        assert location_ok(open_to_all, True, "Germany", False), open_to_all


def test_a_region_is_expanded_before_it_is_compared():
    """"Remote, EMEA" and "Remote - Europe" both include Germany. Comparing
    the words alone would drop them for naming neither Germany nor nothing."""
    from .sources._common import location_ok

    assert location_ok("Remote, EMEA", True, "Germany", False)
    assert location_ok("Remote - Europe", True, "Germany", False)
    assert not location_ok("Remote - Europe", True, "Canada", False)


def test_a_two_letter_code_is_only_trusted_beside_a_remote_marker():
    """"us", "in" and "it" are ordinary English words, so places.countries_in
    refuses to read them as countries anywhere in a sentence. Directly after
    "Remote" and a separator there is nothing else they can be, and that is
    how half these postings write themselves."""
    from .sources import places
    from .sources._common import _remote_country_code

    assert places.countries_in("Remote - US") == set()          # the general rule holds
    assert _remote_country_code("Remote - US") == {"united states"}
    # Not a country just because the letters appear somewhere.
    assert _remote_country_code("Join us remotely from anywhere") == set()


def test_an_undated_posting_is_not_a_stale_one():
    """Boards write dates every way imaginable and several write none at all.
    Treating an unparseable date as old would quietly discard whole boards."""
    from datetime import date
    from .sources.filters import age_in_days, fresh_enough

    assert age_in_days("2026-09-18", date(2026, 9, 20)) == 2
    assert age_in_days("18.09.2026", date(2026, 9, 20)) == 2
    assert age_in_days("", date(2026, 9, 20)) is None
    assert age_in_days("last Tuesday", date(2026, 9, 20)) is None

    assert fresh_enough("", 7), "no date is not evidence of age"
    assert fresh_enough("2026-09-18", None), "no window means no filtering"


def test_a_salary_floor_reads_the_top_of_the_band():
    """A posting advertising 55,000-75,000 is open to someone wanting 70,000.
    Filtering on the bottom rejects the job they would be offered."""
    from .sources.filters import pays_enough, salary_figures

    assert salary_figures("EUR 55,000 - 75,000") == [75000, 55000]
    assert salary_figures("60k - 80k") == [80000, 60000]
    assert pays_enough("55,000 - 75,000", 70000)
    assert not pays_enough("30,000 - 40,000", 70000)

    # An hourly rate is not a salary, and reading it as one would hide
    # contract work behind any floor at all.
    assert salary_figures("EUR 65 per hour") == []
    assert pays_enough("EUR 65 per hour", 70000)
    # Saying nothing is not saying it pays badly.
    assert pays_enough("Competitive salary", 70000)
    assert pays_enough("", 70000)


def test_a_blocked_employer_is_blocked_under_every_spelling():
    """Agencies appear as "Acme GmbH", "ACME Recruitment Ltd." and "Acme" in
    one afternoon. A blocklist matching one spelling gets abandoned."""
    from .sources.filters import blocked

    for spelling in ["Acme GmbH", "ACME Recruitment Ltd.", "acme", "Acme Solutions"]:
        assert blocked(spelling, ["Acme"]), spelling
    assert not blocked("Beacon Ltd", ["Acme"])
    assert not blocked("Acme GmbH", [])


def test_only_an_explicit_refusal_to_sponsor_counts():
    """Most postings say nothing about visas. Treating silence as refusal
    would hide almost the whole market from the people who most need it."""
    from .sources.filters import open_to, refuses_sponsorship

    for refusal in [
        "We cannot sponsor visas",
        "No visa sponsorship is available",
        "Applicants must already have the right to work in Germany",
        "EU citizens only",
    ]:
        assert refuses_sponsorship(refusal), refusal

    for fine in [
        "Visa sponsorship available",
        "We support visa applications for the right candidate",
        "A great team and a good pension",
        "",
    ]:
        assert not refuses_sponsorship(fine), fine

    # Someone who does not need sponsoring is never filtered by this.
    assert open_to("We cannot sponsor visas", needs_sponsorship=False)
    assert not open_to("We cannot sponsor visas", needs_sponsorship=True)


def test_an_optional_board_is_absent_rather_than_broken():
    """Adzuna needs a free key. Without one it should contribute nothing and
    say nothing, the way the borrowed scrapers vanish when linkedin.py is
    missing -- an optional source must not be able to fail a search."""
    import os

    from .sources.boards import adzuna

    saved = (os.environ.pop("ADZUNA_APP_ID", None), os.environ.pop("ADZUNA_APP_KEY", None))
    try:
        assert adzuna(["Data Scientist"], 20) == []
    finally:
        if saved[0]:
            os.environ["ADZUNA_APP_ID"] = saved[0]
        if saved[1]:
            os.environ["ADZUNA_APP_KEY"] = saved[1]


def test_stepstone_relative_dates_become_real_ones():
    """StepStone writes "vor 2 Tagen", and the freshness filter reads ISO
    dates. Left untranslated every StepStone posting is undated -- kept, but
    never filterable by age, which is most of what a job seeker sorts by."""
    from datetime import datetime, timedelta, timezone

    from .sources.boards import _stepstone_posted

    today = datetime.now(timezone.utc).date()
    assert _stepstone_posted("vor 2 Tagen") == (today - timedelta(days=2)).isoformat()
    assert _stepstone_posted("vor 1 Tag") == (today - timedelta(days=1)).isoformat()
    # Hours and minutes are today, not some number of days ago.
    assert _stepstone_posted("vor 5 Stunden") == today.isoformat()
    # Anything unrecognised is undated rather than wrongly dated.
    assert _stepstone_posted("gestern") == ""
    assert _stepstone_posted("") == ""


def test_a_page_that_cannot_be_read_is_not_a_failed_search():
    """get_html returns "" for any non-2xx rather than raising, so a board
    behind a consent wall or a rate limit contributes nothing and the other
    seven still answer."""
    from .sources._common import get_html

    assert get_html("https://www.stepstone.de/definitely-not-a-real-page-xyz") == ""


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failures = []

    for test in tests:
        try:
            test()
            print(f"  pass  {test.__name__}")
        except Exception as exc:
            failures.append((test.__name__, exc))
            print(f"  FAIL  {test.__name__}: {type(exc).__name__}: {exc}")

    print(f"\n{len(tests) - len(failures)}/{len(tests)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
