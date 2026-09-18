"""Swap a few words inside the ORIGINAL CV PDF, changing nothing else.

The earlier approach rebuilt a CV from its extracted text. That can never
come back looking like the document it came from: a real CV carries a photo,
a coloured header bar, two-tone rules, bold inline labels, a specific font --
none of which survive "read the words out, lay them back down again". The
comparison that killed it was a candidate's own CV, with a photo and a dark
header, returning as a plain one-column Helvetica page.

So this module does not rebuild anything. It opens the original PDF and
performs a small number of find-and-replace edits *in place*:

  - the photo, the header bar, the rules, the margins, the fonts are the
    original objects, untouched, because they are never re-drawn;
  - a replaced phrase is re-typeset with the SAME embedded font, size and
    colour as the words it replaces, extracted from the original;
  - an edit that would not fit its line is not applied, and is reported.
    Nothing is allowed to overlap or reflow: a CV that silently smears two
    words together is worse than one that kept the original wording.

One honest caveat. Replacement text is appended to the page's content
stream, so a naive reader that follows stream order (rather than position)
reports the new words at the end of the page instead of mid-sentence. On the
page and to any position-aware extractor -- `get_text(sort=True)`,
`pdftotext -layout`, and the layout-aware parsers ATS software generally uses
-- it reads correctly. The replaced phrase always stays one contiguous run
either way, which is what a keyword screen matches on.
"""
from __future__ import annotations

import io
import os
import re
from pathlib import Path
from dataclasses import dataclass, field
from typing import Dict, List, Sequence, Tuple

import fitz

from .models import CVKeywordEdit

# get_text("dict") span flags: bit 4 is bold, bit 1 is italic.
_BOLD, _ITALIC = 1 << 4, 1 << 1

# How far a replacement may be shrunk to fit the space its original occupied
# before it is refused instead. A couple of percent is invisible; past this it
# reads as a different font size on the page, which is its own defect.
_MIN_SCALE = 0.92

# Breathing room kept between a replacement and whatever follows it on the
# line, so a fitted edit never ends up touching the next word.
_PAD = 1.5

# Right margin assumed when a line has nothing after it and no block to
# bound it -- rare, and better than running text to the paper's edge.
RIGHT_MARGIN = 56.0

# How much narrower than the original a replacement may be before the hole it
# leaves is worse than the keyword it brings in. The rest of the line cannot
# be pulled left to close the gap -- that would drag right-aligned content
# (the dates sitting at the end of every job line) out of alignment -- so a
# much shorter replacement simply leaves a visible hole mid-sentence.
_MIN_WIDTH_RATIO = 0.65


@dataclass
class EditReport:
    """What actually happened, per edit -- so the caller can say so."""

    applied: List[CVKeywordEdit] = field(default_factory=list)
    not_found: List[CVKeywordEdit] = field(default_factory=list)
    did_not_fit: List[CVKeywordEdit] = field(default_factory=list)
    # Applied, but by adding a line rather than by swapping words in place.
    # Kept apart from `applied` because it is a different promise to the
    # user: the words went on, and the document is one line longer than the
    # one they uploaded. Also in `applied` -- these edits are in the file.
    inserted: List[CVKeywordEdit] = field(default_factory=list)
    # Of those, the ones whose new line is set in a substitute typeface
    # because the CV's own font could not be re-embedded.
    font_substituted: List[CVKeywordEdit] = field(default_factory=list)
    left_a_gap: List[CVKeywordEdit] = field(default_factory=list)
    overlapped: List[CVKeywordEdit] = field(default_factory=list)
    # For an edit refused on width: roughly how many more characters that
    # line could take, keyed by the edit's `find`. "It did not fit" leaves
    # the user with nothing to do; "about nine more characters would fit"
    # tells them whether to shorten the line or drop one of the new terms.
    room_left: Dict[str, int] = field(default_factory=dict)

    @property
    def skipped(self) -> List[CVKeywordEdit]:
        return [*self.not_found, *self.did_not_fit, *self.left_a_gap, *self.overlapped]


@dataclass
class _Write:
    """One replacement, measured against the original page and waiting to be
    drawn once every redaction on that page has been applied."""

    origin: Tuple[float, float]
    text: str
    font: "fitz.Font"
    size: float
    color: Tuple[float, float, float]


