"""Make room on a full CV line by pushing the page down a line.

The in-place editor (cv_inplace.py) can only change words inside the space
they already occupy. That is what keeps a CV's photo, fonts and alignment
intact, and it means a skills line with no slack simply cannot take another
keyword -- the honest answer was "this line is full", which is true and
unhelpful when the keyword is the whole point.

There is a third option between "give up" and "rebuild the document": insert
a line. Everything below the insertion point moves down by one line, the new
text goes in the gap that opens, and nothing is re-typeset. It works because
a CV usually has unused paper at the bottom of its last page -- 305pt of it,
on the CV this was built against.

How the page is moved, and why this way:

    new page
      |- the original page, clipped to ABOVE the split, drawn in place
      |- the original page, clipped to BELOW the split, drawn one line lower
      `- the new text, written into the gap

`show_pdf_page` draws the source page as a form XObject, so the content is
the ORIGINAL objects -- vector art, the photo, the embedded fonts -- not a
picture of them and not a re-flow. The clip is not merely visual: text
outside it does not appear in the text layer either, which matters because
this document exists to be read by keyword screens and a hidden second copy
of every line would poison that. (Measured: the rebuilt page extracts 303
words against the original's 296, the difference being exactly the words
added.)

The split must fall in the gap BETWEEN two lines. Cutting through a line of
text would slice the glyphs in half -- the top of the letters drawn at the
old height, the bottoms one line lower.
"""
from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Optional

import fitz

from .cv_inplace import (
    _base14,
    _embedded_font,
    _font_fits_the_page,
    _probe_render,
    _style_at,
    _text_right_edge,
)

# Kept clear at the foot of the page. Text pushed into the last few
# millimetres reads as a document that has outgrown itself, and some
# printers will not render it at all.
BOTTOM_MARGIN = 40.0

# How much taller than the text itself a line needs, so an inserted line sits
# on the same rhythm as the ones around it rather than crowding them.
LINE_SPACING = 1.32


@dataclass
class Insertion:
    """A line that was added, and where."""

    text: str
    page_number: int
    after: str
    # True when the CV's own font could not be re-embedded and the new line
    # is set in a substitute. The line is correct and legible; it is not in
    # the same typeface, and the person sending the CV should know that
    # rather than discover it.
    font_substituted: bool = False


def _is_background(rect, page_rect) -> bool:
    """Is this shape the page itself rather than something drawn on it?

    Word and Google Docs both emit a rectangle the size of the sheet to paint
    its background, and designed CVs add full-page borders and panels. They
    reach the bottom edge by definition, so counting them as content makes
    every such page look full to the last millimetre -- and a CV with 140pt
    of white space below its last line gets told there is no room for one
    more. Nothing is disturbed by shifting text across a background: it sits
    underneath, and it is exactly as tall afterwards.
    """
    return (
        rect.width >= page_rect.width * 0.9 and rect.height >= page_rect.height * 0.9
    )


def room_for_a_line(doc, page_number: int, line_height: float) -> bool:
    """Is there unused paper at the foot of this page to push into?"""
    page = doc[page_number]
    lowest = 0.0
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                if span.get("text", "").strip():
                    lowest = max(lowest, span["bbox"][3])
    for drawing in page.get_drawings():
        # A page-sized shape is the background, not the content on it.
        if _is_background(drawing["rect"], page.rect):
            continue
        lowest = max(lowest, drawing["rect"].y1)
    return lowest + line_height <= page.rect.y1 - BOTTOM_MARGIN


