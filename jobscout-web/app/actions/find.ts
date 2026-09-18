"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { jobs, profiles, ratings } from "@/lib/db/schema";
import { extraContext, parseList } from "@/lib/preferences";
import type { JobView } from "@/lib/jobview";
import { SCRAPER_BOARDS } from "@/lib/boards";
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
  status: "idle" | "done" | "error";
  message: string;
  stats?: { label: string; value: number }[];
  hint?: string;
  /** What this run found, so the results appear here and not only in the feed. */
  results?: JobView[];
  /** Per title x location, only set for a scrape -- explains a lopsided count. */
  perSearch?: ScrapeSearch[];
};

/** How many new postings one run will pay to score. */
const RATE_LIMIT_PER_RUN = 30;

/**
 * How many postings a scrape may collect before it stops. One fetch, thirty
 * postings -- no more, as asked for.
 *
 * Bounded at all because scraping costs a request and a delay PER POSTING,
 * not per page: an unbounded eight-search run fetches ~240 descriptions,
 * outlives the five-minute HTTP timeout, and returns nothing for all of it.
 *
 * Note the consequence of matching the score limit exactly rather than
 * over-fetching: postings already in the feed are filtered out AFTER the
 * scrape, so a repeat run over the same titles scores fewer than thirty new
 * ones -- whatever is left after the ones already seen. Widening the time
 * window is what brings in unseen postings, not a bigger fetch.
 */
const SCRAPE_LIMIT_PER_RUN = RATE_LIMIT_PER_RUN;

