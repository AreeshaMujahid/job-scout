"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, desc, eq, inArray } from "drizzle-orm";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { jobStatus, jobs, profiles, ratings, runs, type RunState } from "@/lib/db/schema";
import { extraContext, parseList } from "@/lib/preferences";
import { lastRunWhere } from "@/lib/feed/window";
import { toJobView, type JobView } from "@/lib/jobview";
import {
  allowedSources,
  DEFAULT_JOBS_PER_RUN,
  MAX_JOBS_PER_RUN,
  planFor,
  PERSONAL_SOURCES,
  SOURCE_OPTIONS,
} from "@/lib/boards";
import { canUsePersonalSources } from "@/lib/auth/admin";
import {
  rateJobs,
  scrapeJobs,
  searchJobs,
  toScoutProfile,
  ScoutError,
  type ScoutJob,
  type ScrapeSearch,
} from "@/lib/scout";

export type FindState = {
  /**
   * "started" is the one the form usually gets.
   *
   * A run takes minutes, nearly all of it waiting on a rate-limited model,
   * so the action no longer waits for it: it writes the run down, kicks it
   * off, and hands back an id to watch. "done" and "error" still exist for
   * the failures that happen before a run can start -- no CV, no titles --
   * which are worth saying immediately rather than through a poll.
   */
  status: "idle" | "started" | "done" | "error";
  message: string;
  stats?: { label: string; value: number }[];
  hint?: string;
  /** The run to poll with runProgress(), set when status is "started". */
  runId?: string;
  /** Per title x location, only set for a scrape -- explains a lopsided count. */
  perSearch?: ScrapeSearch[];
};

/** What a poll gets back: the run's state, and what it has scored so far. */
export type RunProgress = {
  status: RunState | "missing";
  message: string;
  hint?: string;
  stats: { label: string; value: number }[];
  /** How many it means to score, and how many are done. 0 before it knows. */
  target: number;
  scored: number;
  /** Everything this run has written so far, best match first. */
  results: JobView[];
};

/**
 * The most postings a single scraped source may fetch in one run.
 *
 * Not a preference -- a ceiling. Scraping costs a request and a delay PER
 * POSTING, not per page, so an unbounded source fetches hundreds of
 * descriptions, outlives the five-minute HTTP timeout, and returns nothing
 * for all of it. The run-size setting divides across sources beneath this.
 */
const MAX_SCRAPE_PER_SOURCE = 60;

/**
 * How many postings go to the model in one call.
 *
 * Chunked rather than sent in one 600-second request for two reasons: the
 * run can report progress between chunks, and the postings it has already
 * scored are in the database -- and so on the screen -- while the rest are
 * still being read. A failure part-way now costs one chunk instead of
 * everything.
 */
const SCORE_CHUNK = 8;