def apply_keyword_edits(
    pdf_bytes: bytes, edits: Sequence[CVKeywordEdit]
) -> Tuple[bytes, EditReport]:
    """Apply `edits` to the original PDF and return the new bytes.

    Two phases, and the order matters: every hit is measured and every
    erasure queued against the ORIGINAL page first, then each page has its
    redactions applied once, and only then is the replacement text drawn.
    Interleaving them does not work -- apply_redactions rewrites the whole
    content stream, so a second edit's redaction pass silently erased the
    text a first edit had already written. (That failure is invisible in the
    output bytes: you get a valid PDF with a blank gap where the words were.)

    Never raises on an edit that cannot be made: it is reported and the
    original wording is left in place. Raises ValueError only if the file is
    not a readable PDF at all.
    """
    try:
        doc = fitz.open(stream=io.BytesIO(pdf_bytes), filetype="pdf")
    except Exception as exc:  # a corrupt upload, not a bad edit
        raise ValueError(f"That CV could not be opened as a PDF: {exc}") from exc

    report = EditReport()
    try:
        font_cache: Dict[Tuple[int, str], object] = {}
        planned: Dict[int, List[_Write]] = {}
        # Regions already spoken for by an earlier edit, so two edits cannot
        # both rewrite the same words -- see _plan_one.
        claimed: Dict[int, List[fitz.Rect]] = {}

        # The searchable form of each edit, kept for the reflow pass below:
        # it works from the anchor actually found on the page, not from the
        # model's own phrasing of it.
        searchable: Dict[str, Tuple[str, str]] = {}

        for edit in edits:
            find, replace = _searchable(doc, edit)
            if not find or not replace:
                report.not_found.append(edit)
                continue
            searchable[edit.find] = (find, replace)
            context = _context_words(edit.find, find)
            if _plan_one(doc, edit, find, replace, context, font_cache, planned, claimed, report):
                report.applied.append(edit)

        for page in doc:
            writes = planned.get(page.number)
            if not writes:
                continue
            # PDF_REDACT_IMAGE_NONE keeps the photo; LINE_ART_NONE keeps the
            # header bar and the section rules. Without both, "erase these
            # words" quietly erases the artwork they sit on top of.
            page.apply_redactions(
                images=fitz.PDF_REDACT_IMAGE_NONE,
                graphics=fitz.PDF_REDACT_LINE_ART_NONE,
            )
            for write in writes:
                # TextWriter rather than insert_text: it takes the Font object
                # itself, so the font the width was measured with is exactly
                # the font that gets embedded and drawn.
                writer = fitz.TextWriter(page.rect)
                _append_words(writer, write)
                writer.write_text(page, color=write.color)

        out = doc.tobytes(garbage=4, deflate=True)
    finally:
        doc.close()

    # Everything above could only rewrite words inside the space they already
    # occupied. What is left in did_not_fit is the edits that were refused
    # purely for want of room, which is what adding a line is for.
    return _insert_what_would_not_fit(out, searchable, report), report


def _insert_what_would_not_fit(
    pdf_bytes: bytes, searchable: Dict[str, Tuple[str, str]], report: EditReport
) -> bytes:
    """Put the edits that ran out of room on a line of their own.

    Only pure appends are eligible -- an edit whose replacement begins with
    its own find is extending a list, and the terms it adds read correctly
    under the row they continue. A reworded phrase is not: moving "Applied AI
    Engineer" to its own line would leave the old title in place above it and
    say two different things.

    Everything is delegated to cv_reflow, which refuses whenever the page has
    no spare paper at its foot, the line would overrun the margin, or the
    CV's font cannot be re-embedded. A refusal here is not a failure: the
    edit stays in did_not_fit and the user is told the line is full, which is
    exactly what they were told before.
    """
    from .cv_reflow import insert_line_below

    still_refused: List[CVKeywordEdit] = []

    for edit in report.did_not_fit:
        find, replace = searchable.get(edit.find, (edit.find, edit.replace))

        # Not an append: nothing to continue onto a new line.
        if not replace.startswith(find):
            still_refused.append(edit)
            continue

        # The added terms alone. The line above already ends with a term, so
        # whichever separator joined them is dropped rather than left to open
        # the new line with a stray comma or dot. The dot family is spelled
        # out because CV templates set skills rows with them.
        tail = replace[len(find):].lstrip(" ,;|/·•∙⋅・–—-")
        if not tail:
            still_refused.append(edit)
            continue

        pdf_bytes, insertion = insert_line_below(pdf_bytes, find, tail)
        if insertion is None:
            still_refused.append(edit)
            continue

        report.applied.append(edit)
        report.inserted.append(edit)
        if insertion.font_substituted:
            report.font_substituted.append(edit)

    report.did_not_fit = still_refused
    return pdf_bytes


