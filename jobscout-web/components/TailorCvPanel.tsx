"use client";

import { useState, useTransition } from "react";

import { tailorCvAction } from "@/app/actions/tailorCv";
import type { CVKeywordEdit, SkippedEdit } from "@/lib/scout";

/**
 * Generated on request, same reasoning as CoverLetterPanel: working out the
 * swaps is a real model call, and most jobs on a feed get looked at, not
 * applied to. Nothing here calls the model until the button is pressed.
 *
 * The two-step shape is the point. A skill missing from a CV can mean the
 * candidate lacks it OR that they never wrote it down, and nothing can tell
 * those apart by reading the document. So the gaps are shown as a question
 * with nothing pre-ticked, and only what the user confirms goes in.
 */
export function TailorCvPanel({
  jobId,
  hasPdfCv,
  initialEdits,
  initialMissing,
  initialRequired,
}: {
  jobId: string;
  hasPdfCv: boolean;
  initialEdits: CVKeywordEdit[];
  initialMissing: string[];
  initialRequired: string[];
}) {
  const [edits, setEdits] = useState(initialEdits);
  const [missing, setMissing] = useState(initialMissing);
  const [skipped, setSkipped] = useState<SkippedEdit[]>([]);
  const [inserted, setInserted] = useState<CVKeywordEdit[]>([]);
  const [substituted, setSubstituted] = useState<CVKeywordEdit[]>([]);
  const [warning, setWarning] = useState("");
  const [required, setRequired] = useState(initialRequired);
  const [ticked, setTicked] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  function run(extraSkills: string[]) {
    setError("");
    startTransition(async () => {
      const result = await tailorCvAction(jobId, extraSkills.join(", "), required);
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      if (result.status === "ok") {
        setEdits(result.edits);
        setMissing(result.missingSkills);
        setSkipped(result.skipped);
        setInserted(result.inserted);
        setSubstituted(result.fontSubstituted);
        setWarning(result.warning);
        setRequired(result.requiredSkills);
        setConfirmed(extraSkills);
        setTicked([]);
      }
    });
  }

  function toggle(skill: string) {
    setTicked((current) =>
      current.includes(skill) ? current.filter((s) => s !== skill) : [...current, skill],
    );
  }

  return (
    <section className="card mt-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Tailor your CV</h2>
          <p className="hint">
            Your own CV file with a few words swapped for this posting&rsquo;s — same photo, same
            layout, same fonts. Nothing else is touched.
          </p>
        </div>
        {hasPdfCv && (
          <button
            type="button"
            disabled={pending}
            onClick={() => run([])}
            className="btn-secondary shrink-0"
          >
            {pending ? "Working…" : edits.length || missing.length ? "Start over" : "Generate"}
          </button>
        )}
      </div>

      {!hasPdfCv && (
        <p className="mt-3 rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink-soft">
          This edits your original PDF in place, so it needs a PDF CV on file. Re-upload your CV as a
          PDF to use it.
        </p>
      )}

      {warning && (
        <p className="mt-3 rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink-soft">
          {warning}
        </p>
      )}

      {error && (
        <p className="mt-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {missing.length > 0 && (
        <div className="mt-6 border-t border-line pt-5">
          <h3 className="text-sm font-semibold">
            This job asks for these, and your CV does not show them
          </h3>
          <p className="hint">
            Tick anything you actually have and could talk through in an interview — it will be added
            to your skills. Leave the rest; they stay off your CV.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {missing.map((skill) => (
              <label key={skill} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={ticked.includes(skill)}
                  onChange={() => toggle(skill)}
                  className="h-4 w-4"
                />
                <span>{skill}</span>
              </label>
            ))}
          </div>
          {ticked.length > 0 && (
            <button
              type="button"
              disabled={pending}
              onClick={() => run([...confirmed, ...ticked])}
              className="btn-primary mt-4"
            >
              {pending ? "Adding…" : `Add ${ticked.length} to my CV`}
            </button>
          )}
        </div>
      )}

      {/* "Added because you confirmed" was printed whether or not anything
          went in -- it once sat above an empty result, claiming six tools had
          been added to a CV they never reached. Confirming a skill and
          fitting it on a line are two different things, so this says only
          what it knows. */}
      {confirmed.length > 0 && (
        <p className="hint mt-4">
          You confirmed: {confirmed.join(", ")}. What fitted is listed below.
        </p>
      )}

      {edits.length > 0 && (
        <>
          <h3 className="mt-6 text-sm font-semibold">Changes to your CV</h3>
          <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-soft">
            {edits.map((edit) => (
              <li key={edit.find} className="flex flex-wrap items-baseline gap-2">
                <span className="chip">{edit.find}</span>
                <span aria-hidden className="text-ink-faint">
                  →
                </span>
                <span className="chip border-strong/30 bg-strong/10 text-strong">{edit.replace}</span>
                {edit.reason && <span className="text-ink-faint">{edit.reason}</span>}
              </li>
            ))}
          </ul>
          <div className="mt-4">
            {/* A plain link, not a button + fetch: the browser follows the
                Content-Disposition header from the route handler and shows
                its own "Save As" dialog. */}
            <a href={`/jobs/${jobId}/tailored-cv`} download className="btn-primary">
              Download my CV, tailored
            </a>
          </div>
          <p className="hint mt-3">
            Every change listed above is in the file — each one was applied to a copy of your CV
            before being shown here.
          </p>
          {inserted.length > 0 && (
            <p className="hint mt-2">
              {inserted.length === 1 ? "One of them" : `${inserted.length} of them`} would not fit
              on its line, so {inserted.length === 1 ? "it was" : "they were"} added on a new line
              underneath. Everything below moved down by a line; nothing was re-typeset.
              {substituted.length > 0 &&
                " Your CV's own font could not be re-used for that line, so it is set in a close" +
                  " match — worth a look before you send it."}
            </p>
          )}
        </>
      )}

      {skipped.length > 0 && (
        <div className="mt-6 border-t border-line pt-5">
          <h3 className="text-sm font-semibold">Could not be changed</h3>
          <p className="hint">
            The rest of each line cannot move without pulling your dates out of alignment, so an edit
            that will not fit is left alone rather than forced.
          </p>
          <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-faint">
            {skipped.map((edit) => (
              <li key={edit.find}>
                <span className="chip">{edit.find}</span> — {edit.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasPdfCv && !pending && edits.length === 0 && missing.length === 0 && (
        <p className="hint mt-3">Not generated yet.</p>
      )}
    </section>
  );
}
