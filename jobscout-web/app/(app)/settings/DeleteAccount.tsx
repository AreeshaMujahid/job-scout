"use client";

import { useActionState, useState } from "react";

import { deleteAccount, type DeleteState } from "@/app/actions/account";
import { SubmitButton } from "@/components/SubmitButton";

const initialState: DeleteState = { status: "idle", message: "" };

/**
 * Two steps on purpose. The first click only reveals the form; deleting still
 * requires typing the address, so this cannot happen by mis-clicking once.
 */
export function DeleteAccount({ email }: { email: string }) {
  const [state, formAction] = useActionState(deleteAccount, initialState);
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button type="button" onClick={() => setArmed(true)} className="btn-danger mt-5">
        Delete my account
      </button>
    );
  }

  return (
    <form action={formAction} className="mt-5">
      <label htmlFor="confirm" className="block text-sm font-semibold text-ink">
        Type <span className="font-mono">{email}</span> to confirm
      </label>
      <input
        id="confirm"
        name="confirm"
        autoComplete="off"
        autoFocus
        placeholder={email}
        className="field mt-2 bg-surface"
      />

      {state.status === "error" && (
        <p className="mt-3 text-sm font-medium text-danger">{state.message}</p>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        <SubmitButton pendingText="Deleting..." className="btn-danger">
          Delete everything, permanently
        </SubmitButton>
        <button type="button" onClick={() => setArmed(false)} className="btn-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}