def _as_written_on_the_page(doc, find: str) -> str:
    """Rewrite `find` using the dot the document actually stores.

    PDF text extraction does not give back the character that was written.
    A MIDDLE DOT set in Calibri comes back as a BULLET OPERATOR, in Arial as
    a SINOLOGICAL DOT, in Georgia as itself -- the same mark on paper, three
    codepoints. page.search_for() compares codepoints exactly, so a phrase
    quoted with one variant simply is not found in a document written with
    another, and the edit is reported as "those words are not in your CV"
    about words plainly in it.

    Both the model's quote and this search normally come from the same
    extraction, so they usually agree. They stop agreeing whenever anything
    in between tidies the text up -- a model normalising an unusual
    character, a copy-paste through an editor, a CV whose own sections were
    pasted from different sources. This makes that harmless: whatever dot
    the phrase arrives with, it is translated to the one on the page.
    """
    if not any(ch in _DOTS for ch in find):
        return find

    # Which variant this document uses. First one wins: a CV mixing two is
    # vanishingly rare, and picking either still beats matching neither.
    for page in doc:
        try:
            text = page.get_text()
        except Exception:
            continue
        for ch in text:
            if ch in _DOTS:
                return "".join(ch if c in _DOTS else c for c in find)
    return find


def _squash(text: str) -> str:
    """One-space whitespace, so a phrase can be counted across a line break."""
    return re.sub(r"\s+", " ", text)


def _searchable(doc, edit) -> Tuple[str, str]:
    """The form of this edit that can actually be located on the page.

    Judged by searching the PAGES, not the extracted text. Those disagree,
    and the disagreement is not academic: a skills table with a label column
    extracts as "Other Hadoop, Git, REST APIs, Streamlit, Playwright" -- one
    string -- while on the page "Other" and the tools are separate cells, so
    no single run of text says that and nothing can be replaced. Counting
    occurrences in the extracted text called that findable and refused the
    shorter form, then failed to find the longer one: "those exact words are
    not in your CV", about words plainly in the CV.

    The model's own phrasing wins when it is locatable on one line. Otherwise
    the trimmed form is used, and _context_words keeps it pointed at the
    right place.
    """
    # Whatever dot the phrase arrives with, use the one the page stores --
    # otherwise an exact-codepoint search misses words plainly in the CV.
    find = _as_written_on_the_page(doc, edit.find.strip())
    replace = _as_written_on_the_page(doc, edit.replace.strip())
    if _single_line_hits(doc, find):
        return _append_at_the_end_of_the_line(doc, find, replace)

    short_find, short_replace = _minimise(find, replace)
    if short_find and short_find != find and _single_line_hits(doc, short_find):
        return _append_at_the_end_of_the_line(doc, short_find, short_replace)
    return "", ""


def _append_at_the_end_of_the_line(doc, find: str, replace: str) -> Tuple[str, str]:
    """Move an append to the end of the run it lands in.

    A model asked to extend a skills list quotes as much of it as it feels
    like. Given "Scikit-learn, PyTorch, TensorFlow, XGBoost, Hugging Face
    Transformers" it may quote only up to "XGBoost" and append there -- which
    is the middle of the line, where the words that follow leave no room, and
    the edit is refused as "that line is completely full" when the end of
    that very line has space to spare.

    The intent is not in doubt: an edit whose replacement begins with its own
    find is adding to the end of a list. So the anchor is moved to the end of
    the run and the same addition made there. Only pure appends are moved --
    a reworded phrase must stay exactly where the words it replaces are.
    """
    if not replace.startswith(find):
        return find, replace
    tail = replace[len(find):]

    for page in doc:
        try:
            rects = page.search_for(find)
        except Exception:
            continue
        for rect in rects:
            style = _style_at(page, rect)
            if style is None or rect.height > style["size"] * 1.8:
                continue
            span_text = style["span_text"]
            index = span_text.find(find)
            if index < 0:
                continue
            rest = span_text[index:].rstrip()
            # Already at the end of its run: nothing to move.
            if rest == find or not rest.startswith(find):
                return find, replace
            return rest, rest + tail
    return find, replace


def _single_line_hits(doc, text: str) -> int:
    """How many places this text appears as ONE line of a page.

    A hit spanning a line break -- or, in a table, spanning two columns --
    comes back as a tall rectangle. Those cannot be re-typeset as a single
    run, so they do not count as found.
    """
    if not text:
        return 0
    hits = 0
    for page in doc:
        try:
            rects = page.search_for(text)
        except Exception:
            continue
        for rect in rects:
            style = _style_at(page, rect)
            if style is not None and rect.height <= style["size"] * 1.8:
                hits += 1
    return hits


