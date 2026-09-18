import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";

import { requireUser } from "@/lib/auth/session";
import { InboxUpdates } from "@/components/InboxUpdates";
import { pendingUpdates } from "@/lib/inbox/sync";
import { getDb } from "@/lib/db";
import { jobStatus, jobs, ratings } from "@/lib/db/schema";
import type { JobStatus } from "@/lib/db/schema";
import {
  daysSince,
  FOLLOW_UP_AFTER_DAYS,
  scoreText,
  STATUS_LABELS,
  timeAgo,
  TRACKER_ORDER,
} from "@/lib/score";

export default async function TrackerPage() {
  const user = await requireUser();

  const db = await getDb();
  const rows = await db
    .select({ job: jobs, tracked: jobStatus, score: ratings.score })
    .from(jobStatus)
    .innerJoin(jobs, eq(jobStatus.jobId, jobs.id))
    .leftJoin(ratings, and(eq(ratings.jobId, jobs.id), eq(ratings.userId, user.id)))
    .where(eq(jobStatus.userId, user.id))
    .orderBy(desc(jobStatus.updatedAt));

  const live = rows.filter((row) => row.tracked.status !== "dismissed");
  const byStatus = new Map<JobStatus, typeof live>();
  for (const status of TRACKER_ORDER) {
    byStatus.set(
      status,
      live.filter((row) => row.tracked.status === status),
    );
  }

  // Applied, and nothing has happened since. The one thing on this page a
  // user should act on today, so it is counted before anything is drawn.
  const needsFollowUp = live.filter(
    (row) =>
      row.tracked.status === "applied" &&
      daysSince(row.tracked.updatedAt) >= FOLLOW_UP_AFTER_DAYS,
  );

  const dismissedCount = rows.length - live.length;

  // What arrived by e-mail since the user last looked. Shown above the
  // board because it is the only thing here they have not already seen.
  const updates = await pendingUpdates(user.id);

  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight">Tracker</h1>
      <p className="hint mt-2">
        {live.length > 0
          ? `${live.length} ${live.length === 1 ? "job" : "jobs"} you are doing something about.`
          : "Nothing saved yet."}
      </p>

      <InboxUpdates updates={updates} />

      {live.length === 0 ? (
        <div className="card mt-8 p-10 text-center">
          <h2 className="text-lg font-semibold">Nothing here yet</h2>
          <p className="hint mx-auto mt-2 max-w-md">
            Save a job from{" "}
            <Link href="/feed" className="font-medium text-brand hover:underline">
              your feed
            </Link>{" "}
            and it shows up here, along with anything you mark as applied.
          </p>
        </div>
      ) : (
        <>
          {needsFollowUp.length > 0 && (
            <section className="card mt-8 border-l-4 border-l-stretch p-5">
              <h2 className="font-semibold">
                {needsFollowUp.length}{" "}
                {needsFollowUp.length === 1 ? "application has" : "applications have"} gone quiet
              </h2>
              <p className="hint">
                No reply after {FOLLOW_UP_AFTER_DAYS}+ days. A short nudge asking about the
                timeline is normal, and it is the thing most people never get round to.
              </p>
              <ul className="mt-3 space-y-1.5 text-sm">
                {needsFollowUp.map(({ job, tracked }) => (
                  <li key={job.id}>
                    <Link href={`/jobs/${job.id}`} className="font-medium text-brand hover:underline">
                      {job.title}
                    </Link>
                    <span className="text-ink-soft">
                      {" "}
                      at {job.company} — {daysSince(tracked.updatedAt)} days
                      {tracked.followUpBody ? " · draft ready" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="mt-8 grid gap-4 sm:grid-cols-5">
            {TRACKER_ORDER.map((status) => (
              <div key={status} className="card p-4 text-center">
                <div className="text-2xl font-bold">{byStatus.get(status)?.length ?? 0}</div>
                <div className="mt-1 text-xs font-medium text-ink-soft">
                  {STATUS_LABELS[status]}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-10 space-y-10">
            {TRACKER_ORDER.map((status) => {
              const group = byStatus.get(status) ?? [];
              if (group.length === 0) return null;

              return (
                <section key={status}>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-faint">
                    {STATUS_LABELS[status]} ({group.length})
                  </h2>
                  <div className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                    {group.map(({ job, tracked, score }) => (
                      <div key={job.id} className="flex items-center gap-4 p-4">
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/jobs/${job.id}`}
                            className="truncate font-medium hover:underline"
                          >
                            {job.title}
                          </Link>
                          <p className="truncate text-sm text-ink-soft">
                            {job.company} · {job.location || "location not stated"}
                          </p>
                          {tracked.note && (
                            <p className="mt-1 truncate text-sm italic text-ink-faint">
                              {tracked.note}
                            </p>
                          )}
                        </div>

                        <div className="shrink-0 text-right">
                          {score !== null && (
                            <div className={`font-bold ${scoreText(score)}`}>{score}</div>
                          )}
                          <div className="text-xs text-ink-faint">{timeAgo(tracked.updatedAt)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}

      {dismissedCount > 0 && (
        <p className="mt-10 text-sm text-ink-faint">
          {dismissedCount} {dismissedCount === 1 ? "job is" : "jobs are"} hidden as &ldquo;not for
          me&rdquo;. They stay out of your feed and are not scored again.
        </p>
      )}
    </div>
  );
}
