import { setInboxEnabled } from "@/app/actions/inbox";
import { SubmitButton } from "@/components/SubmitButton";
import { timeAgo } from "@/lib/score";

/**
 * Setting up, and switching off, inbox tracking.
 *
 * The instructions are the feature here. Forwarding asks the user to do one
 * thing in a mail client we do not control, and a vague "set up forwarding"
 * is where this loses people -- so the address is shown for copying and the
 * filter is spelled out for the two clients most people have.
 */
export function InboxSettings({
  address,
  enabled,
  lastSyncAt,
  lastError,
}: {
  address: string;
  enabled: boolean;
  lastSyncAt: Date | null;
  lastError: string;
}) {
  return (
    <section className="card mt-8 p-6">
      <h2 className="font-semibold">Application e-mail</h2>
      <p className="hint">
        Forward mail about your applications here and the tracker keeps itself up to
        date. You confirm every change before it moves.
      </p>

      <div className="mt-4 rounded-lg border border-line bg-canvas p-3">
        <code className="text-sm break-all select-all">{address}</code>
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-medium">
          How to set up the filter
        </summary>
        <div className="hint mt-3 space-y-3">
          <p>
            <strong className="text-ink">Gmail:</strong> Settings → Filters and Blocked
            Addresses → Create a new filter. Put{" "}
            <code>application OR interview OR recruiter</code> in &ldquo;Has the
            words&rdquo;, then choose &ldquo;Forward it to&rdquo; and add the address
            above. Gmail sends a confirmation link to verify it once.
          </p>
          <p>
            <strong className="text-ink">Outlook:</strong> Settings → Mail → Rules → Add
            new rule, condition &ldquo;Subject or body includes&rdquo;, action
            &ldquo;Forward to&rdquo; the address above.
          </p>
          <p>
            Only what you forward is ever read. We keep the opening of each message for{" "}
            long enough to classify it, then delete it.
          </p>
        </div>
      </details>

      {/* A stored error is a setup problem only the user can fix, so it is
          shown here rather than only logged. */}
      {lastError && (
        <p className="mt-4 rounded-lg border border-line bg-canvas p-3 text-sm">
          <strong>Last sync failed:</strong> {lastError}
        </p>
      )}

      <div className="mt-5 flex items-center justify-between gap-4">
        <p className="hint">
          {enabled
            ? lastSyncAt
              ? `Last checked ${timeAgo(lastSyncAt)}.`
              : "Waiting for the first forwarded message."
            : "Turned off. Forwarded mail is discarded."}
        </p>
        <form
          action={async () => {
            "use server";
            await setInboxEnabled(!enabled);
          }}
        >
          <SubmitButton
            pendingText="Saving"
            className={enabled ? "btn-secondary text-sm" : "btn-primary text-sm"}
          >
            {enabled ? "Turn off" : "Turn on"}
          </SubmitButton>
        </form>
      </div>
    </section>
  );
}