def _context_words(original_find: str, search_find: str) -> set:
    """Words from the model's full phrase that the trimmed one dropped.

    A trimmed search term can land in more than one place -- "Playwright" is
    both a tool in the skills table and a word in a project description. The
    dropped words say which one was meant: the skills row also contains
    "Hadoop" and "Streamlit", the project paragraph does not.
    """
    kept = {w for w in re.split(r"[^A-Za-z0-9+#.]+", search_find.lower()) if len(w) > 2}
    return {
        w
        for w in re.split(r"[^A-Za-z0-9+#.]+", original_find.lower())
        if len(w) > 2 and w not in kept
    }


def _minimise(find: str, replace: str) -> Tuple[str, str]:
    """Shrink an edit to only the words that actually differ.

    Models hand back whole sentences even when told not to: asked to bring
    "AI Engineer" into a summary, one returned the entire 80-character
    opening line as `find`, with three words changed in the middle. A line
    that long has wrapped in the real document, so it cannot be located as a
    single run and the edit is lost -- for a change that was only ever two
    words wide.

    Trimming the shared prefix and suffix turns that into
    "Data Specialist" -> "AI Engineer": short, on one line, findable. It also
    makes the length rule easier to satisfy, because the words either side no
    longer pad both strings to look equal.

    A pure insertion (nothing left on the `find` side) comes back empty and
    is skipped by the caller -- there is no existing text to replace, and
    making room for new words would reflow the page.
    """
    f, r = find.split(" "), replace.split(" ")

    start = 0
    while start < len(f) and start < len(r) and f[start] == r[start]:
        start += 1

    end = 0
    while end < len(f) - start and end < len(r) - start and f[-1 - end] == r[-1 - end]:
        end += 1

    return " ".join(f[start : len(f) - end]), " ".join(r[start : len(r) - end])


def _append_words(writer, write: "_Write") -> None:
    """Lay the replacement down one word at a time, at computed offsets.

    Not one append of the whole string, because of how the fonts in a real CV
    are stored. They are subsets, and a subset's cmap generally omits U+0020
    (a space is an advance, not a drawn glyph), so TextWriter substitutes a
    NON-BREAKING space to keep the run intact. On the page that is invisible
    -- the spacing is identical -- but in the extracted text the words come
    back joined by U+00A0, and this whole feature exists to be read by
    keyword screens. Positioning each word separately leaves a real gap, and
    the text extracts with ordinary spaces.
    """
    x, y = write.origin
    for word in write.text.split(" "):
        if word:
            writer.append((x, y), word, font=write.font, fontsize=write.size)
        x += write.font.text_length(word + " ", fontsize=write.size)


def _plan_one(doc, edit, find: str, replace: str, context, font_cache, planned, claimed, report: EditReport) -> bool:
    """Queue one find-and-replace across the document. True if anything will change.

    An edit whose text overlaps one an earlier edit already claimed is
    skipped. Models hand back overlapping edits routinely -- asked to retitle
    a CV, one returned "Associate Data Scientist" -> "Applied AI Engineer"
    AND "Associate Data Scientist - AI & GenAI Solutions" -> "Applied AI
    Engineer - AI & GenAI Solutions", both matching the same header line.
    Applying both redacted the line once and then drew two replacements over
    each other, producing "AppliedApplied AIAIAppliedEngineerEngineer" across
    the top of the document. Earlier edits win, since they are ordered most
    valuable first.
    """
    found_anywhere = False
    fitted_anywhere = False
    too_narrow_anywhere = False
    overlapped_anywhere = False

    for page in doc:
        # One rect per hit. A hit that wrapped across a line break comes back
        # as a rect spanning both lines, which cannot be re-typeset safely --
        # those are filtered by the height check below.
        try:
            hits = page.search_for(find)
        except Exception:
            continue
        if not hits:
            continue
        found_anywhere = True

        for rect in hits:
            # The trimmed term can match somewhere the model never meant.
            # The words it dropped decide: the intended line still carries
            # them, an unrelated one does not.
            if context and not (context & _line_words(page, rect)):
                continue

            if any((rect & taken).get_area() > 0 for taken in claimed.get(page.number, [])):
                overlapped_anywhere = True
                continue

            style = _style_at(page, rect)
            if style is None or rect.height > style["size"] * 1.8:
                continue

            available = _available_width(page, rect, style, find)
            font = _usable_font(page, style, replace, font_cache)
            size = _fitted_size(replace, font, style["size"], available)
            if size is None:
                # How much this line could actually take, in characters, so
                # the refusal is something the user can act on.
                spare = available - font.text_length(find, fontsize=style["size"])
                per_char = font.text_length("n", fontsize=style["size"]) or 1.0
                report.room_left[edit.find] = max(int(spare / per_char), 0)
                continue

            # Too short leaves a hole where the old words were -- see
            # _MIN_WIDTH_RATIO for why the line cannot simply be closed up.
            if font.text_length(replace, fontsize=size) < rect.width * _MIN_WIDTH_RATIO:
                too_narrow_anywhere = True
                continue

            fitted_anywhere = True
            page.add_redact_annot(rect)
            claimed.setdefault(page.number, []).append(rect)
            planned.setdefault(page.number, []).append(
                _Write(style["origin"], replace, font, size, style["color"])
            )

    # Reported as the edit the CALLER gave us, not the trimmed form we
    # searched with: "MLOps: ... , Kubernetes" is what they chose, and
    # "Databricks,Airflow" is an implementation detail of finding it.
    if not found_anywhere:
        report.not_found.append(edit)
    elif not fitted_anywhere:
        if overlapped_anywhere:
            bucket = report.overlapped
        elif too_narrow_anywhere:
            bucket = report.left_a_gap
        else:
            bucket = report.did_not_fit
        bucket.append(edit)
    return fitted_anywhere