export async function runSearch(_previous: FindState, formData: FormData): Promise<FindState> {
  const user = await requireUser();
  if (!user.profile) {
    return { status: "error", message: "Upload a CV first — it is what jobs get scored against." };
  }

  const titles = parseList(formData.get("titles"));
  const locations = parseList(formData.get("locations"));
  const board = String(formData.get("board") ?? "LinkedIn");
  const pages = clamp(Number(formData.get("pages") ?? 3), 1, 10);
  const hours = clamp(Number(formData.get("hours") ?? 24), 1, 720);
  const levels = formData.getAll("levels").map(String);
  const capYears = formData.get("capYears") === "on";
  const maxYears = capYears ? clamp(Number(formData.get("maxYears") ?? 5), 0, 15) : null;

  const scraping = SCRAPER_BOARDS.includes(board);

  if (titles.length === 0) return { status: "error", message: "Add at least one job title." };
  // The scrapers search once per location and so need at least one. The JSON
  // boards take a location as a filter and are happy without it.
  if (scraping && locations.length === 0) {
    return { status: "error", message: "Add at least one location." };
  }

  const db = await getDb();

  // Remember the settings, so this screen opens where it was left.
  await db
    .update(profiles)
    .set({
      targetRoles: titles,
      cities: locations,
      searchBoard: board,
      searchPages: pages,
      searchHours: hours,
      searchLevels: levels,
      searchMaxYears: maxYears,
      updatedAt: new Date(),
    })
    .where(eq(profiles.userId, user.id));

  let found: ScoutJob[];
  let headline: string;
  let stats: { label: string; value: number }[];
  let perSearch: ScrapeSearch[] | undefined;

  try {
    if (scraping) {
      const result = await scrapeJobs({
        titles,
        locations,
        board,
        pages,
        max_age_hours: hours,
        experience_levels: levels,
        max_years: maxYears,
        limit: SCRAPE_LIMIT_PER_RUN,
      });
      found = result.jobs;
      // The age window is named because it, not the job market, is usually
      // what makes a run look thin. LinkedIn applies it server-side (f_TPR),
      // so a 24-hour search genuinely returns only what went up today —
      // "8 postings scraped from LinkedIn" then reads as though the board
      // holds eight such jobs, when widening the window to a week would
      // return many more. Nothing is dropped locally, so there is no count
      // to show; saying the window is what makes the number legible.
      headline =
        `${result.stats.scraped} postings scraped from ${board}, ` +
        `posted in the last ${hours} ${hours === 1 ? "hour" : "hours"}.`;
      stats = [
        { label: "Scraped", value: result.stats.scraped },
        { label: "Unique", value: result.stats.kept },
        { label: "Duplicates", value: result.stats.duplicates },
        { label: "Searches", value: result.stats.searches },
      ];
      perSearch = result.stats.per_search;

      if (result.stats.scraped === 0) {
        // Every filter that narrows the pool is server-side on LinkedIn
        // (f_TPR for recency, f_E for level) -- the most likely single cause
        // is named first, not buried after "try again later".
        const causes: string[] = [];
        if (levels.length > 0) {
          causes.push(`the "${levels.join(", ")}" level filter`);
        }
        causes.push(`postings from the last ${hours} ${hours === 1 ? "hour" : "hours"}`);
        if (maxYears !== null) {
          causes.push(`a ${maxYears}-year experience cap`);
        }

        return {
          status: "done",
          message: `${board} returned nothing at all for ${result.stats.searches} searches.`,
          hint:
            `These titles narrowed by ${causes.join(" and ")} is a real search — LinkedIn ` +
            "applies these before results come back, so a niche title can genuinely have " +
            "nothing that matches right now. Clear the level filter or widen the time window " +
            "first; a block or rate limit is the less likely cause but worth a retry in a " +
            "few minutes if loosening the filters doesn't change anything.",
          stats,
          perSearch,
        };
      }
    } else {
      const result = await searchJobs({
        queries: titles,
        location: locations.join(", "),
        remote_only: user.profile.remoteOnly,
        limit: RATE_LIMIT_PER_RUN * 3,
      });
      found = result.jobs;
      headline = `${result.total_fetched} postings read across ${Object.keys(result.fetched).length} boards.`;
      stats = Object.entries(result.fetched).map(([label, value]) => ({ label, value }));
    }
  } catch (error) {
    return { status: "error", message: describe(error) };
  }

  // Never pay to score the same posting twice for the same person.
  const seen = await db
    .select({ jobId: ratings.jobId })
    .from(ratings)
    .where(eq(ratings.userId, user.id));
  const alreadyRated = new Set(seen.map((row) => row.jobId));

  const fresh = found
    .filter((job) => job.key && job.title && job.url && !alreadyRated.has(job.key))
    .slice(0, RATE_LIMIT_PER_RUN);

  if (fresh.length === 0) {
    return {
      status: "done",
      message: `${headline} Nothing new — everything found is already in your feed.`,
      stats,
      perSearch,
    };
  }

  await storeJobs(db, fresh);

  let rated;
  try {
    rated = await rateJobs(toScoutProfile(user.profile), fresh, extraContext(user.profile));
  } catch (error) {
    return { status: "error", message: describe(error) };
  }

  if (rated.ratings.length > 0) {
    await db
      .insert(ratings)
      .values(
        rated.ratings.map(({ job_index, rating }) => ({
          userId: user.id,
          jobId: fresh[job_index].key,
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
          ratedAt: new Date(),
        })),
      )
      .onConflictDoNothing();
  }

  revalidatePath("/feed");

  const results: JobView[] = rated.ratings
    .map(({ job_index, rating }) => {
      const job = fresh[job_index];
      return {
        id: job.key,
        title: job.title,
        company: job.company,
        location: job.location,
        source: job.source,
        url: job.url,
        salary: job.salary,
        postedAt: job.posted_at,
        companyUrl: job.company_url ?? "",
        remote: job.remote,
        score: rating.score,
        verdict: rating.verdict,
        whyPick: rating.why_pick,
        concerns: rating.concerns,
        missingSkills: rating.missing_skills,
        // Newly found, so nothing is tracked against it yet.
        status: null,
      };
    })
    .sort((a, b) => b.score - a.score);

  const failed = fresh.length - rated.ratings.length;
  return {
    status: "done",
    message:
      `${headline} Scored ${rated.ratings.length} new ` +
      `${rated.ratings.length === 1 ? "job" : "jobs"}.`,
    hint:
      failed > 0
        ? rated.errors[0] ??
          `${failed} could not be scored this time and will be retried on the next run.`
        : undefined,
    stats: [...stats, { label: "Scored", value: rated.ratings.length }],
    perSearch,
    results,
  };
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
