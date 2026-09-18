import Link from "next/link";

import { applyUpdate, dismissUpdate } from "@/app/actions/inbox";
import { SubmitButton } from "@/components/SubmitButton";
import { STATUS_LABELS, timeAgo } from "@/lib/score";
import type { JobStatus } from "@/lib/db/schema";

type PendingUpdate = {
  id: string;
  jobId: string;
  status: JobStatus;
  previousStatus: string;
  confidence: string;
  evidence: string;
  detectedAt: Date;
  company: string;
  title: string;
};

/**
 * What the inbox found, waiting to be confirmed.
 *
 * The quoted sentence is the point of this component, not decoration. A
 * status label on its own asks the user to trust a classifier about their own
 * job hunt; the sentence that produced it lets them check in two seconds and
 * disagree. So it is shown at full size, verbatim, above the buttons -- never
 * summarised, never behind a "why?" toggle.
 */
export function InboxUpdates({ updates }: { updates: PendingUpdate[] }) {
  if (updates.length === 0) return null;

  return (
    <section className="card mt-8 p-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-semibold">
          From your inbox
          <span className="hint ml-2 font-normal">
            {updates.length} {updates.length === 1 ? "update" : "updates"} to confirm
          </span>
        </h2>
      </div>

      <ul className="mt-4 space-y-4">
        {updates.map((update) => (
          <li key={update.id} className="rounded-lg border border-line p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Link href={`/jobs/${update.jobId}`} className="font-medium hover:underline">
                {update.title}
                <span className="text-ink-soft"> · {update.company}</span>
              </Link>
              <span className="hint">{timeAgo(update.detectedAt)}</span>
            </div>

            <p className="mt-2 text-sm">
              <span className="text-ink-soft">
                {STATUS_LABELS[update.previousStatus as JobStatus] ?? update.previousStatus}
              </span>
              <span aria-hidden className="text-ink-soft"> → </span>
              <span className="font-semibold">{STATUS_LABELS[update.status]}</span>
              {update.confidence !== "high" && (
                <span className="hint ml-2">· not certain, worth a look</span>
              )}
            </p>

            <blockquote className="mt-3 border-l-2 border-line pl-3 text-sm text-ink-soft italic">
              {update.evidence}
            </blockquote>

            <div className="mt-4 flex gap-2">
              {/* Two forms rather than one with named submit buttons: each
                  action is bound to its own id, so there is no path where a
                  mis-parsed form field applies what the user meant to dismiss. */}
              <form
                action={async () => {
                  "use server";
                  await applyUpdate(update.id);
                }}
              >
                <SubmitButton pendingText="Updating" className="btn-primary text-sm">
                  Yes, update it
                </SubmitButton>
              </form>
              <form
                action={async () => {
                  "use server";
                  await dismissUpdate(update.id);
                }}
              >
                <SubmitButton pendingText="Dismissing" className="btn-secondary text-sm">
                  Ignore
                </SubmitButton>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