def _line_words(page, rect: fitz.Rect) -> set:
    """Every word on the visual line this rectangle sits on.

    The whole line, across columns: a label cell and its value cell are
    different runs at the same height, and "which row is this" is answered by
    both together.
    """
    words = set()
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                span_rect = fitz.Rect(span["bbox"])
                if span_rect.y1 > rect.y0 and span_rect.y0 < rect.y1:
                    words.update(
                        w
                        for w in re.split(r"[^A-Za-z0-9+#.]+", span.get("text", "").lower())
                        if len(w) > 2
                    )
    return words


def _style_at(page, rect: fitz.Rect):
    """The font, size, colour and baseline of the text inside `rect`.

    Read from the page rather than assumed, so a replacement is set in the
    same font as the words it stands in for -- including when a CV uses a
    different font for one bold label than for its body text.
    """
    best = None
    best_overlap = 0.0
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                if not span.get("text", "").strip():
                    continue
                overlap = (fitz.Rect(span["bbox"]) & rect).get_area()
                if overlap > best_overlap:
                    best_overlap, best = overlap, span
    if best is None:
        return None

    colour = best.get("color", 0)
    return {
        "font": best.get("font", ""),
        "size": best.get("size", 10.0),
        "flags": best.get("flags", 0),
        "color": (((colour >> 16) & 255) / 255, ((colour >> 8) & 255) / 255, (colour & 255) / 255),
        # The span's own baseline, not the rect's top: insert_text positions
        # by baseline, and using the rect would drop the text by its ascent.
        "origin": (rect.x0, best["origin"][1]),
        # The run of text this match sits inside: its right edge, and its
        # text. Between them they decide whether anything actually follows
        # the match on this line, which is what limits how long a
        # replacement may be.
        "span_x1": best["bbox"][2],
        "span_text": best.get("text", ""),
        # The width this run actually occupies on the page. Ground truth for
        # deciding whether a font we are considering measures like the one
        # that drew it -- see _font_fits_the_page.
        "span_width": best["bbox"][2] - best["bbox"][0],
    }


