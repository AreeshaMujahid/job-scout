"use client";

import { useFormStatus } from "react-dom";

/**
 * A submit button that disables and renames itself while its form is in
 * flight. Every action here is slow enough (a model call, six job boards)
 * that a button which looks unclicked invites a second click.
 */
export function SubmitButton({
  children,
  pendingText,
  className = "btn-primary",
}: {
  children: React.ReactNode;
  pendingText: string;
  className?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending} className={className} aria-busy={pending}>
      {pending ? (
        <>
          <span
            aria-hidden
            className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          {pendingText}
        </>
      ) : (
        children
      )}
    </button>
  );
}
