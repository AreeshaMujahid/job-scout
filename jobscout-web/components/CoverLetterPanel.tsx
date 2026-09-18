"use client";

import { useState, useTransition } from "react";

import { generateCoverLetterAction } from "@/app/actions/coverLetter";

/**
 * Generated on request, not on page load -- writing a letter is a real model
 * call, and most jobs on a feed get looked at, not applied to. The button IS
 * the "generate" the feature is named for; nothing here calls the model
 * until it is pressed.
 */
export function CoverLetterPanel({
  jobId,
  initialLetter,
  initialCvSuggestions,
}: {
  jobId: string;
  initialLetter: string;
  initialCvSuggestions: string[];
}) {
  const [letter, setLetter] = useState(initialLetter);
  const [cvSuggestions, setCvSuggestions] = useState(initialCvSuggestions);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  const hasLetter = letter.trim().length > 0;

  function generate() {
    setError("");
    setCopied(false);
    startTransition(async () => {
      const result = await generateCoverLetterAction(jobId);
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      if (result.status === "ok") {
        setLetter(result.letter);
        setCvSuggestions(result.cvSuggestions);
      }
    });
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(letter);
      setCopied(true);
    } catch {
      // Clipboard access can be denied by the browser; the text is still
      // right there in the box to select and copy by hand.
      setError("Could not copy automatically — select the text and copy it manually.");
    }
  }

  return (
    <section className="card mt-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Cover letter</h2>
          <p className="hint">
            {hasLetter
              ? "Written from your CV and this posting. Read it before you send it."
              : "Written from your CV and this posting — grounded in what your CV actually says, not invented."}
          </p>
        </div>
        <button type="button" disabled={pending} onClick={generate} className="btn-secondary shrink-0">
          {pending ? "Writing…" : hasLetter ? "Regenerate" : "Generate"}
        </button>
      </div>

      {error && (
        <p className="mt-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {hasLetter && (
        <>
          <textarea
            readOnly
            value={letter}
            rows={12}
            className="field mt-4 font-normal leading-relaxed"
            onFocus={(event) => event.currentTarget.select()}
          />
          <div className="mt-3 flex items-center gap-3">
            {/* A plain link, not a button + fetch: the browser follows the
                Content-Disposition header from the route handler and shows
                its own "Save As" dialog, no client JavaScript needed for
                the download itself. */}
            <a href={`/jobs/${jobId}/cover-letter`} download className="btn-primary">
              Download PDF
            </a>
            <button type="button" onClick={copy} className="btn-secondary">
              Copy letter
            </button>
            {copied && <span className="text-sm text-ink-faint">Copied.</span>}
          </div>

          {cvSuggestions.length > 0 && (
            <div className="mt-6 border-t border-line pt-5">
              <h3 className="text-sm font-semibold">
                Add these to your CV so this posting doesn&rsquo;t filter you out
              </h3>
              <p className="hint">
                Real experience your CV already has, worded the way this posting&rsquo;s screen looks for it.
              </p>
              <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-soft">
                {cvSuggestions.map((suggestion) => (
                  <li key={suggestion} className="flex gap-2">
                    <span aria-hidden className="text-brand">
                      +
                    </span>
                    <span>{suggestion}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