def _available_width(page, rect: fitz.Rect, style, find: str) -> float:
    """How far right the replacement may run before it would collide.

    The gap to the next span on the same line, or -- when nothing follows it
    -- the right edge of the text block it belongs to, which is what keeps a
    replacement inside its column instead of out over the margin.
    """
    # First: does the run of text this match sits inside continue past it?
    # A phrase matched mid-sentence has the rest of its own sentence pressed
    # up against it, and that text is not a separate span the loop below
    # could find -- it is the same span, starting to the LEFT of the match.
    # Missing this drew "Applied AI Engineer with 3+ years" straight over the
    # "of experience building..." that followed it.
    #
    # Decided from the span's TEXT, not its width. A span almost always ends
    # with a trailing space, which puts its right edge a couple of points
    # past the last visible glyph -- read geometrically that looks like text
    # following the match, and it silently refused every append to the end of
    # a skills line ("...XGBoost" + ", Hugging Face"), which is where most of
    # the keyword value is.
    # Only decidable when the match really does sit inside one run. A match
    # spanning two runs -- a table's label cell plus its value cell -- cannot
    # be answered this way, and answering it "yes" out of caution clamped
    # every such row to its existing width, reporting a table row with 200pt
    # of clear margin beside it as completely full. Those fall through to the
    # collision search below, which handles them correctly.
    span_text = style["span_text"]
    if find in span_text and span_text[span_text.index(find) + len(find) :].strip():
        return max(rect.width - _PAD, 0.0)

    # Nothing follows inside the run, so the line may grow -- up to whatever
    # it would actually hit. Collected as candidate limits, nearest wins.
    limits = []

    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                span_rect = fitz.Rect(span["bbox"])
                # Text starting after our hit ends, on the same visual line.
                # "Same line" is VERTICAL overlap, not a rectangle
                # intersection: a span to the right never overlaps ours
                # horizontally, so intersecting rectangles only found it when
                # the extractor happened to group both into one line -- and
                # when it did not, a replacement was free to grow straight
                # over the text beside it.
                if (
                    span_rect.x0 >= rect.x1 - 0.5
                    and span_rect.y1 > rect.y0
                    and span_rect.y0 < rect.y1
                    and span.get("text", "").strip()
                ):
                    limits.append(span_rect.x0)

    # An image sitting to the right on this line -- a portrait photo beside a
    # header, typically. Text may not grow underneath it.
    for image_rect in _image_rects(page):
        if image_rect.x0 >= rect.x1 - 0.5 and image_rect.y1 > rect.y0 and image_rect.y0 < rect.y1:
            limits.append(image_rect.x0)

    # Otherwise the document's own right-hand text margin. NOT the enclosing
    # block's right edge, which was the previous rule: a tidy skills table's
    # block is exactly as wide as its longest row, so every row in it
    # measured as full even with 130pt of blank margin alongside. The page's
    # widest text is what the author themselves treated as the edge.
    limits.append(_text_right_edge(page))

    return max(min(limits) - rect.x0 - _PAD, 0.0)


def _image_rects(page) -> List[fitz.Rect]:
    try:
        return [page.get_image_bbox(info) for info in page.get_images(full=True)]
    except Exception:
        return []


def _text_right_edge(page) -> float:
    """How far right this page's text actually runs -- the author's own margin."""
    right = 0.0
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                if span.get("text", "").strip():
                    right = max(right, span["bbox"][2])
    return right or (page.rect.x1 - RIGHT_MARGIN)


def _text_follows(span_text: str, find: str) -> bool:
    """Is there real text after `find` inside the run it was found in?

    Trailing whitespace does not count: a replacement may grow into it. When
    the match cannot be located in the span at all (search_for can span two
    spans), the safe answer is yes -- refusing an edit costs a keyword,
    allowing a bad one costs an overlapping line in a real application.
    """
    index = span_text.find(find)
    if index < 0:
        return True
    return bool(span_text[index + len(find) :].strip())


def _usable_font(page, style, text: str, cache) -> "fitz.Font":
    """The original embedded font if it can safely set `text`, else base14.

    Reusing the real font is what makes a replaced word indistinguishable
    from its neighbours. But the fonts in a Word-exported CV are SUBSETS
    (`BCDEEE+Cambria`): they carry only the glyphs the document already used.
    Re-embedding one and then setting a character it does not contain
    produces a blank or a notdef box on the page, silently -- so the glyph
    coverage is checked against this specific replacement before the font is
    accepted, and a font that cannot spell it loses to a base14 that can.

    Returned as a Font object rather than a name so the width measurement
    that decides whether the text fits comes from exactly what will draw it.
    """
    key = (page.number, style["font"])
    if key not in cache:
        cache[key] = _resolve_font(page, style)
    font = cache[key]

    if font is not None and _can_render(font, text):
        return font
    return fitz.Font(fontname=_base14(style["flags"]))


def _resolve_font(page, style):
    """The font that drew this text, or the closest thing that measures like it.

    Tried in order, and every candidate has to prove itself against the page:

    1. The font embedded in the PDF. Usually right, and right by definition.
    2. The same family installed on this machine. A subsetted CID font can
       be unusable -- no cmap, so it renders as a substitute face AND
       measures nothing like itself. The real file does both properly.
    3. A metric-compatible stand-in, for families that exist precisely to be
       one (Carlito for Calibri, Caladea for Cambria -- the pairs LibreOffice
       swaps in when it opens a Word document).

    The proof is arithmetic: predict the width of a run of text already on
    the page and compare it to the width it actually occupies. A font that
    agrees to within a couple of percent is the one that drew it, or is
    indistinguishable from it. The document that prompted this reported
    every character missing and over-measured by 18%, which silently set
    replacements in Helvetica and called lines full that had room to spare.
    """
    embedded = _embedded_font(page, style["font"])
    if embedded is not None and _font_fits_the_page(embedded, style):
        return embedded

    for candidate in _system_candidates(style):
        if _font_fits_the_page(candidate, style):
            return candidate

    # Nothing measured right. The embedded font is still the document's own
    # and is the least-wrong option for a replacement inside a line.
    return embedded


