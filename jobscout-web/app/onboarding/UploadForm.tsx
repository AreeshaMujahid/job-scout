"use client";

import { useActionState, useState } from "react";

import { uploadCv, type UploadState } from "@/app/actions/onboarding";
import { SubmitButton } from "@/components/SubmitButton";

const initialState: UploadState = { status: "idle", message: "" };

export function UploadForm() {
  const [state, formAction] = useActionState(uploadCv, initialState);
  const [filename, setFilename] = useState<string | null>(null);

  return (
    <form action={formAction} className="mt-8 space-y-5">
      <div>
        <label htmlFor="cv" className="label">
          CV file
        </label>
        <input
          id="cv"
          name="cv"
          type="file"
          required
          accept=".pdf,.docx,.txt,.md"
          onChange={(event) => setFilename(event.target.files?.[0]?.name ?? null)}
          className="mt-2 block w-full cursor-pointer rounded-lg border border-dashed border-line
                     bg-surface px-4 py-8 text-sm text-ink-soft
                     file:mr-4 file:rounded-lg file:border-0 file:bg-brand file:px-4 file:py-2
                     file:text-sm file:font-semibold file:text-white hover:file:bg-brand-hover"
        />
        <p className="hint">
          {filename ? `Selected: ${filename}` : "PDF, Word, plain text or Markdown."}
        </p>
      </div>

      {state.status === "error" && (
        <p className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
          {state.message}
        </p>
      )}

      <SubmitButton pendingText="Reading your CV..." className="btn-primary w-full">
        Read my CV
      </SubmitButton>

      <p className="text-center text-xs text-ink-faint">
        This takes about twenty seconds.
      </p>
    </form>
  );
}
