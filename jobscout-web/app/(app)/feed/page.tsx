import Link from "next/link";
import { and, desc, eq, gte, ne, or, isNull, sql } from "drizzle-orm";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { jobStatus, jobs, ratings } from "@/lib/db/schema";
import { JobCard } from "@/components/JobCard";
import { toJobView } from "@/lib/jobview";

const FILTERS = [
  { value: "0", label: "Everything" },
  { value: "50", label: "50+" },
  { value: "65", label: "65+" },
  { value: "80", label: "Strong only" },
];

/**
 * How far back the feed reaches, newest first, defaulting to a day.
 *
 * Every run adds another batch of scored jobs and none of them leave, so the
 * feed grows without limit -- thirty of them is already more scrolling than
 * anyone does. A day is the useful window: what today's search turned up.
 *
 * Measured on ratings.ratedAt -- when a job entered THIS user's feed -- not
 * on the board's own "posted" field, which arrives as free text ("yesterday",
 * "2 days ago", sometimes nothing) and cannot be compared to a date.
 */
const WINDOWS = [
  { value: "24h", label: "Last 24 hours", hours: 24 },
  { value: "7d", label: "Last 7 days", hours: 24 * 7 },
  { value: "all", label: "All time", hours: null },
] as const;

const DEFAULT_WINDOW = "24h";

/** Enough to read in one screen; the rest is a click away. */
const PER_PAGE = 5;

