/** Where postings come from, and what each source is actually good for. */

/** Scraped from live HTML, one title at a time per location. */
export const SCRAPER_BOARDS = ["LinkedIn", "Xing", "Arbeitnow"];

/**
 * How many public boards the job-boards option covers.
 *
 * Written down once because the summary line used to say "Six boards" in
 * prose, and adding StepStone and Adzuna made that quietly wrong -- the kind
 * of stale claim no test catches.
 */
export const API_BOARD_COUNT = 10;

/** The public boards, searched together in one pass. */
export const API_BOARDS = "Job boards";

/**
 * Public boards worth choosing on their own.
 *
 * StepStone returns more usable German results than anything else here --
 * measured, 62% of what it fetches survives filtering against Arbeitnow's
 * 2.5% -- and it was reachable only by picking "Job boards" and hoping. A
 * source that good should be a button.
 */
export const SINGLE_API_BOARDS = ["StepStone", "Adzuna", "Indeed"];

export const SOURCE_OPTIONS = [...SCRAPER_BOARDS, ...SINGLE_API_BOARDS, API_BOARDS];

/**
 * Sources that run through the owner's personal browser session.
 *
 * LinkedIn and Xing are read from a logged-in Playwright profile -- one real
 * account, on one machine, with that person's session cookies. Indeed needs
 * a visible browser window and cannot run on a server at all.
 *
 * On a shared deployment these must never run for anybody else. Every
 * stranger's search would go out through the owner's LinkedIn account from a
 * single IP, which is how an account gets restricted, and it is that
 * person's real professional account -- the one they are job hunting with.
 * A stranger's convenience is not worth somebody's LinkedIn.
 *
 * Everyone gets StepStone, Adzuna, Arbeitnow and the public boards, which
 * need no login and are the better sources anyway: measured, StepStone
 * returned 49 unseen jobs where LinkedIn returned 1.
 */
export const PERSONAL_SOURCES = ["LinkedIn", "Xing", "Indeed"];

export function isPersonalSource(source: string): boolean {
  return PERSONAL_SOURCES.includes(source);
}

/** The sources this person may pick from. */
export function sourcesVisibleTo(isOwner: boolean): string[] {
  return isOwner ? SOURCE_OPTIONS : SOURCE_OPTIONS.filter((s) => !isPersonalSource(s));
}

/**
 * Drop anything this person is not allowed to search.
 *
 * Called on the server, on the way into a run -- not only where the buttons
 * are drawn. A hidden button is a suggestion; this is the rule.
 */
export function allowedSources(sources: string[], isOwner: boolean): string[] {
  return isOwner ? sources : sources.filter((s) => !isPersonalSource(s));
}

/** The boards to query for a source, or null for "all of them". */
export function boardsFor(source: string): string[] | null {
  return SINGLE_API_BOARDS.includes(source) ? [source] : null;
}

/** How many postings one run scores by default, and the most it will. */
export const DEFAULT_JOBS_PER_RUN = 30;
export const MAX_JOBS_PER_RUN = 120;

/**
 * The sources a profile wants, old single-source profiles included.
 *
 * searchBoards was added after searchBoard, and every profile saved before
 * that holds an empty list. Falling back here rather than migrating the
 * column means a profile is never silently rewritten, and the fallback stops
 * mattering the first time someone presses Fetch.
 */
export function sourcesOf(profile: { searchBoards?: string[]; searchBoard: string }): string[] {
  const chosen = (profile.searchBoards ?? []).filter((name) => SOURCE_OPTIONS.includes(name));
  return chosen.length > 0 ? chosen : [profile.searchBoard];
}

export type SourcePlan = {
  /** Scraped sources, each its own pass: LinkedIn, Xing, Arbeitnow. */
  scrapers: string[];
  /** True when any JSON board was chosen and one /search call is needed. */
  searchesApi: boolean;
  /** Which boards that call asks for, or null for every public board. */
  apiBoards: string[] | null;
};

/**
 * Split a mixed selection across the two paths that actually fetch.
 *
 * Scrapers and JSON boards are different machinery -- one drives a browser
 * per title per location, the other asks ten services a question -- and a
 * run that picks from both columns has to do both. Splitting here rather
 * than in the action keeps the rule in one place, testable, and identical
 * in the form's time estimate and in the run itself.
 *
 * "Job boards" absorbs the individual ones: choosing it plus StepStone asks
 * for every board, and naming StepStone again would only narrow it.
 */
export function planFor(sources: string[]): SourcePlan {
  const scrapers = SCRAPER_BOARDS.filter((name) => sources.includes(name));
  const wantsAll = sources.includes(API_BOARDS);
  const named = SINGLE_API_BOARDS.filter((name) => sources.includes(name));
  return {
    scrapers,
    searchesApi: wantsAll || named.length > 0,
    apiBoards: wantsAll ? null : named.length > 0 ? named : null,
  };
}

/** Does this source go through the JSON-board path rather than a scraper? */
export function isApiSource(source: string): boolean {
  return source === API_BOARDS || SINGLE_API_BOARDS.includes(source);
}

export const SOURCE_HINTS: Record<string, string> = {
  LinkedIn:
    "Deep, and filtered by LinkedIn itself before results come back. Reads LinkedIn's guest pages as a browser would, so it breaks when they change their markup and can return nothing when rate limited.",
  Xing:
    "German-speaking market. No seniority or years filter — Xing's search has no such facet — so those two settings are ignored for this source.",
  Arbeitnow:
    "A public JSON board with a smaller pool and no scraping involved. Quick, and safe to hammer.",
  Adzuna:
    "The highest hit rate of any source here — measured, two thirds of what it returns survives filtering. Searches server-side across the German market. Needs a free key in job_scout/.env; without one it returns nothing.",
  Indeed:
    "Frequently blocked. Indeed now puts a Cloudflare human check in front of searches, and it fails on the browser being automated rather than on who clicks — so ticking the box does not help. When it does get through: a visible browser window, this machine only, one page per title. Treat it as a bonus, not a source you rely on.",
  StepStone:
    "Germany's largest board, and the best source here for on-site German roles — it searches properly rather than handing back a catalogue, so most of what it returns is worth reading. Read from its public search pages.",
  [API_BOARDS]:
    "StepStone, Arbeitnow, Adzuna, Jooble, Indeed, Remotive, RemoteOK, Jobicy, The Muse and Himalayas at once. StepStone carries the on-site German roles and returns the most usable results of any source here; the remote-first boards make up the volume.",
};

/** LinkedIn's f_E facet, and the vocabulary the job-boards filter reuses. */
export const EXPERIENCE_LEVELS = [
  "Internship",
  "Entry level",
  "Associate",
  "Mid-Senior level",
  "Director",
];

/**
 * Sources that honour the experience-level and years-of-experience filters.
 *
 * Two different mechanisms, one promise. LinkedIn applies them server-side,
 * before results come back. The job boards have no such facet, so the
 * service reads the seniority out of each title and the years out of each
 * description instead -- see job_scout/sources/seniority.py. Xing and
 * Arbeitnow have neither, and say so.
 */
export function supportsFilters(board: string): boolean {
  return board === "LinkedIn" || isApiSource(board);
}

/** How the filter is applied, in the user's terms. Empty when it is not. */
export function filterMethod(board: string): string {
  if (board === "LinkedIn") return "Applied by LinkedIn itself, before results come back.";
  if (isApiSource(board)) {
    return "This has no seniority filter of its own, so postings that state a level outside your choice are dropped after they are fetched. A title that does not say is kept.";
  }
  return "";
}
