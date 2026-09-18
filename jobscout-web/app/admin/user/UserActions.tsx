"use client";

import { useState, useTransition } from "react";

import {
  deleteAccount,
  resendVerification,
  sendReset,
  unlockAccount,
  type AdminResult,
} from "./actions";

/**
 * The support buttons.
 *
 * Deleting is kept apart from the other three and asks for the address to be
 * typed. It sits next to buttons that are all safely repeatable -- resending
 * a mail twice costs nothing -- and the one that is not should not be a
 * neighbouring click.
 */
export function UserActions({
  email,
  verified,
  locked,
}: {
  email: string;
  verified: boolean;
  locked: boolean;
}) {
  const [result, setResult] = useState<AdminResult | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<AdminResult>) {
    setResult(null);
    startTransition(async () => setResult(await action()));
  }

  return (
    <section className="card mt-6 p-6">
      <h2 className="font-semibold">Support actions</h2>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending || verified}
          onClick={() => run(() => resendVerification(email))}
          className="btn-secondary text-sm"
          title={verified ? "Already confirmed" : "Send the confirmation email again"}
        >
          Resend confirmation
        </button>

        <button
          type="button"
          disabled={pending || !locked}
          onClick={() => run(() => unlockAccount(email))}
          className="btn-secondary text-sm"
          title={locked ? "Clear the lockout" : "Not locked"}
        >
          Unlock account
        </button>

        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => sendReset(email))}
          className="btn-secondary text-sm"
        >
          Send password reset
        </button>
      </div>

      {result && (
        <div className="mt-4">
          <p className={`text-sm ${result.ok ? "text-ink" : "text-danger"}`}>{result.message}</p>
          {result.devLink && (
            <a
              href={result.devLink}
              className="mt-2 inline-block break-all text-sm font-medium text-brand hover:underline"
            >
              {result.devLink}
            </a>
          )}
        </div>
      )}

      {/* Irreversible ---------------------------------------------------- */}
      <div className="mt-6 rounded-lg border border-danger/30 bg-danger-soft p-4">
        <h3 className="text-sm font-semibold text-danger">Delete this account</h3>
        <p className="mt-1 text-sm text-ink-soft">
          Removes the user, their CV, every score and their whole tracker. Immediate and
          irreversible. Job postings are public listings and stay.
        </p>

        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="btn-danger mt-3 text-sm"
          >
            Delete account
          </button>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder={email}
              aria-label={`Type ${email} to confirm`}
              className="field max-w-xs text-sm"
            />
            <button
              type="button"
              disabled={pending || confirmation.trim().toLowerCase() !== email.toLowerCase()}
              onClick={() => run(() => deleteAccount(email, confirmation))}
              className="btn-danger text-sm"
            >
              {pending ? "Deleting..." : "Delete permanently"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setConfirmation("");
              }}
              className="btn-secondary text-sm"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