export default async function FeedPage({ searchParams }: PageProps<"/feed">) {
  const user = await requireUser();
  const { min, since, source, page } = await searchParams;
  const minScore = Number(min ?? 0) || 0;
  const board = typeof source === "string" && source !== "all" ? source : null;

  const chosen = WINDOWS.find((w) => w.value === since) ?? WINDOWS[0];
  const usingDefault = since === undefined;

  const db = await getDb();

  const where = (hours: number | null) =>
    and(
      eq(ratings.userId, user.id),
      gte(ratings.score, minScore),
      // Jobs you said were not for you leave the feed, but stay in the
      // database so a later run does not pay to score them again.
      or(isNull(jobStatus.status), ne(jobStatus.status, "dismissed")),
      // "Now" comes from the database, not from this process: one clock
      // for a comparison against a column the same database wrote, and
      // no impure read during render.
      hours === null
        ? undefined
        : sql`${ratings.ratedAt} >= now() - make_interval(hours => ${hours})`,
      board ? eq(jobs.source, board) : undefined,
    );

  const base = () =>
    db
      .select({ rating: ratings, job: jobs, status: jobStatus.status })
      .from(ratings)
      .innerJoin(jobs, eq(ratings.jobId, jobs.id))
      .leftJoin(
        jobStatus,
        and(eq(jobStatus.jobId, ratings.jobId), eq(jobStatus.userId, user.id)),
      );

  const countIn = async (hours: number | null) => {
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(ratings)
      .innerJoin(jobs, eq(ratings.jobId, jobs.id))
      .leftJoin(
        jobStatus,
        and(eq(jobStatus.jobId, ratings.jobId), eq(jobStatus.userId, user.id)),
      )
      .where(where(hours));
    return row?.total ?? 0;
  };

  // Someone coming back after a few days would otherwise be met by an empty
  // feed and conclude their jobs were lost. The default widens itself rather
  // than showing nothing; an explicitly chosen window is left alone.
  let hours = chosen.hours;
  let total = await countIn(hours);
  let widened = false;
  if (total === 0 && usingDefault) {
    const everything = await countIn(null);
    if (everything > 0) {
      hours = null;
      total = everything;
      widened = true;
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));
  const current = Math.min(Math.max(Number(page ?? 1) || 1, 1), pageCount);

  // Only the current page is read out of the database. The feed is the one
  // screen that grows without bound, so paging it in SQL rather than
  // fetching everything and slicing keeps it the same cost at 30 jobs and
  // at 3,000.
  const rows = await base()
    .where(where(hours))
    .orderBy(desc(ratings.score))
    .limit(PER_PAGE)
    .offset((current - 1) * PER_PAGE);

  // Which boards this user actually has jobs from -- listing every board the
  // app supports would offer filters that return nothing.
  const boards = await db
    .selectDistinct({ source: jobs.source })
    .from(ratings)
    .innerJoin(jobs, eq(ratings.jobId, jobs.id))
    .leftJoin(
      jobStatus,
      and(eq(jobStatus.jobId, ratings.jobId), eq(jobStatus.userId, user.id)),
    )
    .where(
      and(
        eq(ratings.userId, user.id),
        or(isNull(jobStatus.status), ne(jobStatus.status, "dismissed")),
      ),
    )
    .orderBy(jobs.source);

  // Every filter lives in the URL, so changing one must carry the others --
  // and must send you back to page one, since page 4 of the old result set
  // is rarely a page of the new one.
  const href = (next: { min?: number; since?: string; source?: string; page?: number }) => {
    const params = new URLSearchParams();
    const nextMin = next.min ?? minScore;
    const nextSince = next.since ?? (widened ? "all" : chosen.value);
    const nextSource = next.source ?? board ?? "all";
    if (nextMin > 0) params.set("min", String(nextMin));
    if (nextSince !== DEFAULT_WINDOW) params.set("since", nextSince);
    if (nextSource !== "all") params.set("source", nextSource);
    if (next.page && next.page > 1) params.set("page", String(next.page));
    const query = params.toString();
    return query ? `/feed?${query}` : "/feed";
  };

  const activeWindow = widened ? "all" : chosen.value;
  const firstOnPage = (current - 1) * PER_PAGE + 1;
  const lastOnPage = Math.min(current * PER_PAGE, total);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Your feed</h1>
          <p className="hint mt-2">
            {total > 0
              ? `${total} ${total === 1 ? "job" : "jobs"}, best match first` +
                (total > PER_PAGE ? ` — showing ${firstOnPage}–${lastOnPage}.` : ".")
              : "Nothing here yet."}
          </p>
        </div>
        <Link href="/find" className="btn-primary">
          {total > 0 ? "Find more jobs" : "Find my first jobs"}
        </Link>
      </div>

      {widened && (
        <p className="mt-4 rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink-soft">
          Nothing new in the last 24 hours, so this is everything.{" "}
          <Link href="/find" className="font-medium text-brand hover:underline">
            Run a search
          </Link>{" "}
          for a fresh batch.
        </p>
      )}

      {(total > 0 || board) && (
        <div className="mt-8 space-y-3">
          <div className="flex flex-wrap gap-2">
            {WINDOWS.map((window) => (
              <Link
                key={window.value}
                href={href({ since: window.value })}
                className={
                  activeWindow === window.value
                    ? "rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white"
                    : "rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-canvas"
                }
              >
                {window.label}
              </Link>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {FILTERS.map((filter) => {
              const active = String(minScore) === filter.value;
              return (
                <Link
                  key={filter.value}
                  href={href({ min: Number(filter.value) })}
                  className={
                    active
                      ? "rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white"
                      : "rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-canvas"
                  }
                >
                  {filter.label}
                </Link>
              );
            })}
          </div>
          {boards.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {[{ source: "all" }, ...boards].map(({ source: name }) => (
                <Link
                  key={name}
                  href={href({ source: name })}
                  className={
                    (board ?? "all") === name
                      ? "rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white"
                      : "rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-canvas"
                  }
                >
                  {name === "all" ? "All platforms" : name}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyFeed
          filtered={minScore > 0}
          windowed={chosen.value !== "all"}
          board={board}
        />
      ) : (
        <>
          <div className="mt-6 space-y-4">
            {rows.map(({ job, rating, status }) => (
              <JobCard key={job.id} item={toJobView(job, rating, status)} />
            ))}
          </div>

          {pageCount > 1 && (
            <nav
              aria-label="Feed pages"
              className="mt-8 flex flex-wrap items-center justify-between gap-3"
            >
              <PagerLink href={href({ page: current - 1 })} disabled={current === 1}>
                ← Newer matches
              </PagerLink>
              <span className="text-sm text-ink-faint">
                Page {current} of {pageCount}
              </span>
              <PagerLink href={href({ page: current + 1 })} disabled={current === pageCount}>
                Older matches →
              </PagerLink>
            </nav>
          )}
        </>
      )}
    </div>
  );
}

/** A pager control that is a real link when it leads somewhere, and inert
 *  (not a link to the page you are on) when it does not. */
function PagerLink({
  href,
  disabled,
  children,
}: {
  href: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <span className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink-faint opacity-50">
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-canvas"
    >
      {children}
    </Link>
  );
}

function EmptyFeed({
  filtered,
  windowed,
  board,
}: {
  filtered: boolean;
  windowed: boolean;
  board: string | null;
}) {
  return (
    <div className="card mt-8 p-10 text-center">
      <h2 className="text-lg font-semibold">
        {board
          ? `Nothing from ${board}`
          : windowed
            ? "Nothing in that window"
            : filtered
              ? "Nothing scores that highly yet"
              : "Your feed is empty"}
      </h2>
      <p className="hint mx-auto mt-2 max-w-md">
        {board ? (
          <>
            Try{" "}
            <Link href="/feed" className="font-medium text-brand hover:underline">
              all platforms
            </Link>
            , or widen the window — {board} may not have been searched recently.
          </>
        ) : windowed ? (
          <>
            Try{" "}
            <Link href="/feed?since=all" className="font-medium text-brand hover:underline">
              all time
            </Link>
            , or{" "}
            <Link href="/find" className="font-medium text-brand hover:underline">
              run a search
            </Link>{" "}
            — each one reads a fresh batch of postings.
          </>
        ) : filtered ? (
          <>
            Try <Link href="/feed" className="font-medium text-brand hover:underline">everything</Link>, or{" "}
            <Link href="/find" className="font-medium text-brand hover:underline">run another search</Link> —
            each one reads a fresh batch of postings.
          </>
        ) : (
          <>
            Press <span className="font-medium text-ink">Find my first jobs</span> above. The job
            titles from your CV get searched, and everything that comes back is scored against it.
          </>
        )}
      </p>
    </div>
  );
}