def insert_line_below(
    pdf_bytes: bytes, anchor: str, text: str
) -> tuple[bytes, Optional[Insertion]]:
    """Add `text` on a new line under the line containing `anchor`.

    Returns the unchanged bytes and None when it cannot be done: the anchor
    is not on one line, or the page has no room at the bottom to absorb the
    shift. Refusing is the right answer then -- pushing content off the
    bottom of the page to gain a keyword is not a trade anyone wants.
    """
    src = fitz.open(stream=io.BytesIO(pdf_bytes), filetype="pdf")
    try:
        found = _find_anchor(src, anchor)
        if found is None:
            return pdf_bytes, None
        page_number, rect, style = found

        size = style["size"]
        line_height = size * LINE_SPACING
        if not room_for_a_line(src, page_number, line_height):
            return pdf_bytes, None

        # The document's own font where it can be re-embedded. Some subsets
        # cannot be (no usable cmap -- LibreOffice's Carlito is one), and
        # MuPDF then substitutes a default face. That is reported rather
        # than refused: the alternative is telling someone their keyword
        # cannot go on the CV at all because of a font table.
        font = _embedded_font(src[page_number], style["font"])

        # A base-14 font is never embedded -- there is nothing to extract,
        # because every reader already has it. Refusing on that basis would
        # turn "your CV is set in Helvetica" into "your keyword cannot go
        # on", so the standard face is used directly. It is not a substitute
        # for the document's font; for these families it IS the document's
        # font, which the width check below confirms against the page.
        standard_face = False
        if font is None:
            standard = fitz.Font(_base14(style["flags"]))
            if _font_fits_the_page(standard, style):
                font, standard_face = standard, True

        if font is None:
            return pdf_bytes, None
        renders, drawn_as = _probe_render(font, text)
        if not renders:
            return pdf_bytes, None

        # The new line has to fit the page as well as the page has to have
        # room for it. Nothing here wraps -- the words are drawn left to
        # right from the anchor's own left edge -- so text too long for the
        # author's own margin would simply run off the paper. Refusing is
        # the same trade as everywhere else in this file: a keyword is not
        # worth a CV that looks broken.
        if rect.x0 + font.text_length(text, fontsize=size) > _text_right_edge(
            src[page_number]
        ):
            return pdf_bytes, None
        # Whether the reader will SEE a different typeface -- which is not
        # the same question as whether the font has a different name.
        #
        # A base-14 face is the case in point: MuPDF draws its Helvetica with
        # Nimbus Sans, the metrically identical clone every PDF tool uses for
        # exactly this. The names differ, the page does not, and warning
        # somebody that their Helvetica CV is "in a close match" would be
        # alarming them about nothing. So a face we chose deliberately,
        # having measured it against the page, is not a substitution.
        substituted = (not standard_face) and drawn_as.split("+")[-1].split("-")[
            0
        ].lower() not in style["font"].split("+")[-1].lower()

        out = _rebuilt(src, page_number, rect, line_height)
        page = out[page_number]

        # The new line sits on the baseline one line below the anchor's, at
        # the same left edge -- so a continued skills row lines up under the
        # row it continues rather than under its label.
        baseline = style["origin"][1] + line_height
        writer = fitz.TextWriter(page.rect)
        x = rect.x0
        for word in text.split(" "):
            if word:
                writer.append((x, baseline), word, font=font, fontsize=size)
            x += font.text_length(word + " ", fontsize=size)
        writer.write_text(page, color=style["color"])

        return out.tobytes(garbage=4, deflate=True), Insertion(
            text, page_number, anchor, font_substituted=substituted
        )
    finally:
        src.close()


def _find_anchor(doc, anchor: str):
    """The single-line occurrence of `anchor`, with its style."""
    for page in doc:
        try:
            hits = page.search_for(anchor)
        except Exception:
            continue
        for rect in hits:
            style = _style_at(page, rect)
            if style is not None and rect.height <= style["size"] * 1.8:
                return page.number, rect, style
    return None


def _rebuilt(src, page_number: int, rect: fitz.Rect, line_height: float):
    """A copy of the document with one page split and its lower half moved.

    Every other page is copied across untouched, so a two-page CV stays a
    two-page CV with page one byte-identical.
    """
    # The cut goes into the gap under the anchor line, not through the next
    # line of text: halfway down whatever space follows it.
    split = rect.y1 + 2.0

    out = fitz.open()
    for number in range(src.page_count):
        if number != page_number:
            out.insert_pdf(src, from_page=number, to_page=number)
            continue

        source = src[number]
        width, height = source.rect.width, source.rect.height
        page = out.new_page(width=width, height=height)
        # Above the cut: exactly where it was.
        page.show_pdf_page(
            fitz.Rect(0, 0, width, split), src, number, clip=fitz.Rect(0, 0, width, split)
        )
        # Below it: the same content, one line lower.
        page.show_pdf_page(
            fitz.Rect(0, split + line_height, width, height + line_height),
            src,
            number,
            clip=fitz.Rect(0, split, width, height),
        )
    return out