def _font_fits_the_page(font, style) -> bool:
    """Does this font predict the width the page actually shows?"""
    text, actual = style.get("span_text", ""), style.get("span_width", 0.0)
    if len(text.strip()) < 8 or actual <= 0:
        return True  # too little to judge on; do not reject for lack of evidence
    predicted = font.text_length(text, fontsize=style["size"])
    if predicted <= 0:
        return False
    return abs(predicted - actual) / actual <= 0.02


# Families published as metric-compatible replacements for each other. Only
# pairs where the widths are identical by design belong here -- a font that
# merely looks similar would re-introduce the measurement error this exists
# to remove.
_METRIC_TWINS = {
    "carlito": "calibri",
    "calibri": "carlito",
    "caladea": "cambria",
    "cambria": "caladea",
    "liberationsans": "arial",
    "arial": "liberationsans",
    "liberationserif": "timesnewroman",
    "timesnewroman": "liberationserif",
}

_FONT_DIRS = (
    Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts",
    Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/Windows/Fonts",
    Path("C:/Program Files/LibreOffice/share/fonts/truetype"),
    Path("/usr/share/fonts"),
    Path("/Library/Fonts"),
)


def _system_candidates(style) -> List["fitz.Font"]:
    """Installed fonts that might be the one this text was set in."""
    family = re.sub(r"[^a-z0-9]", "", style["font"].split("+")[-1].split("-")[0].lower())
    if not family:
        return []

    wanted = [family]
    twin = _METRIC_TWINS.get(family)
    if twin:
        wanted.append(twin)

    bold, italic = bool(style["flags"] & _BOLD), bool(style["flags"] & _ITALIC)
    fonts = []
    for name in wanted:
        for path in _font_files().get(name, []):
            stem = path.stem.lower()
            suffix = stem[len(name):] if stem.startswith(name) else ""
            # Windows names its weights by a trailing letter: b bold, i
            # italic, z bold-italic, nothing for regular.
            if bold and italic and suffix not in ("z", "bi", "bolditalic"):
                continue
            if bold and not italic and suffix not in ("b", "bd", "bold"):
                continue
            if italic and not bold and suffix not in ("i", "it", "italic"):
                continue
            if not bold and not italic and suffix not in ("", "regular", "-regular"):
                continue
            try:
                fonts.append(fitz.Font(fontfile=str(path)))
            except Exception:
                continue
    return fonts


_font_index: Dict[str, List[Path]] | None = None


def _font_files() -> Dict[str, List[Path]]:
    """Installed font files, indexed by the family their filename starts with."""
    global _font_index
    if _font_index is not None:
        return _font_index

    index: Dict[str, List[Path]] = {}
    for directory in _FONT_DIRS:
        try:
            if not directory.is_dir():
                continue
            for path in directory.iterdir():
                if path.suffix.lower() not in (".ttf", ".otf"):
                    continue
                stem = re.sub(r"[^a-z0-9]", "", path.stem.lower())
                # Index under every prefix so "calibrib" is found under
                # "calibri" without needing to know the weight suffixes.
                for length in range(4, len(stem) + 1):
                    index.setdefault(stem[:length], []).append(path)
        except Exception:
            continue
    _font_index = index
    return index


def _can_render(font: "fitz.Font", text: str) -> bool:
    """Will this font actually produce these characters?

    Answered by drawing them and reading them back, not by asking the font.
    `has_glyph` consults the font's unicode cmap, and a subsetted CID font --
    Carlito, as exported by LibreOffice, and the font of one of the CVs this
    was built against -- can have no usable cmap at all: it reports every
    character missing, including the letters plainly visible on the page.
    Trusting it silently set every replacement in that document in Helvetica.

    Drawing is the only answer that cannot disagree with the page. It also
    still catches the real failure -- a subset genuinely lacking a glyph
    renders a blank or a notdef box, and the text does not come back.
    """
    return _probe_render(font, text)[0]


