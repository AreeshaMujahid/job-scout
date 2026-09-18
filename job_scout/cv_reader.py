"""Turn an uploaded CV into plain text.

PDF, DOCX, TXT and Markdown, with no dependency beyond PyMuPDF -- DOCX is a
zip of XML, so unpacking it directly is less code than another install.
"""
from __future__ import annotations

import io
import re
import zipfile
from pathlib import Path

SUPPORTED = (".pdf", ".docx", ".txt", ".md")


class UnreadableCV(ValueError):
    """The file could not be turned into text worth sending to a model."""


def read_cv(data: bytes, filename: str) -> str:
    suffix = Path(filename).suffix.lower()

    if suffix == ".pdf":
        text = _from_pdf(data)
    elif suffix == ".docx":
        text = _from_docx(data)
    elif suffix in (".txt", ".md"):
        text = data.decode("utf-8", errors="replace")
    elif suffix == ".doc":
        raise UnreadableCV(
            "Old .doc format is not supported. Save it as PDF or .docx and try again."
        )
    else:
        raise UnreadableCV(f"Unsupported file type {suffix!r}. Use one of: {', '.join(SUPPORTED)}")

    text = _tidy(text)
    if len(text) < 120:
        raise UnreadableCV(
            "Almost no text came out of that file. If it is a scanned or "
            "image-only CV, export a text-based PDF and try again."
        )
    return text


def read_cv_path(path: str | Path) -> str:
    path = Path(path)
    if not path.is_file():
        raise UnreadableCV(f"No such file: {path}")
    return read_cv(path.read_bytes(), path.name)


def _from_pdf(data: bytes) -> str:
    import fitz  # PyMuPDF

    with fitz.open(stream=io.BytesIO(data), filetype="pdf") as doc:
        return "\n".join(page.get_text() for page in doc)


def _from_docx(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            xml = archive.read("word/document.xml").decode("utf-8", errors="replace")
    except (zipfile.BadZipFile, KeyError) as exc:
        raise UnreadableCV("That .docx file could not be opened.") from exc

    # Paragraph and line breaks first, so words do not run together once the
    # remaining tags are dropped.
    xml = re.sub(r"</w:p>", "\n", xml)
    xml = re.sub(r"<w:br[^>]*/>", "\n", xml)
    xml = re.sub(r"<[^>]+>", "", xml)
    return (
        xml.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&apos;", "'")
    )


def _tidy(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\xa0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
