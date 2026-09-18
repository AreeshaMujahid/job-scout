"use client";

import { useState, useTransition } from "react";

import { draftOutreachAction } from "@/app/actions/referrals";
import type { ReferralContact } from "@/lib/scout";

/**
 * One person, with the option to draft a message to them.
 *
 * The draft is generated on request and never sent: a message going out
 * under someone's own name to a stranger they may end up working with is
 * theirs to read and press send on. It is not stored either -- a draft for
 * one stranger about one job is a throwaway, and keeping it would mean
 * holding their name in the database alongside it.
 */
export function ContactRow({
  jobId,
  contact,
  muted = false,
}: {
  jobId: string;
  contact: ReferralContact;
  muted?: boolean;
}) {
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [pending, startTransition] = useTransition();

  const drafted = note.trim().length > 0 || message.trim().length > 0;

  function draft() {
    setError("");
    setCopied("");
    startTransition(async () => {
      const result = await draftOutreachAction(jobId, contact.name, contact.headline);
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      if (result.status === "ok") {
        setNote(result.note);
        setMessage(result.message);
      }
    });
  }

  async function copy(text: string, which: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
    } catch {
      setError("Could not copy automatically — select the text and copy it manually.");
    }
  }

  return (
    <li className="py-3">
      <div className="flex items-center gap-3">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ${muted ? "bg-canvas text-ink-soft" : "bg-brand-soft text-brand"}`}
          aria-hidden="true"
        >
          {contact.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <a
            href={contact.profile_url}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate font-medium hover:text-brand hover:underline"
          >
            {contact.name}
          </a>
          {contact.headline && (
            <p className="truncate text-sm text-ink-soft">{contact.headline}</p>
          )}
        </div>
        {contact.degree && <span className="chip shrink-0">{contact.degree}</span>}
        <button
          type="button"
          disabled={pending}
          onClick={draft}
          className="btn-secondary shrink-0 text-xs"
        >
          {pending ? "Writing…" : drafted ? "Rewrite" : "Draft message"}
        </button>
      </div>

      {error && (
        <p className="mt-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {drafted && (
        <div className="mt-3 space-y-3 rounded-lg border border-line bg-canvas p-3">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold">
                Connection request note ({note.length}/300)
              </span>
              <button
                type="button"
                onClick={() => copy(note, "note")}
                className="text-xs font-semibold text-brand hover:underline"
              >
                {copied === "note" ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="mt-1 text-sm leading-relaxed text-ink-soft">{note}</p>
          </div>

          <div className="border-t border-line pt-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold">Message, once they accept</span>
              <button
                type="button"
                onClick={() => copy(message, "message")}
                className="text-xs font-semibold text-brand hover:underline"
              >
                {copied === "message" ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
              {message}
            </p>
          </div>

          <p className="text-xs text-ink-faint">
            Read it before you send it. Nothing is sent for you.
          </p>
        </div>
      )}
    </li>
  );
}
