import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";

import { canUsePersonalSources } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { jobStatus, jobs, ratings } from "@/lib/db/schema";
import { lastRunWhere } from "@/lib/feed/window";
import { toJobView, type JobView } from "@/lib/jobview";
import { FindForm } from "./FindForm";

/** Enough to see what the run turned up without this becoming the feed. */
const LAST_RUN_SHOWN = 10;

export default async function FindPage() {
  const user = await requireUser();
  if (!user.profile) redirect("/onboarding");

  /**
   * What the last run found, read back from the database.
   *
   * This page has always said "results appear below", and they did -- until
   * the first refresh, because they only ever existed in client state. So
   * the page you landed on promised something it could not show, and the
   * jobs you had just paid to score were reachable only from the feed.
   *
   * Keyed on the run id rather than a time window: "your last search" is a
   * run, not the last N hours, and a six-minute run would start falling out
   * of a tight window while you were still reading it.
   */
  const db = await getDb();
  const lastRunId = user.profile.lastRunId;
  const lastRun: JobView[] = lastRunId
    ? (
        await db
          .select({ job: jobs, rating: ratings, status: jobStatus.status })
          .from(ratings)
          .innerJoin(jobs, eq(ratings.jobId, jobs.id))
          .leftJoin(
            jobStatus,
            and(eq(jobStatus.jobId, ratings.jobId), eq(jobStatus.userId, user.id)),
          )
          .where(lastRunWhere(user.id, lastRunId))
          .orderBy(desc(ratings.score))
          .limit(LAST_RUN_SHOWN)
      ).map((row) => toJobView(row.job, row.rating, row.status))
    : [];

  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight">Find jobs</h1>
      <p className="hint mt-2 max-w-3xl">
        Each title is searched once per location, and everything new is scored against your CV.
        Results appear below and in{" "}
        <Link href="/feed" className="font-medium text-brand hover:underline">
          your feed
        </Link>
        . Nothing is scored twice, and nothing is lost between runs.
      </p>

      <FindForm profile={user.profile} lastRun={lastRun} isOwner={await canUsePersonalSources()} />
    </div>
  );
}
