"use client";

import Link from "next/link";
import { useActionState } from "react";

import { signUpAction, type AuthState } from "@/app/actions/password";
import { DevLink } from "@/components/auth/DevLink";
import { PasswordField } from "@/components/auth/PasswordField";
import { SubmitButton } from "@/components/SubmitButton";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";

const initialState: AuthState = { status: "idle", message: "" };

export function SignUpForm() {
  const [state, formAction] = useActionState(signUpAction, initialState);

  // Deliberately the same screen whether the address was new or already had
  // an account -- the server answers identically, and a different screen here
  // would give away what the server took care not to say.
  if (state.status === "ok") {
    return (
      <div className="card mt-8 p-6">
        <h2 className="text-lg font-semibold">Check your email</h2>
        <p className="hint mt-2">{state.message}</p>
        {state.devLink && <DevLink href={state.devLink} what="confirmation link" />}
        <p className="hint mt-4">
          Nothing arrived? It can take a minute, and it may be in spam.{" "}
          <Link href="/signin" className="font-medium text-brand hover:underline">
            Sign in
          </Link>{" "}
          once you have confirmed.
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

      <PasswordField
        autoComplete="new-password"
        hint={`At least ${MIN_PASSWORD_LENGTH} characters. Length matters more than symbols — a short phrase you will remember beats P@ssw0rd.`}
      />

      {state.status === "error" && (
        <p role="alert" className="text-sm text-danger">
          {state.message}
        </p>
      )}

      <SubmitButton pendingText="Creating your account..." className="btn-primary w-full">
        Create account
      </SubmitButton>
    </form>
  );
}
