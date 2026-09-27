/**
 * Which scored jobs the feed shows, and how far back it reaches.
 *
 * Lives here rather than in the page so that the checks in scripts/ can run
 * the same expression the feed runs. A check that re-implements the query
 * proves only that two copies of a rule agree with each other, which is
 * exactly the bug it should be catching.
 */
import { and, eq, gte, isNull, ne, or, sql } from "drizzle-orm";

import { jobStatus, jobs, ratings } from "@/lib/db/schema";

/**
 * How far back the feed reaches, newest first, defaulting to the last run.
 *
 * Measured on ratings.ratedAt -- when a job entered THIS user's feed -- not
 * on the board's own "posted" field, which arrives as free text ("yesterday",
 * "2 days ago", sometimes nothing) and cannot be compared to a date.
 */
export const WINDOWS = [
  { value: "run", label: "This search", hours: 24 },
  { value: "24h", label: "Last 24 hours", hours: 24 },
  { value: "7d", label: "Last 7 days", hours: 24 * 7 },
  { value: "all", label: "All time", hours: null },
] as const;

/**
 * The default is the run you just did, not a period of time.
 *
 * Two searches an hour apart used to pile into one list, so the jobs you had
 * already read through came back mixed with the new ones and the only way to
 * tell them apart was to remember. A run is what a person actually thinks in
 * -- "the jobs I just found" -- and it is the one boundary they did not have.
 *
 * Anything you have acted on stays regardless of which run produced it: a job
 * you saved or applied to is not last search's business, and having it vanish
 * because you searched again would be the worst possible moment to lose it.
 * The older runs are still there under the wider windows.
 */
export const DEFAULT_WINDOW = "run";

export type FeedFilters = {
  userId: string;
  minScore: number;
  /** The run the feed calls "this search", or null for someone who has none. */
  lastRunId: string | null;
  /** Whether the chosen window is a run at all, rather than a period. */
  useRun: boolean;
  hours: number | null;
  board: string | null;
};

/**
 * The current run, when that is the window being shown.
 *
 * A rating from this run, OR any job the user has acted on. The second half
 * is the important one: a saved or applied job belongs to the person, not to
 * the search that surfaced it, and searching again must never take it out of
 * sight.
 *
 * The other half rests on find.ts re-stamping every posting a run re-finds,
 * not only the ones new enough to be worth scoring. Without that, this reads
 * as "jobs scored during the last run" -- a far smaller and much stranger set
 * than "jobs the last run found".
 */
function runFilter(lastRunId: string | null, useRun: boolean) {
  return useRun && lastRunId
    ? or(eq(ratings.runId, lastRunId), sql`${jobStatus.status} is not null`)
    : undefined;
}

/**
 * Exactly what one run produced, for the Find page's "your last search".
 *
 * Narrower than feedWhere on purpose: no score floor, no time window, and
 * no "or anything you acted on". This answers "what did that run turn up",
 * and a job from an earlier run is not an answer to it however good it was.
 * Dismissed postings still drop out -- something you have already said no to
 * is not a result worth showing again.
 */
export function lastRunWhere(userId: string, runId: string) {
  return and(
    eq(ratings.userId, userId),
    eq(ratings.runId, runId),
    or(isNull(jobStatus.status), ne(jobStatus.status, "dismissed")),
  );
}

export function feedWhere({ userId, minScore, lastRunId, useRun, hours, board }: FeedFilters) {
  return and(
    eq(ratings.userId, userId),
    gte(ratings.score, minScore),
    runFilter(lastRunId, useRun),
    // Jobs you said were not for you leave the feed, but stay in the
    // database so a later run does not pay to score them again.
    or(isNull(jobStatus.status), ne(jobStatus.status, "dismissed")),
    // "Now" comes from the database, not from this process: one clock for a
    // comparison against a column the same database wrote, and no impure
    // read during render.
    hours === null
      ? undefined
      : sql`${ratings.ratedAt} >= now() - make_interval(hours => ${hours})`,
    board ? eq(jobs.source, board) : undefined,
  );
}