# Characters a font may legitimately hand back in place of the one written.
# A font maps ASCII "-" to whichever hyphen glyph it carries, and reading the
# page back reports that glyph's own codepoint: Calibri returns U+2010, so
# "Scikit-learn" written became "Scikit‐learn" read, a mismatch that failed
# the render check and silently demoted the whole document to Helvetica.
# These are the same character as far as a reader or a keyword screen cares.
# Every codepoint that renders as the same small separating dot. PDF text
# extraction picks among these by font, so they must all be treated as one.
_DOTS = "·•∙⋅・․‧ꞏ∙"

# Characters a PDF round-trip swaps for a visually identical twin.
#
# The point is to stop the render probe calling a perfectly good font broken.
# _probe_render decides whether a font can draw something by writing it and
# extracting it back, and the text layer does not always report the codepoint
# that went in: a middle dot comes back as a bullet operator, a non-breaking
# space as a space. Comparing those literally answers "this font cannot
# render your text" about a font that renders it perfectly.
#
# The dot family is here because CV templates lean on it -- "Python · SQL ·
# Bash" is a common way to set a skills row -- and without it every CV using
# one was refused a new line, while the comma-separated test fixtures passed.
_EQUIVALENT = str.maketrans(
    {
        "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-",
        "‘": "'", "’": "'", "“": '"', "”": '"',
        " ": " ", " ": " ", " ": " ",
        # Dots and bullets: BULLET, BULLET OPERATOR, DOT OPERATOR, KATAKANA
        # MIDDLE DOT, ONE DOT LEADER, HYPHENATION POINT -- one mark on paper,
        # normalised onto MIDDLE DOT so any compares equal to any other.
        "•": "·", "∙": "·", "⋅": "·",
        "・": "·", "․": "·", "‧": "·",
    }
)


def _same_text(got: str, wanted: str) -> bool:
    """Is this the text that was written, allowing for glyph substitutions?"""
    normalise = lambda s: " ".join(s.translate(_EQUIVALENT).split())
    return normalise(got) == normalise(wanted)


def _probe_render(font: "fitz.Font", text: str) -> Tuple[bool, str]:
    """Draw `text` with `font` and report (did the characters survive, which
    font actually drew them).

    The second half matters because "it rendered" and "it rendered in this
    font" are different questions. A subset with no usable cmap cannot be
    re-embedded at all: MuPDF quietly substitutes a default face, so the
    text is correct and the typeface is not. Inside an existing line that is
    a tolerable last resort; for a whole new line it is the first thing a
    reader would notice, so cv_reflow asks the stricter question.
    """
    probe = fitz.open()
    try:
        page = probe.new_page()
        writer = fitz.TextWriter(page.rect)
        writer.append((36, 100), text, font=font, fontsize=11)
        writer.write_text(page)
        # U+00A0 is what TextWriter substitutes for a space in a subset font
        # that has no space glyph; it is a space on the page either way.
        ok = _same_text(page.get_text(), text)
        spans = [
            s
            for b in page.get_text("dict").get("blocks", [])
            for l in b.get("lines", [])
            for s in l.get("spans", [])
        ]
        return ok, (spans[0]["font"] if spans else "")
    except Exception:
        return False, ""
    finally:
        probe.close()


def _embedded_font(page, span_font: str):
    """Pull one embedded font out of the PDF as a Font, or None."""
    wanted = span_font.split("+")[-1]
    for entry in page.get_fonts(full=True):
        # (xref, ext, type, basefont, refname, encoding, ...) -- the tuple has
        # grown a field across PyMuPDF versions, so index rather than unpack.
        xref, ext, basefont = entry[0], entry[1], entry[3]
        if basefont.split("+")[-1] != wanted or ext in ("n/a", ""):
            continue
        try:
            buffer = page.parent.extract_font(xref)[3]
            if buffer:
                return fitz.Font(fontbuffer=buffer)
        except Exception:
            return None
    return None


def _base14(flags: int) -> str:
    bold, italic = bool(flags & _BOLD), bool(flags & _ITALIC)
    if bold and italic:
        return "hebi"
    if bold:
        return "hebo"
    if italic:
        return "heit"
    return "helv"


def _fitted_size(text: str, font: "fitz.Font", size: float, available: float) -> float | None:
    """The size to set `text` at so it fits `available`, or None to refuse.

    Refusing is a real answer: the alternative is a replacement running into
    the next word, and a CV that overlaps its own text is not sendable.
    """
    width = font.text_length(text, fontsize=size)
    if width <= available:
        return size

    needed = size * available / width if width else 0
    return needed if needed >= size * _MIN_SCALE else None
