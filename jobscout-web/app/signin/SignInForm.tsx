"use client";

import { useActionState, useState } from "react";

import { requestMagicLink, type SignInState } from "@/app/actions/auth";
import { SubmitButton } from "@/components/SubmitButton";

const initialState: SignInState = { status: "idle", message: "" };

export function SignInForm() {
  const [state, formAction] = useActionState(requestMagicLink, initialState);
  // Lets someone who mistyped their address get the form back without
  // submitting an empty one and being told off for it.
  const [startOver, setStartOver] = useState(false);

  if (state.status === "sent" && !startOver) {
    return (
      <div className="mt-8">
        <div className="card p-6">
          <h2 className="text-lg font-semibold">Check your email</h2>
          <p className="hint mt-2">{state.message}</p>

          {state.devLink && (
            <div className="mt-4 rounded-lg border border-line bg-canvas p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Development only
              </p>
              <p className="hint mt-1">
                No SMTP is configured, so the link is here instead of in your inbox.
              </p>
              <a
                href={state.devLink}
                className="mt-3 inline-block break-all text-sm font-medium text-brand hover:underline"
              >
                {state.devLink}
              </a>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setStartOver(true)}
          className="mt-4 text-sm text-ink-soft hover:underline"
        >
          Use a different address
        </button>
      </div>
    );
  }

  return (
    <form action={formAction} className="mt-8 space-y-4">
      <div>
        <label htmlFor="email" className="label">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          placeholder="you@example.com"
          className="field mt-2"
          aria-describedby={state.status === "error" ? "email-error" : undefined}
        />
      </div>

      {state.status === "error" && (
        <p id="email-error" className="text-sm text-danger">
          {state.message}
        </p>
      )}

      <SubmitButton pendingText="Sending..." className="btn-primary w-full">
        Email me a link
      </SubmitButton>
    </form>
  );
}
