"use client";

import Link from "next/link";
import { useActionState } from "react";

import { resetPasswordAction, type AuthState } from "@/app/actions/password";
import { PasswordField } from "@/components/auth/PasswordField";
import { SubmitButton } from "@/components/SubmitButton";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";

const initialState: AuthState = { status: "idle", message: "" };

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, formAction] = useActionState(resetPasswordAction, initialState);

  return (
    <form action={formAction} className="mt-8 space-y-4">
      <input type="hidden" name="token" value={token} />

      <PasswordField
        name="password"
        label="New password"
        autoComplete="new-password"
        autoFocus
        hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
      />

      {state.status === "error" && (
        <>
          <p role="alert" className="text-sm text-danger">
            {state.message}
          </p>
          <p className="hint">
            <Link href="/forgot-password" className="font-medium text-brand hover:underline">
              Ask for a new link
            </Link>
          </p>
        </>
      )}

      <SubmitButton pendingText="Saving..." className="btn-primary w-full">
        Set my password
      </SubmitButton>
    </form>
  );
}
