"use client";

import { useState, useTransition } from "react";

import { saveNote } from "@/app/actions/tracker";

/** Somewhere to put "spoke to Anna in the Berlin office, follow up Tuesday". */
export function NoteBox({ jobId, initialNote }: { jobId: string; initialNote: string }) {
  const [note, setNote] = useState(initialNote);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const dirty = note !== initialNote;

  return (
    <section className="card mt-6 p-6">
      <label htmlFor="note" className="text-sm font-semibold">
        Your notes
      </label>
      <p className="hint">Only you can see this. Saving a note also adds the job to your tracker.</p>

      <textarea
        id="note"
        rows={3}
        value={note}
        onChange={(event) => {
          setNote(event.target.value);
          setSaved(false);
        }}
        placeholder="Referred by Anna. Follow up if nothing by Friday."
        className="field mt-3"
      />

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={pending || !dirty}
          onClick={() =>
            startTransition(async () => {
              await saveNote(jobId, note);
              setSaved(true);
            })
          }
          className="btn-secondary"
        >
          {pending ? "Saving..." : "Save note"}
        </button>
        {saved && <span className="text-sm text-ink-faint">Saved.</span>}
      </div>
    </section>
  );
}
