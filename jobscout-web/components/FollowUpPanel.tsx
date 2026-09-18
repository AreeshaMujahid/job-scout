"use client";

import { useState, useTransition } from "react";

import { generateFollowUpAction } from "@/app/actions/followUp";
import { FOLLOW_UP_AFTER_DAYS } from "@/lib/score";

/**
 * The nudge for an application that has gone quiet, and the draft that
 * answers it.
 *
 * Only rendered for jobs marked "applied" -- see the job page. The panel
 * says nothing until the application is actually old enough, because a
 * "follow up?" prompt on something sent yesterday is advice to do the wrong
 * thing, and a panel that always shouts stops being read.
 */
export function FollowUpPanel({
  jobId,
  company,
  daysSinceApplied,
  initialSubject,
  initialBody,
}: {
  jobId: string;
  company: string;
  daysSinceApplied: number;
  initialSubject: string;
  initialBody: string;
}) {
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  const hasDraft = body.trim().length > 0;
  const due = daysSinceApplied >= FOLLOW_UP_AFTER_DAYS;

  // Nothing to say yet: not old enough to chase, and nothing drafted before.
  if (!due && !hasDraft) return null;

  function generate() {
    setError("");
    setCopied(false);
    startTransition(async () => {
      const result = await generateFollowUpAction(jobId);
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      if (result.status === "ok") {
        setSubject(result.subject);
        setBody(result.body);
      }
    });
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
      setCopied(true);
    } catch {
      setError("Could not copy automatically — select the text and copy it manually.");
    }
  }

  return (
    <section className="card mt-6 border-l-4 border-l-stretch p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">
            {hasDraft ? "Follow-up e-mail" : `No reply in ${daysSinceApplied} days`}
          </h2>
          <p className="hint">
            {hasDraft
              ? `Drafted for ${company}. Read it before you send it.`
              : `You applied ${daysSinceApplied} days ago and ${company} has not replied. A short nudge asking about the timeline is normal and often works.`}
          </p>
        </div>
        <button type="button" disabled={pending} onClick={generate} className="btn-secondary shrink-0">
          {pending ? "Writing…" : hasDraft ? "Rewrite" : "Draft a follow-up"}
        </button>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {hasDraft && (
        <>
          <div className="mt-4">
            <label className="label" htmlFor="follow-up-subject">
              Subject
            </label>
            <input
              id="follow-up-subject"
              readOnly
              value={subject}
              className="field mt-1"
              onFocus={(event) => event.currentTarget.select()}
            />
          </div>

          <textarea
            readOnly
            value={body}
            rows={10}
            aria-label="Follow-up e-mail body"
            className="field mt-3 font-normal leading-relaxed"
            onFocus={(event) => event.currentTarget.select()}
          />

          <div className="mt-3 flex items-center gap-3">
            <button type="button" onClick={copy} className="btn-secondary">
              Copy e-mail
            </button>
            {copied && <span className="text-sm text-ink-faint">Copied.</span>}
          </div>
        </>
      )}
    </section>
  );
}
