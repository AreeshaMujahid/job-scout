"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { signInWithPassword, type AuthState } from "@/app/actions/password";
import { PasswordField } from "@/components/auth/PasswordField";
import { SubmitButton } from "@/components/SubmitButton";
import { SignInForm } from "./SignInForm";

const initialState: AuthState = { status: "idle", message: "" };

/**
 * Password sign-in, with the emailed link kept as a way through.
 *
 * The link is not a lesser option hidden in a corner: it is what gets someone
 * in when they have forgotten the password, when the account predates
 * passwords entirely, or when they are locked out after too many attempts.
 * Every one of those messages points here, so it has to be one click away.
 */
export function PasswordSignInForm() {
  const [state, formAction] = useActionState(signInWithPassword, initialState);
  const [useLink, setUseLink] = useState(false);

  if (useLink) {
    return (
      <div>
        <SignInForm />
        <button
          type="button"
          onClick={() => setUseLink(false)}
          className="mt-4 text-sm text-ink-soft hover:underline"
        >
          Use my password instead
        </button>
      </div>
    );
  }

  return (
    <div>
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

        <PasswordField autoComplete="current-password" />

        {state.status === "error" && (
          <p role="alert" className="text-sm text-danger">
            {state.message}
          </p>
        )}

        <SubmitButton pendingText="Signing in..." className="btn-primary w-full">
          Sign in
        </SubmitButton>
      </form>

      <div className="mt-4 flex items-center justify-between text-sm">
        <Link href="/forgot-password" className="text-ink-soft hover:underline">
          Forgot your password?
        </Link>
        <button
          type="button"
          onClick={() => setUseLink(true)}
          className="text-ink-soft hover:underline"
        >
          Email me a link instead
        </button>
      </div>
    </div>
  );
}
