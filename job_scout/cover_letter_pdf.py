"""Render a generated cover letter as a real PDF, in bytes.

A sibling of the repo-root cover_letter_pdf.py (the single-user auto-apply
bot's version), not a wrapper around it. That one is styled to match one
specific person's CV -- Calibri sampled from Areesha_Mujahid_AI.pdf, a blue
pulled from its header -- which is right for a tool with one user and wrong
here: job_scout has accounts, and a stranger's letter should not carry
someone else's personal branding.

This version uses only PyMuPDF's built-in base14 fonts (no font file to find
or ship, so it renders identically on any machine including a Linux
deployment) and the product's own brand blue (jobscout-web's --color-brand),
and returns bytes rather than writing to disk -- one request, one response,
nothing left behind for the next user to trip over.
"""
from __future__ import annotations

import re
import unicodedata
from datetime import date
from typing import Optional

import fitz

# jobscout-web's own --color-brand (app/globals.css), not a personal one.
ACCENT = (0x1E / 255, 0x3A / 255, 0x8A / 255)
INK = (0.13, 0.13, 0.13)
MUTED = (0.35, 0.35, 0.35)

# A4.
PAGE_W, PAGE_H = 595.0, 842.0
LEFT, RIGHT = 56.0, 539.0
TOP, BOTTOM = 64.0, 780.0

F, FB = "helv", "hebo"  # PyMuPDF's built-in base14 Helvetica pair.


# PyMuPDF's base14 "helv"/"hebo" are not embedded font files -- deliberately,
# for portability (see the module docstring) -- and their built-in encoding
# has no glyph for a curly quote or an em dash. A missing glyph does not
# raise or warn; it silently renders as "?", so a real letter went out
# reading "Tchibo Coffee Service?s commitment?ranging from A to B?directly
# aligns" where the model had written a perfectly normal apostrophe and two
# em dashes. Model output routinely uses this punctuation, so it is mapped
# to a plain-ASCII equivalent before rendering rather than left to become a
# question mark. Any character left over after that (an emoji, a CJK name)
# is transliterated to its closest ASCII form -- a name degrading to its
# unaccented spelling is a far smaller defect than a stray "?" sitting in
# the middle of a sent application.
_TYPOGRAPHIC_TO_ASCII = str.maketrans(
    {
        "‘": "'", "’": "'",  # single quotes
        "“": '"', "”": '"',  # double quotes
        "–": "-", "—": " - ",  # en dash, em dash
        "…": "...",  # ellipsis
        " ": " ",  # non-breaking space
    }
)


def _to_renderable_ascii(text: str) -> str:
    text = text.translate(_TYPOGRAPHIC_TO_ASCII)
    # NFKD splits an accented character into base letter + combining mark
    # (e.g. "é" -> "e" + "´"), so encoding to ASCII and dropping what does
    # not fit keeps the base letter instead of losing the character outright.
    decomposed = unicodedata.normalize("NFKD", text)
    return decomposed.encode("ascii", errors="ignore").decode("ascii")


def _clean(text: str) -> str:
    """Undo escaping that can survive a JSON round-trip, tidy spacing, and
    make every character safe for the base14 font actually rendering it."""
    text = text.replace("\\n", "\n").replace("\r\n", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = _to_renderable_ascii(text)
    return text.strip()


def render_cover_letter_pdf(
    letter: str,
    *,
    job_title: str = "",
    company: str = "",
    candidate_name: str = "",
    candidate_email: str = "",
) -> bytes:
    """The letter, laid out as a real document. Raises ValueError on an
    empty letter rather than silently returning a blank PDF."""
    body = _clean(letter)
    if not body:
        raise ValueError("refusing to render an empty cover letter")

    doc = fitz.open()
    page = doc.new_page(width=PAGE_W, height=PAGE_H)

    # Same font, same missing-glyph risk -- a company name or the applicant's
    # own name can carry an accent or a curly character just as easily as
    # the model's prose can.
    name = _to_renderable_ascii(candidate_name.strip())
    email = candidate_email.strip()
    company = _to_renderable_ascii(company.strip())
    job_title = _to_renderable_ascii(job_title.strip())

    y = TOP
    if name:
        page.insert_text((LEFT, y), name, fontname=FB, fontsize=18, color=ACCENT)
        y += 18
    if email:
        page.insert_text((LEFT, y), email, fontname=F, fontsize=9.5, color=MUTED)
        y += 12
    page.draw_line(fitz.Point(LEFT, y), fitz.Point(RIGHT, y), color=ACCENT, width=1.1)
    y += 26

    # Right-aligned date.
    today = date.today().strftime("%d %B %Y")
    today_w = fitz.Font(fontname=F).text_length(today, fontsize=10)
    page.insert_text((RIGHT - today_w, y), today, fontname=F, fontsize=10, color=INK)
    y += 24

    if company:
        page.insert_text((LEFT, y), company, fontname=F, fontsize=10.5, color=INK)
        y += 26

    subject = f"Application for {job_title}" if job_title else "Application"
    page.insert_text((LEFT, y), subject, fontname=FB, fontsize=11.5, color=ACCENT)
    y += 22

    # Flow the body, continuing onto further pages if it does not fit.
    remaining = body
    while remaining:
        box = fitz.Rect(LEFT, y, RIGHT, BOTTOM)
        overflow = page.insert_textbox(
            box, remaining, fontname=F, fontsize=10.5, color=INK,
            align=fitz.TEXT_ALIGN_LEFT, lineheight=1.35,
        )
        if overflow >= 0:
            break  # it all fitted
        fitted = _fitted_prefix(remaining, box)
        remaining = remaining[len(fitted):].lstrip()
        if not remaining:
            break
        page = doc.new_page(width=PAGE_W, height=PAGE_H)
        y = TOP

    pdf_bytes = doc.tobytes(garbage=4, deflate=True)
    doc.close()
    return pdf_bytes


def _fitted_prefix(text: str, box: fitz.Rect) -> str:
    """How much of `text` fits in `box` -- found by bisection on a scratch
    page, then trimmed back to a paragraph or word boundary."""
    lo, hi, best = 0, len(text), ""
    while lo <= hi:
        mid = (lo + hi) // 2
        scratch = fitz.open()
        pg = scratch.new_page(width=PAGE_W, height=PAGE_H)
        ok = pg.insert_textbox(box, text[:mid], fontname=F, fontsize=10.5, lineheight=1.35) >= 0
        scratch.close()
        if ok:
            best = text[:mid]
            lo = mid + 1
        else:
            hi = mid - 1
    for sep in ("\n\n", "\n", " "):
        idx = best.rfind(sep)
        if idx > len(best) * 0.5:
            return best[:idx]
    return best