export async function runSearch(_previous: FindState, formData: FormData): Promise<FindState> {
  const user = await requireUser();
  if (!user.profile) {
    return { status: "error", message: "Upload a CV first — it is what jobs get scored against." };
  }

  const titles = parseList(formData.get("titles"));
  const locations = parseList(formData.get("locations"));
  /**
   * Every source ticked, falling back to the single one older forms posted.
   *
   * Filtered against the known list rather than trusted: this arrives from a
   * form, and an unknown name would reach planFor() and silently match
   * nothing, which reads exactly like a board having a quiet day.
   */
  /**
   * Whether this person may use the sources that run on the owner's own
   * logged-in browser session.
   *
   * Checked here, on the server, at the point a run starts -- not only where
   * the buttons are drawn. Hiding a control stops an honest mistake; this
   * stops a crafted form post, and what is at stake is somebody's real
   * LinkedIn account rather than a page of results.
   */
  const owner = await canUsePersonalSources();

  const sources = (() => {
    const picked = formData
      .getAll("boards")
      .map(String)
      .filter((name) => SOURCE_OPTIONS.includes(name));
    const wanted = picked.length > 0 ? picked : [String(formData.get("board") ?? "StepStone")];
    const known = wanted.filter((name) => SOURCE_OPTIONS.includes(name));
    const permitted = allowedSources(known, owner);
    // Falling back to StepStone rather than LinkedIn: the default must be a
    // source everybody is allowed to use.
    return permitted.length > 0 ? permitted : ["StepStone"];
  })();

  const refused = owner
    ? []
    : PERSONAL_SOURCES.filter((name) => formData.getAll("boards").map(String).includes(name));
  const limit = clamp(
    Number(formData.get("limit") ?? DEFAULT_JOBS_PER_RUN),
    1,
    MAX_JOBS_PER_RUN,
  );
  const pages = clamp(Number(formData.get("pages") ?? 3), 1, 10);
  const hours = clamp(Number(formData.get("hours") ?? 24), 1, 720);
  const levels = formData.getAll("levels").map(String);
  const capYears = formData.get("capYears") === "on";
  const maxYears = capYears ? clamp(Number(formData.get("maxYears") ?? 5), 0, 15) : null;

  const plan = planFor(sources);
  const scraping = plan.scrapers.length > 0;

  /**
   * The titles actually sent to the API boards.
   *
   * Those boards match on words, so one title is one narrow query: a search
   * for "Data Scientist" alone reads ~850 postings and keeps three, because
   * every "Machine Learning Engineer" and "AI Engineer" fails the match.
   * Adding two related titles took the same search from 3 results to 32.
   *
   * The roles the CV proposed at onboarding are exactly that list. Results
   * are ranked by how well the title matches, so broadening adds candidates
   * below the user's own titles rather than displacing them.
   *
   * The scrapers are left alone: they search once per title per location, so
   * extra titles there cost real requests against a board that rate-limits.
   */
  const extraTitles = !plan.searchesApi
    ? []
    : (user.profile.suggestedRoles ?? [])
        .filter((role) => role && !titles.some((t) => t.toLowerCase() === role.toLowerCase()))
        .slice(0, 5);
  const queries = [...titles, ...extraTitles];

  if (titles.length === 0) return { status: "error", message: "Add at least one job title." };
  if (sources.length === 0) return { status: "error", message: "Pick at least one source." };
  if (refused.length > 0) {
    return {
      status: "error",
      message: `${refused.join(" and ")} ${refused.length === 1 ? "is" : "are"} not available on this account.`,
      hint:
        "Those sources read from one person's logged-in browser session, so they only " +
        "run for the account that owns it. StepStone and Adzuna need no login and " +
        "return more usable German results anyway.",
    };
  }
  // The scrapers search once per location and so need at least one. The JSON
  // boards take a location as a filter and are happy without it.
  if (scraping && locations.length === 0) {
    return { status: "error", message: "Add at least one location." };
  }

  /**
   * This run's own id.
   *
   * Every rating written below carries it, and the profile remembers the
   * last one, so the feed can show "what this search found" rather than
   * every job ever scored. Minted here, before anything is written, so a
   * run that fails halfway still has a consistent id on what it did write.
   */
  const runId = randomUUID();

  const db = await getDb();

  // Remember the settings, so this screen opens where it was left.
  await db
    .update(profiles)
    .set({
      targetRoles: titles,
      cities: locations,
      // Both columns, so a rollback to the single-source build still finds a
      // source it understands rather than an empty box.
      searchBoards: sources,
      searchBoard: sources[0],
      searchLimit: limit,
      searchPages: pages,
      searchHours: hours,
      searchLevels: levels,
      searchMaxYears: maxYears,
      lastRunId: runId,
      updatedAt: new Date(),
    })
    .where(eq(profiles.userId, user.id));

  await db.insert(runs).values({
    id: runId,
    userId: user.id,
    status: "running",
    message: "Searching...",
    target: limit,
  });

  /**
   * Deliberately not awaited.
   *
   * The whole point is that the response goes back now and the work carries
   * on in this process. Nothing downstream reads the promise, so the catch
   * is not optional -- an unhandled rejection here would take the server
   * down rather than mark one run failed.
   */
  void execute({
    userId: user.id,
    profile: user.profile,
    runId,
    titles,
    locations,
    queries,
    extraTitles,
    sources,
    plan,
    limit,
    pages,
    hours,
    levels,
    maxYears,
  }).catch(async (error) => {
    const failedAt = await getDb();
    await failedAt
      .update(runs)
      .set({ status: "error", message: describe(error), finishedAt: new Date() })
      .where(eq(runs.id, runId));
  });

  return { status: "started", message: "Searching...", runId };
}

