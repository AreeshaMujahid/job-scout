"""Read the applicant's inbox for messages about jobs they applied to.

Read-only, and narrowly so: every call here is users.messages.list or
users.messages.get. Nothing is sent, labelled, modified or deleted, and the
scope requested is gmail.readonly.

Why the whole message body is never returned to the caller: the point is to
move a tracker row, not to mirror somebody's mail into another database. A
message is reduced to sender, subject, date and a trimmed plain-text body
before it leaves this module, and only messages that look job-related in the
first place are read at all.
"""
from __future__ import annotations

import base64
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"

# How much of a message the classifier sees. An outcome ("we will not be
# moving forward", "can you do Tuesday at 14:00") is stated near the top;
# the rest is signature, legal footer and unsubscribe boilerplate.
BODY_CHARS = 1200

_TAG = re.compile(r"<[^>]+>")
_WS = re.compile(r"[ \t\xa0]+")


@dataclass
class InboxMessage:
    """One message, reduced to what a status decision actually needs."""

    message_id: str
    sender: str
    subject: str
    received_at: datetime
    body: str

    def as_prompt_block(self, index: int) -> str:
        stamp = self.received_at.strftime("%Y-%m-%d")
        return (
            f"[{index}] From: {self.sender}\n"
            f"    Date: {stamp}\n"
            f"    Subject: {self.subject}\n"
            f"    Body: {self.body}"
        )


class MailboxUnavailable(RuntimeError):
    """The mailbox cannot be read at all -- dead token, revoked grant, wrong
    scope. Distinct from "nothing matched" on purpose: one is a setup problem
    with a cure, the other is a fact about the inbox."""


def _service():
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    token_path = os.getenv("GMAIL_TOKEN_PATH", "gmail_token.json")
    if not Path(token_path).exists():
        raise MailboxUnavailable(
            f"No Gmail token at {token_path} -- run `python gmail_auth.py` to "
            "authorise before application e-mail can be read."
        )
    creds = Credentials.from_authorized_user_file(token_path, [READONLY_SCOPE])
    return build("gmail", "v1", credentials=creds)


def _is_auth_failure(exc: Exception) -> bool:
    """Will polling again ever fix this, or is it a dead grant?"""
    if type(exc).__name__ in ("RefreshError", "DefaultCredentialsError"):
        return True
    text = str(exc)
    if "invalid_grant" in text or "invalid_client" in text:
        return True
    return getattr(getattr(exc, "resp", None), "status", None) in (401, 403)


def _decode_part(payload: dict, mime_type: str) -> Optional[str]:
    if payload.get("mimeType") == mime_type:
        data = payload.get("body", {}).get("data")
        if data:
            return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode(
                "utf-8", "replace"
            )
    for part in payload.get("parts") or []:
        found = _decode_part(part, mime_type)
        if found:
            return found
    return None


def _body_text(payload: dict) -> str:
    """Plain text if the sender provided it, else HTML with the tags taken
    out. Most ATS mail is multipart with both."""
    text = _decode_part(payload, "text/plain")
    if not text:
        html = _decode_part(payload, "text/html") or ""
        text = _TAG.sub(" ", html)
    text = text.replace("\r\n", "\n")
    text = _WS.sub(" ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()[:BODY_CHARS]


def _header(msg: dict, name: str) -> str:
    for header in msg.get("payload", {}).get("headers", []):
        if header.get("name", "").lower() == name.lower():
            return header.get("value", "")
    return ""


# Gmail's own query language does the first cut, server-side, so the bulk of
# an inbox is never fetched at all. Deliberately broad -- an ATS subject line
# can be almost anything -- with the precision left to the classifier, which
# can actually read. Narrowing here would silently lose real rejections.
JOB_MAIL_QUERY = (
    "("
    "subject:(application OR applied OR bewerbung OR candidacy OR interview OR "
    "position OR role OR vacancy OR recruitment OR hiring OR opportunity) "
    "OR from:(noreply OR no-reply OR careers OR jobs OR recruiting OR talent OR hr)"
    ")"
)


def fetch_job_related(
    *,
    newer_than_days: int = 30,
    max_messages: int = 120,
) -> List[InboxMessage]:
    """Recent messages that plausibly concern a job application.

    `newer_than_days` bounds the work and the exposure: there is no reason to
    read mail older than the applications being tracked. Raises
    MailboxUnavailable when the mailbox cannot be read -- never returns an
    empty list to mean that, because "no updates" and "we could not look" are
    different answers and only one of them is the user's problem to fix.
    """
    service = _service()
    query = f"{JOB_MAIL_QUERY} newer_than:{max(1, newer_than_days)}d"

    try:
        listing = (
            service.users()
            .messages()
            .list(userId="me", q=query, maxResults=min(max_messages, 500))
            .execute()
        )
    except Exception as exc:
        if _is_auth_failure(exc):
            raise MailboxUnavailable(
                f"The Gmail authorisation is no longer valid ({type(exc).__name__}: {exc}). "
                "Renew it with: .venv/Scripts/python.exe gmail_auth.py"
            ) from exc
        raise MailboxUnavailable(f"Could not read the mailbox: {exc}") from exc

    messages: List[InboxMessage] = []
    for item in listing.get("messages", [])[:max_messages]:
        try:
            msg = (
                service.users()
                .messages()
                .get(userId="me", id=item["id"], format="full")
                .execute()
            )
        except Exception as exc:
            if _is_auth_failure(exc):
                raise MailboxUnavailable(
                    f"The Gmail authorisation stopped working mid-read ({exc})."
                ) from exc
            # One unreadable message must not lose the other hundred.
            continue

        received = datetime.fromtimestamp(
            int(msg.get("internalDate", "0")) / 1000.0, tz=timezone.utc
        )
        messages.append(
            InboxMessage(
                message_id=msg.get("id", ""),
                sender=_header(msg, "From"),
                subject=_header(msg, "Subject"),
                received_at=received,
                body=_body_text(msg.get("payload", {})),
            )
        )

    return messages
