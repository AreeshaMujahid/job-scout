/** Where postings come from, and what each source is actually good for. */

/** Scraped from live HTML, one title at a time per location. */
export const SCRAPER_BOARDS = ["LinkedIn", "Xing", "Arbeitnow"];

/** The six public JSON APIs, searched together. */
export const API_BOARDS = "Job boards";

export const SOURCE_OPTIONS = [...SCRAPER_BOARDS, API_BOARDS];

export const SOURCE_HINTS: Record<string, string> = {
  LinkedIn:
    "The deepest pool, and the only source with a real supply of on-site German roles. Reads LinkedIn's guest pages as a browser would, so it breaks when they change their markup and can return nothing when rate limited.",
  Xing:
    "German-speaking market. No seniority or years filter — Xing's search has no such facet — so those two settings are ignored for this source.",
  Arbeitnow:
    "A public JSON board with a smaller pool and no scraping involved. Quick, and safe to hammer.",
  [API_BOARDS]:
    "Remotive, RemoteOK, Arbeitnow, Jobicy, The Muse and Himalayas at once — roughly 700 postings a run, mostly remote. No seniority or years filter.",
};

/** LinkedIn's f_E facet. The other sources have no server-side equivalent. */
export const EXPERIENCE_LEVELS = [
  "Internship",
  "Entry level",
  "Associate",
  "Mid-Senior level",
  "Director",
];

/** Sources that honour the experience-level and years-of-experience filters. */
export function supportsFilters(board: string): boolean {
  return board === "LinkedIn";
}