/**
 * Ask how a run is getting on.
 *
 * The results come out of the ratings table rather than being carried along
 * in memory, using the same expression the Find page and the feed use. That
 * is what makes a half-finished run readable: every chunk it scores is a row
 * the moment it is written, so this returns more each time it is called.
 */
export async function runProgress(runId: string): Promise<RunProgress> {
  const user = await requireUser();
  const db = await getDb();

  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.userId, user.id)))
    .limit(1);

  if (!run) {
    return {
      status: "missing",
      message: "That search is no longer around.",
      stats: [],
      target: 0,
      scored: 0,
      results: [],
    };
  }

  const rows = await db
    .select({ job: jobs, rating: ratings, status: jobStatus.status })
    .from(ratings)
    .innerJoin(jobs, eq(ratings.jobId, jobs.id))
    .leftJoin(jobStatus, and(eq(jobStatus.jobId, ratings.jobId), eq(jobStatus.userId, user.id)))
    .where(lastRunWhere(user.id, runId))
    .orderBy(desc(ratings.score));

  return {
    status: run.status,
    message: run.message,
    hint: run.hint || undefined,
    stats: run.stats,
    target: run.target,
    scored: run.scored,
    results: rows.map((row) => toJobView(row.job, row.rating, row.status)),
  };
}

type RunInput = {
  userId: string;
  profile: NonNullable<Awaited<ReturnType<typeof requireUser>>["profile"]>;
  runId: string;
  titles: string[];
  locations: string[];
  queries: string[];
  extraTitles: string[];
  sources: string[];
  plan: ReturnType<typeof planFor>;
  limit: number;
  pages: number;
  hours: number;
  levels: string[];
  maxYears: number | null;
};

/**
 * The run itself, after the response has gone back.
 *
 * Everything it has to say it says by writing to the runs row, because there
 * is no longer anyone waiting on a return value.
 */
