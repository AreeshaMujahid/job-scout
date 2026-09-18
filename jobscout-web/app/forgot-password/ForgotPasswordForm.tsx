"use client";

import Link from "next/link";
import { useActionState } from "react";

import { requestPasswordReset, type AuthState } from "@/app/actions/password";
import { DevLink } from "@/components/auth/DevLink";
import { SubmitButton } from "@/components/SubmitButton";

const initialState: AuthState = { status: "idle", message: "" };

export function ForgotPasswordForm() {
  const [state, formAction] = useActionState(requestPasswordReset, initialState);

  // Shown for any valid address, whether or not it has an account. The
  // wording says "if it has an account" rather than "we sent it" because
  // the second would be a lie half the time -- and a true "no account with
  // that email" would let anyone test addresses against the user table.
  if (state.status === "ok") {
    return (
      <div className="card mt-8 p-6">
        <h2 className="text-lg font-semibold">Check your email</h2>
        <p className="hint mt-2">{state.message}</p>
        {state.devLink && <DevLink href={state.devLink} what="reset link" />}
        <p className="hint mt-4">
          The link works once and expires in 15 minutes.{" "}
          <Link href="/signin" className="font-medium text-brand hover:underline">
            Back to sign in
          </Link>
        </p>
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
          // React clears an uncontrolled form once the action resolves, so
          // without this a rejected password also wipes the address and asks
          // the user to type it again for no reason.
          defaultValue={state.email ?? ""}
        />
      </div>

      {state.status === "error" && (
        <p role="alert" className="text-sm text-danger">
          {state.message}
        </p>
      )}

      <SubmitButton pendingText="Sending..." className="btn-primary w-full">
        Send me a reset link
      </SubmitButton>
    </form>
  );
}
