/**
 * The link that would have been emailed, shown on screen.
 *
 * Development only, and not by this component's choice: the server action
 * sets `devLink` only when `canRevealLink()` allows it, which is never in
 * production. Printing a working sign-in or reset link to whoever typed an
 * address into a form would hand them the account.
 */
export function DevLink({ href, what }: { href: string; what: string }) {
  return (
    <div className="mt-4 rounded-lg border border-line bg-canvas p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Development only
      </p>
      <p className="hint mt-1">
        No SMTP is configured, so the {what} is here instead of in your inbox.
      </p>
      <a
        href={href}
        className="mt-3 inline-block break-all text-sm font-medium text-brand hover:underline"
      >
        {href}
      </a>
    </div>
  );
}