async function execute({
  userId,
  profile,
  runId,
  titles,
  locations,
  queries,
  extraTitles,
  sources,
  plan,
  limit,
  pages,
  hours,
  levels,
  maxYears,
}: RunInput): Promise<void> {
  const db = await getDb();

  const say = (message: string) =>
    db.update(runs).set({ message }).where(eq(runs.id, runId));

  const finish = (fields: {
    status: RunState;
    message: string;
    hint?: string;
    stats?: { label: string; value: number }[];
  }) =>
    db
      .update(runs)
      .set({
        status: fields.status,
        message: fields.message,
        hint: fields.hint ?? "",
        ...(fields.stats ? { stats: fields.stats } : {}),
        finishedAt: new Date(),
      })
      .where(eq(runs.id, runId));

  const found: ScoutJob[] = [];
  const headlines: string[] = [];
  const stats: { label: string; value: number }[] = [];
  let perSearch: ScrapeSearch[] | undefined;
  /** Sources that ran and returned nothing, named rather than averaged away. */
  const silent: string[] = [];
  /** What a board said about itself when the count alone would mislead. */
  const boardNotes: string[] = [];

  /**
   * What each scraped source may fetch.
   *
   * The budget divides rather than multiplies: picking three scrapers should
   * cost about what one costs, not three times as much. Each scrape is its
   * own HTTP call with a five-minute ceiling and costs a request per posting
   * -- a source let loose on a large budget outlives that timeout and returns
   * nothing to show for it -- so this is capped outright as well.
   */
  const perScraper = Math.min(
    MAX_SCRAPE_PER_SOURCE,
    Math.max(10, Math.ceil(limit / Math.max(1, plan.scrapers.length))),
  );

  try {
    // One at a time: these are scrapers against boards that rate-limit, and
    // firing them together is how a run gets three empty results instead of
    // three full ones.
    for (const source of plan.scrapers) {
      const result = await scrapeJobs({
        titles,
        locations,
        board: source,
        pages,
        max_age_hours: hours,
        experience_levels: levels,
        max_years: maxYears,
        limit: perScraper,
      });
      found.push(...result.jobs);
      stats.push({ label: source, value: result.stats.kept });
      perSearch = [...(perSearch ?? []), ...result.stats.per_search];
      if (result.stats.scraped === 0) {
        silent.push(source);
      } else {
        headlines.push(`${result.stats.scraped} scraped from ${source}`);
      }
    }

    if (plan.searchesApi) {
      const result = await searchJobs({
        queries,
        // Null for every public board, a named list when specific ones were
        // picked -- StepStone and Adzuna are worth choosing deliberately.
        boards: plan.apiBoards,
        location: locations.join(", "),
        remote_only: profile.remoteOnly,
        limit: limit * 3,
        // These boards have no seniority facet, so the service applies the
        // filter to the titles it gets back. Before this was passed, the
        // level you picked did nothing on this path and an entry-level
        // search came back full of Senior and Staff roles.
        experience_levels: levels,
        max_years: maxYears,
        // The same window the scrapers get, in the unit this path works in.
        // Rounded up, so "24 hours" keeps today's postings rather than only
        // ones timestamped within the last twenty-four.
        max_age_days: Math.max(1, Math.ceil(hours / 24)),
      });
      found.push(...result.jobs);

      // The whole funnel, not just the total read. These boards cannot search
      // server-side, so they return everything they have and almost all of it
      // is filtered here -- silently, until now. "846 postings read" followed
      // by three results reads as a broken search; "839 did not match your
      // titles" reads as a narrow query, which is what it is.
      const boardCount = Object.keys(result.fetched).length;
      headlines.push(
        plan.apiBoards
          ? `${result.total_fetched} read from ${plan.apiBoards.join(", ")}`
          : `${result.total_fetched} read across ${boardCount} boards`,
      );
      if (extraTitles.length > 0) {
        headlines.push(`also searched ${extraTitles.join(", ")} from your CV`);
      }
      if ((result.off_topic ?? 0) > 0) {
        headlines.push(`${result.off_topic} did not match your titles`);
      }
      if ((result.filtered_by_level ?? 0) > 0) {
        headlines.push(`${result.filtered_by_level} were outside "${levels.join(", ")}"`);
      }
      if ((result.wrong_location ?? 0) > 0) {
        headlines.push(`${result.wrong_location} were in the wrong place`);
      }
      const rejected = result.rejected ?? {};
      if (rejected.stale) headlines.push(`${rejected.stale} were older than that`);
      if (rejected.underpaid) headlines.push(`${rejected.underpaid} paid below your floor`);
      if (rejected.blocked) headlines.push(`${rejected.blocked} were from blocked employers`);
      if (rejected.no_sponsorship) {
        headlines.push(`${rejected.no_sponsorship} said they cannot sponsor a visa`);
      }
      for (const [label, value] of Object.entries(result.fetched)) {
        stats.push({ label, value });
      }
      // A board that explained itself -- "Indeed asked you to confirm you
      // are human" -- said something far more useful than its count of
      // zero, and the count alone would read as "no such jobs exist".
      for (const reason of Object.values(result.errors ?? {})) {
        if (reason) boardNotes.push(reason);
      }
    }
  } catch (error) {
    await finish({ status: "error", message: describe(error), stats });
    return;
  }

  let headline = headlines.length > 0 ? `${headlines.join(". ")}.` : "";
  // Before the "returned nothing" line, because a board that was challenged
  // did not return nothing -- it never got to look.
  if (boardNotes.length > 0) headline += ` ${boardNotes.join(" ")}`;
  if (silent.length > 0) {
    // Named rather than folded into the total: a source that returns nothing
    // is a fact about that source, and averaging it into "12 postings found"
    // hides the one thing worth acting on.
    headline +=
      ` ${silent.join(" and ")} returned nothing for ` +
      `the last ${hours} ${hours === 1 ? "hour" : "hours"}.`;
  }

  if (found.length === 0) {
    // Every filter that narrows the pool is applied before results come back
    // on LinkedIn (f_TPR for recency, f_E for level) -- the most likely
    // single cause is named first, not buried after "try again later".
    const causes: string[] = [];
    if (levels.length > 0) causes.push(`the "${levels.join(", ")}" level filter`);
    causes.push(`postings from the last ${hours} ${hours === 1 ? "hour" : "hours"}`);
    if (maxYears !== null) causes.push(`a ${maxYears}-year experience cap`);

    await finish({
      status: "done",
      message: `${sources.join(", ")} returned nothing at all.`,
      hint:
        `These titles narrowed by ${causes.join(" and ")} is a real search — the filters ` +
        "are applied before results come back, so a niche title can genuinely have nothing " +
        "that matches right now. Widen the time window first: it is the setting that most " +
        "often makes a run look empty. A block or rate limit is the less likely cause but " +
        "worth a retry in a few minutes if loosening the filters doesn't change anything.",
      stats,
    });
    return;
  }

  // Never pay to score the same posting twice for the same person.
  const seen = await db
    .select({ jobId: ratings.jobId })
    .from(ratings)
    .where(eq(ratings.userId, userId));
  const alreadyRated = new Set(seen.map((row) => row.jobId));

  /**
   * One row per posting, however many sources returned it.
   *
   * A run across LinkedIn and StepStone finds the same vacancy twice under
   * two different keys only when the boards disagree about its URL; when
   * they agree, it arrives twice with one key. Deduping here rather than
   * relying on the insert's conflict clause matters because the count in
   * "scored 14 new jobs" is taken from this list, and counting a posting
   * twice would make the run report work it never did.
   */
  const byKey = new Map<string, (typeof found)[number]>();
  for (const job of found) {
    if (job.key && job.title && job.url && !byKey.has(job.key)) byKey.set(job.key, job);
  }
  const usable = [...byKey.values()];

  // A posting this search found belongs to this search, even when an earlier
  // run already scored it. Re-stamping it with the current run id is what
  // keeps the feed's "This search" window truthful: the dedup above exists to
  // avoid paying to score the same posting twice, not to deny that the search
  // returned it. Without this, a second search of the same titles shows only
  // the handful that happened to be new, and the sixty it genuinely found
  // read as though the board went quiet.
  const rediscovered = usable
    .filter((job) => alreadyRated.has(job.key))
    .map((job) => job.key);

  // Chunked because a broad search re-finds hundreds, and every id travels as
  // its own bound parameter.
  for (let i = 0; i < rediscovered.length; i += 400) {
    await db
      .update(ratings)
      .set({ runId })
      .where(
        and(eq(ratings.userId, userId), inArray(ratings.jobId, rediscovered.slice(i, i + 400))),
      );
  }
  if (rediscovered.length > 0) revalidatePath("/feed");

  const fresh = usable
    .filter((job) => !alreadyRated.has(job.key))
    .slice(0, limit);

  if (fresh.length === 0) {
    await finish({
      status: "done",
      message: rediscovered.length
        ? `${headline} Nothing new to score — all ${rediscovered.length} are ` +
          `already in your feed, where this search's results are waiting.`
        : `${headline} Nothing new — everything found is already in your feed.`,
      stats: rediscovered.length
        ? [...stats, { label: "Already scored", value: rediscovered.length }]
        : stats,
    });
    return;
  }

  await storeJobs(db, fresh);

  await db
    .update(runs)
    .set({ target: fresh.length, rediscovered: rediscovered.length, stats })
    .where(eq(runs.id, runId));

  /**
   * Score in chunks, writing each one before asking for the next.
   *
   * The postings already scored are rows in the database, so they are on the
   * screen while the rest are still being read -- the difference between
   * watching a number climb and watching a blank button. It also means a
   * chunk that fails costs that chunk rather than the whole run, and the
   * errors are collected instead of ending it.
   */
  let scored = 0;
  const problems: string[] = [];

  for (let at = 0; at < fresh.length; at += SCORE_CHUNK) {
    const slice = fresh.slice(at, at + SCORE_CHUNK);
    await say(`Scoring ${Math.min(at + slice.length, fresh.length)} of ${fresh.length}...`);

    let rated;
    try {
      rated = await rateJobs(toScoutProfile(profile), slice, extraContext(profile));
    } catch (error) {
      // One bad chunk is not a failed run. Say so at the end and keep what
      // the other chunks produced.
      problems.push(describe(error));
      continue;
    }
    if (rated.errors[0]) problems.push(rated.errors[0]);
    if (rated.ratings.length === 0) continue;

    await db
      .insert(ratings)
      .values(
        rated.ratings.map(({ job_index, rating }) => ({
          userId,
          jobId: slice[job_index].key,
          score: rating.score,
          verdict: rating.verdict,
          skillsMatch: rating.skills_match,
          experienceMatch: rating.experience_match,
          domainMatch: rating.domain_match,
          whyPick: rating.why_pick,
          concerns: rating.concerns,
          matchedSkills: rating.matched_skills,
          missingSkills: rating.missing_skills,
          pitch: rating.pitch,
          runId,
          ratedAt: new Date(),
        })),
      )
      .onConflictDoNothing();

    scored += rated.ratings.length;
    await db.update(runs).set({ scored }).where(eq(runs.id, runId));
    revalidatePath("/feed");
  }

  const failed = fresh.length - scored;
  await finish({
    status: "done",
    message:
      `${headline} Scored ${scored} new ${scored === 1 ? "job" : "jobs"}.` +
      // Said out loud because the feed will show these too, and a run that
      // scores 2 while surfacing 60 should not read as a run that found 2.
      (rediscovered.length ? ` ${rediscovered.length} already scored, also shown.` : ""),
    hint:
      failed > 0
        ? problems[0] ??
          `${failed} could not be scored this time and will be retried on the next run.`
        : undefined,
    stats: [...stats, { label: "Scored", value: scored }],
  });
  revalidatePath("/feed");
}


/** Postings are shared between users, so this is an upsert, never a replace. */
async function storeJobs(db: Awaited<ReturnType<typeof getDb>>, found: ScoutJob[]) {
  await db
    .insert(jobs)
    .values(
      found.map((job) => ({
        id: job.key,
        source: job.source,
        title: job.title,
        company: job.company,
        location: job.location,
        url: job.url,
        description: job.description,
        salary: job.salary,
        postedAt: job.posted_at,
        companyUrl: job.company_url ?? "",
        logoUrl: job.logo ?? "",
        remote: job.remote,
        tags: job.tags,
      })),
    )
    .onConflictDoNothing();
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.max(low, Math.min(high, Math.round(value)));
}

function describe(error: unknown): string {
  if (error instanceof ScoutError) return error.message;
  console.error("search failed", error);
  return "Something went wrong while searching. Try again in a moment.";
}
