"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { runSearch, type FindState } from "@/app/actions/find";
import { JobCard } from "@/components/JobCard";
import { SubmitButton } from "@/components/SubmitButton";
import { TagInput } from "@/components/TagInput";
import {
  EXPERIENCE_LEVELS,
  SCRAPER_BOARDS,
  SOURCE_HINTS,
  SOURCE_OPTIONS,
  supportsFilters,
} from "@/lib/boards";
import type { Profile } from "@/lib/db/schema";

const initialState: FindState = { status: "idle", message: "" };

export function FindForm({ profile }: { profile: Profile }) {
  const [state, formAction] = useActionState(runSearch, initialState);

  const [board, setBoard] = useState(profile.searchBoard);
  const [levels, setLevels] = useState<string[]>(profile.searchLevels);
  const [pages, setPages] = useState(profile.searchPages);
  const [hours, setHours] = useState(profile.searchHours);
  const [capYears, setCapYears] = useState(profile.searchMaxYears !== null);
  const [maxYears, setMaxYears] = useState(profile.searchMaxYears ?? 5);

  // Shown before you commit to a run: the scrapers do one HTTP round trip per
  // title-location-page with a polite delay between them, so five titles
  // across three cities is not the same job as one across one.
  const [titleCount, setTitleCount] = useState(profile.targetRoles.length);
  const [locationCount, setLocationCount] = useState(profile.cities.length);

  const filtersApply = supportsFilters(board);
  const scraping = SCRAPER_BOARDS.includes(board);
  const searches = titleCount * locationCount;
  // Scraping costs a request and a delay PER POSTING (each one's description
  // is its own fetch), not per page -- the old estimate counted pages only
  // and so promised two minutes for a run that took over seven. Estimated
  // from postings instead, and capped because the run now stops at
  // SCRAPE_LIMIT postings however many searches are queued behind it.
  const POSTINGS_PER_PAGE = 10;
  const SECONDS_PER_POSTING = 1.6;
  const SCRAPE_LIMIT = 30;
  const postings = Math.min(searches * pages * POSTINGS_PER_PAGE, SCRAPE_LIMIT);
  const scrapeSeconds = postings * SECONDS_PER_POSTING;
  // Scoring is the longer half and was missing from this estimate entirely,
  // which is why a 5.5-minute run was advertised as "roughly 1 minute".
  // It is quota-bound, not compute-bound: batches of BATCH_SIZE go out
  // MAX_RATING_WORKERS at a time (5 and 2 in job_scout/config.py), so the
  // cost is the number of sequential waves, not the number of postings.
  const RATING_BATCH = 5;
  const RATING_WORKERS = 2;
  const SECONDS_PER_WAVE = 85;
  const ratingSeconds =
    Math.ceil(Math.ceil(postings / RATING_BATCH) / RATING_WORKERS) * SECONDS_PER_WAVE;
  const minutes = Math.max(1, Math.round((scrapeSeconds + ratingSeconds) / 60));
  // Long only when the cap is not what ends it -- once the run stops at the
  // cap, adding titles costs nothing, so warning about it would be wrong.
  const longRun = scraping && searches * pages * POSTINGS_PER_PAGE > SCRAPE_LIMIT * 2;

  const toggleLevel = (level: string) =>
    setLevels((current) =>
      current.includes(level) ? current.filter((item) => item !== level) : [...current, level],
    );

  return (
    <>
      <form action={formAction} className="mt-8 space-y-6">
        {/* ---------------------------------------------- what to search */}
        <section className="card overflow-hidden">
          <header className="border-b border-line bg-canvas px-6 py-3">
            <h2 className="text-xs font-bold uppercase tracking-widest text-ink-soft">
              What to search for
            </h2>
          </header>

          <div className="grid gap-6 p-6 md:grid-cols-2">
            <TagInput
              name="titles"
              label="Job titles"
              hint="From your CV. Add or remove any."
              initial={profile.targetRoles}
              suggestions={profile.suggestedRoles}
              placeholder="Data Scientist, ML Engineer"
              onChange={(tags) => setTitleCount(tags.length)}
            />
            <TagInput
              name="locations"
              label="Locations"
              hint="Each title is searched once per location."
              initial={profile.cities}
              placeholder="Germany, Berlin, Remote"
              onChange={(tags) => setLocationCount(tags.length)}
            />
          </div>
        </section>

        {/* ------------------------------------------------------ filters */}
        <section className="card overflow-hidden">
          <header className="border-b border-line bg-canvas px-6 py-3">
            <h2 className="text-xs font-bold uppercase tracking-widest text-ink-soft">Filters</h2>
          </header>

          <div className="space-y-6 p-6">
            {/* Source, full width so the four options read as one control. */}
            <div>
              <span className="label">Source</span>
              <div className="mt-2 grid grid-cols-2 gap-1 rounded-lg border border-line bg-canvas p-1 sm:grid-cols-4">
                {SOURCE_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setBoard(option)}
                    aria-pressed={board === option}
                    className={`rounded-md px-3 py-2 text-sm font-semibold transition ${
                      board === option
                        ? "bg-surface text-brand shadow-sm"
                        : "text-ink-soft hover:text-ink"
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
              <input type="hidden" name="board" value={board} />
              <p className="hint max-w-3xl">{SOURCE_HINTS[board]}</p>
            </div>

            <div className="grid gap-6 border-t border-line pt-6 lg:grid-cols-3">
              {/* Experience level ----------------------------------- */}
              <div>
                <span className={`label ${filtersApply ? "" : "text-ink-faint"}`}>
                  Experience level
                </span>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {EXPERIENCE_LEVELS.map((level) => {
                    const on = levels.includes(level);
                    return (
                      <button
                        key={level}
                        type="button"
                        onClick={() => toggleLevel(level)}
                        aria-pressed={on}
                        disabled={!filtersApply}
                        className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold transition
                          disabled:cursor-not-allowed disabled:opacity-40 ${
                            on
                              ? "border-brand bg-brand text-white"
                              : "border-line bg-surface text-ink-soft hover:border-ink-faint"
                          }`}
                      >
                        {level}
                      </button>
                    );
                  })}
                </div>
                {levels.map((level) => (
                  <input key={level} type="hidden" name="levels" value={level} />
                ))}
                <p className="hint">
                  {filtersApply
                    ? "Applied by LinkedIn itself, before results come back."
                    : `Not available on ${board}.`}
                </p>
              </div>

              {/* Recency and depth ---------------------------------- */}
              <div className="space-y-5">
                <div>
                  <label htmlFor="hours" className="label">
                    Posted within
                  </label>
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      id="hours"
                      name="hours"
                      type="number"
                      min={1}
                      max={720}
                      value={hours}
                      onChange={(event) => setHours(Number(event.target.value))}
                      className="field w-28"
                    />
                    <span className="text-sm text-ink-soft">hours</span>
                  </div>
                </div>

                <div>
                  <label htmlFor="pages" className="label">
                    Pages per title
                    <span className="ml-1.5 font-normal text-ink-faint">
                      {pages} · about {pages * 10} postings
                    </span>
                  </label>
                  <input
                    id="pages"
                    name="pages"
                    type="range"
                    min={1}
                    max={10}
                    value={pages}
                    onChange={(event) => setPages(Number(event.target.value))}
                    className="mt-3 w-full accent-brand"
                  />
                </div>
              </div>

              {/* Years cap ------------------------------------------ */}
              <div>
                <label
                  className={`flex items-start gap-3 ${
                    filtersApply ? "cursor-pointer" : "cursor-not-allowed"
                  }`}
                >
                  <input
                    type="checkbox"
                    name="capYears"
                    checked={capYears}
                    onChange={(event) => setCapYears(event.target.checked)}
                    disabled={!filtersApply}
                    className="mt-0.5 h-4 w-4 rounded border-line accent-brand disabled:opacity-40"
                  />
                  <span>
                    <span className={`label ${filtersApply ? "" : "text-ink-faint"}`}>
                      Cap years of experience
                    </span>
                    <span className="hint block">
                      Drops postings demanding more than the maximum below.
                    </span>
                  </span>
                </label>

                <div className="mt-4 flex items-center gap-2">
                  <input
                    id="maxYears"
                    name="maxYears"
                    type="number"
                    min={0}
                    max={15}
                    value={maxYears}
                    disabled={!capYears || !filtersApply}
                    onChange={(event) => setMaxYears(Number(event.target.value))}
                    className="field w-28 disabled:opacity-40"
                    aria-label="Maximum years required"
                  />
                  <span className="text-sm text-ink-soft">years maximum</span>
                </div>
              </div>
            </div>
          </div>

          {/* Summary + submit ------------------------------------- */}
          <footer className="border-t border-line bg-canvas p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="text-sm text-ink-soft">
                {scraping ? (
                  <>
                    <span className="font-semibold text-ink">
                      {searches} {searches === 1 ? "search" : "searches"}
                    </span>{" "}
                    ({titleCount} {titleCount === 1 ? "title" : "titles"} × {locationCount}{" "}
                    {locationCount === 1 ? "location" : "locations"}) on {board}, {pages}{" "}
                    {pages === 1 ? "page" : "pages"} each — roughly {minutes}{" "}
                    {minutes === 1 ? "minute" : "minutes"}.
                  </>
                ) : (
                  <>
                    <span className="font-semibold text-ink">Six boards</span> searched at once —
                    about a minute.
                  </>
                )}{" "}
                Up to 30 new postings are scored.
              </p>

              <SubmitButton pendingText="Fetching and scoring..." className="btn-primary px-8">
                Fetch jobs
              </SubmitButton>
            </div>

            {longRun && (
              <p className="mt-3 text-sm text-stretch">
                That is more searches than one run can get through. It stops once it has
                enough postings, so the later titles may never be searched — run them
                separately if they matter.
              </p>
            )}
          </footer>
        </section>
      </form>

      {/* ------------------------------------------------------- results */}
      {state.status !== "idle" && (
        <section className="mt-8">
          <div
            role="status"
            className={`card p-6 ${state.status === "error" ? "border-danger/30 bg-danger-soft" : ""}`}
          >
            <p className={`font-semibold ${state.status === "error" ? "text-danger" : ""}`}>
              {state.message}
            </p>
            {state.hint && <p className="hint mt-2 max-w-3xl">{state.hint}</p>}

            {state.stats && state.stats.length > 0 && (
              <div className="mt-5 flex flex-wrap gap-2">
                {state.stats.map((stat) => (
                  <div
                    key={stat.label}
                    className="rounded-lg border border-line bg-surface px-4 py-2.5 text-center"
                  >
                    <div className="text-lg font-bold leading-none">{stat.value}</div>
                    <div className="mt-1 text-xs font-medium text-ink-soft">{stat.label}</div>
                  </div>
                ))}
              </div>
            )}

            {state.perSearch && state.perSearch.length > 1 && (
              <div className="mt-5 border-t border-line pt-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                  Per search
                </p>
                <p className="hint">
                  One aggregate number hides this: different titles have very different pools on
                  LinkedIn at any moment, and it can be a wide gap.
                </p>
                <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                  {state.perSearch.map((s) => (
                    <div
                      key={`${s.title}::${s.location}`}
                      className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-1.5 text-sm"
                    >
                      <span className="truncate text-ink-soft">
                        {s.title} <span className="text-ink-faint">· {s.location}</span>
                      </span>
                      <span
                        className={`shrink-0 font-semibold ${
                          s.failed ? "text-danger" : s.scraped === 0 ? "text-ink-faint" : "text-ink"
                        }`}
                      >
                        {s.failed ? "failed" : s.scraped}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {state.results && state.results.length > 0 && (
            <div className="mt-8">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-xl font-bold tracking-tight">
                  Found {state.results.length} {state.results.length === 1 ? "job" : "jobs"}
                </h2>
                <Link href="/feed" className="text-sm font-semibold text-brand hover:underline">
                  See all your jobs →
                </Link>
              </div>
              <p className="hint">
                Already saved to your feed, best match first. Nothing here is scored twice.
              </p>

              <div className="mt-5 space-y-4">
                {state.results.map((item) => (
                  <JobCard key={item.id} item={item} />
                ))}
              </div>
            </div>
          )}
        </section>
      )}
    </>
  );
}
