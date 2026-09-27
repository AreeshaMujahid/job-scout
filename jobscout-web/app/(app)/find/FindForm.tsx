"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";

import { runProgress, runSearch, type FindState, type RunProgress } from "@/app/actions/find";
import { FilterPill, summarise } from "@/components/FilterPill";
import { JobCard } from "@/components/JobCard";
import { SubmitButton } from "@/components/SubmitButton";
import { TagInput } from "@/components/TagInput";
import {
  allowedSources,
  EXPERIENCE_LEVELS,
  API_BOARD_COUNT,
  API_BOARDS,
  DEFAULT_JOBS_PER_RUN,
  MAX_JOBS_PER_RUN,
  planFor,
  sourcesOf,
  SOURCE_HINTS,
  sourcesVisibleTo,
  supportsFilters,
  filterMethod,
} from "@/lib/boards";
import type { Profile } from "@/lib/db/schema";
import type { JobView } from "@/lib/jobview";

const initialState: FindState = { status: "idle", message: "" };

/** How often to ask how the run is going. Slow enough to be free, fast
 *  enough that a chunk landing feels immediate. */
const POLL_MS = 2500;

/** The windows worth one click. Anything else is typed in beside them. */
const PRESET_HOURS = [24, 72, 168, 720];

/** A window of hours, said the way a person would say it. */
function postedLabel(hours: number): string {
  if (hours === 24) return "Last 24 hours";
  if (hours % 24 === 0) {
    const days = hours / 24;
    if (days === 7) return "Last 7 days";
    if (days === 30) return "Last 30 days";
    return `Last ${days} days`;
  }
  return `Last ${hours} hours`;
}

export function FindForm({
  profile,
  lastRun = [],
  isOwner = false,
}: {
  profile: Profile;
  /**
   * Whether this account may use the sources that run on the owner's own
   * logged-in browser. False for everybody else on a shared deployment, so
   * they never see a control that the server would refuse.
   */
  isOwner?: boolean;
  /**
   * What the previous run found, read from the database by the page.
   *
   * Shown until this session runs its own search, so landing here after a
   * refresh still answers "what did I just find?" rather than an empty page
   * under a heading that promises results below.
   */
  lastRun?: JobView[];
}) {
  const [state, formAction] = useActionState(runSearch, initialState);

  /**
   * Watch the run the action started.
   *
   * A run is minutes of waiting on a rate-limited model, so the action hands
   * back an id rather than a result and this asks how it is getting on. The
   * postings it has scored so far come back with every answer, so the list
   * fills in while the rest are still being read.
   *
   * The interval is cleared on unmount and once the run stops: a poll that
   * outlives the page is a request every few seconds forever.
   */
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const watching = useRef<string | null>(null);

  useEffect(() => {
    if (state.status !== "started" || !state.runId) return;
    const id = state.runId;
    // A re-render must not start a second interval for the same run.
    if (watching.current === id) return;
    watching.current = id;

    let live = true;
    const ask = async () => {
      try {
        const next = await runProgress(id);
        if (!live) return;
        setProgress(next);
        if (next.status !== "running") window.clearInterval(timer);
      } catch {
        // A poll that fails is not a run that failed -- a dropped request or
        // a reloading dev server should not wipe the results on screen. The
        // next tick asks again.
      }
    };
    const timer = window.setInterval(ask, POLL_MS);
    void ask();

    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [state.status, state.runId]);

  /**
   * What starts selected -- filtered, not just what is offered.
   *
   * A new profile defaults to LinkedIn, and for anyone who is not the owner
   * that arrived SELECTED while its button was hidden: the pill read
   * "LinkedIn", the panel had no LinkedIn to untick, and every search was
   * refused. Unrecoverable without editing the database. Filtering the
   * selection as well as the options is what closes that.
   */
  const [sources, setSources] = useState<string[]>(() => {
    const allowed = allowedSources(sourcesOf(profile), isOwner);
    return allowed.length > 0 ? allowed : ["StepStone"];
  });
  const [limit, setLimit] = useState(profile.searchLimit || DEFAULT_JOBS_PER_RUN);
  const [levels, setLevels] = useState<string[]>(profile.searchLevels);
  const [pages, setPages] = useState(profile.searchPages);
  const [hours, setHours] = useState(profile.searchHours);
  const [capYears, setCapYears] = useState(profile.searchMaxYears !== null);
  const [maxYears, setMaxYears] = useState(profile.searchMaxYears ?? 5);

  // The values, not just how many: a pill has to show WHICH titles are set,
  // and the run estimate still only needs the counts. Shown before you
  // commit to a run because the scrapers do one HTTP round trip per
  // title-location-page with a polite delay between them, so five titles
  // across three cities is not the same job as one across one.
  const [titles, setTitles] = useState<string[]>(profile.targetRoles);
  const [locations, setLocations] = useState<string[]>(profile.cities);
  const titleCount = titles.length;
  const locationCount = locations.length;

  const plan = planFor(sources);
  const scraperCount = plan.scrapers.length;
  const scraping = scraperCount > 0;
  // Any, not every: a run across LinkedIn and Xing still applies the level
  // filter on LinkedIn. Disabling the control because one source ignores it
  // would throw away the filtering the other one does.
  const filtersApply = sources.some(supportsFilters);
  const ignoring = sources.filter((name) => !supportsFilters(name));
  // Each scraped source runs the whole title x location grid of its own.
  const searches = titleCount * locationCount * Math.max(1, scraperCount);
  // Scraping costs a request and a delay PER POSTING (each one's description
  // is its own fetch), not per page -- the old estimate counted pages only
  // and so promised two minutes for a run that took over seven. Estimated
  // from postings instead, and capped because the run now stops at
  // SCRAPE_LIMIT postings however many searches are queued behind it.
  const POSTINGS_PER_PAGE = 10;
  const SECONDS_PER_POSTING = 1.6;
  // Mirrors MAX_SCRAPE_PER_SOURCE and the per-source division in
  // app/actions/find.ts. The budget divides across scraped sources rather
  // than multiplying, so ticking a second scraper roughly holds the time
  // rather than doubling it -- and the estimate has to say the same thing
  // the run will do, or it is just a number.
  const MAX_SCRAPE_PER_SOURCE = 60;
  const perScraper = Math.min(
    MAX_SCRAPE_PER_SOURCE,
    Math.max(10, Math.ceil(limit / Math.max(1, scraperCount))),
  );
  const postings =
    Math.min(titleCount * locationCount * pages * POSTINGS_PER_PAGE, perScraper) * scraperCount;
  const scrapeSeconds = postings * SECONDS_PER_POSTING;
  // Scoring is the longer half and was missing from this estimate entirely,
  // which is why a 5.5-minute run was advertised as "roughly 1 minute".
  // It is quota-bound, not compute-bound: batches of BATCH_SIZE go out
  // MAX_RATING_WORKERS at a time (5 and 2 in job_scout/config.py), so the
  // cost is the number of sequential waves, not the number of postings.
  const RATING_BATCH = 5;
  const RATING_WORKERS = 2;
  const SECONDS_PER_WAVE = 85;
  // The JSON boards return far more than the run will score, so when one is
  // ticked the scoring cost is the setting itself rather than what the
  // scrapers managed to collect.
  const scored = Math.min(limit, plan.searchesApi ? limit : postings);
  const ratingSeconds =
    Math.ceil(Math.ceil(scored / RATING_BATCH) / RATING_WORKERS) * SECONDS_PER_WAVE;
  const minutes = Math.max(1, Math.round((scrapeSeconds + ratingSeconds) / 60));
  // Long only when the cap is not what ends it -- once the run stops at the
  // cap, adding titles costs nothing, so warning about it would be wrong.
  const longRun = scraping && titleCount * locationCount * pages * POSTINGS_PER_PAGE >
    perScraper * 2;

  /**
   * Why this search cannot run, or "" when it can.
   *
   * The summary used to read "0 searches ... roughly 1 minute" with the
   * button still live, so the only way to discover a missing location was to
   * click and be told off. The scrapers search one location at a time and
   * genuinely need one; the job boards take a location as a filter and are
   * happy without.
   */
  const blocker =
    titleCount === 0
      ? "Add at least one job title."
      : sources.length === 0
        ? "Pick at least one source."
        : scraping && locationCount === 0
          ? `Add a location — ${plan.scrapers.join(" and ")} ` +
            `${plan.scrapers.length === 1 ? "searches" : "search"} one location at a time.`
          : "";

  // Tinted only when something inside it actually differs from the default,
  // so the row answers "what have I changed?" without opening anything.
  const moreChanged =
    limit !== DEFAULT_JOBS_PER_RUN || pages !== 3 || capYears;

  // What to show: the poll once it has answered, the action's own reply
  // before that (a run that could not start says so immediately).
  const running = progress ? progress.status === "running" : state.status === "started";
  const failed = progress ? progress.status === "error" : state.status === "error";
  const message = progress?.message || state.message;
  const hint = progress?.hint ?? state.hint;
  const stats = progress?.stats ?? state.stats ?? [];
  const results = progress?.results ?? [];
  const target = progress?.target ?? 0;
  const scoredSoFar = progress?.scored ?? 0;

  const toggleSource = (name: string) =>
    setSources((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
    );

  const toggleLevel = (level: string) =>
    setLevels((current) =>
      current.includes(level) ? current.filter((item) => item !== level) : [...current, level],
    );

  return (
    <>
      <form action={formAction} className="mt-8">
        {/* One row of pills rather than two cards of labelled boxes.
            Eight settings laid out as a form is something to fill in; laid
            out as pills the whole search reads in a line -- "Germany, Data
            Scientist (+3), 4 sources, last 24 hours" -- and only the one
            being changed opens.

            Every panel stays mounted when closed (see FilterPill): the
            controls inside carry the form's hidden inputs, so unmounting one
            would submit a search with no titles rather than failing. */}
        <div className="card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <FilterPill
              label="Locations"
              summary={summarise(locations, "Locations")}
              active={locationCount > 0}
            >
              <TagInput
                name="locations"
                label="Locations"
                hint="Each title is searched once per location."
                initial={profile.cities}
                placeholder="Germany, Berlin, Remote"
                onChange={setLocations}
              />
            </FilterPill>

            <FilterPill
              label="Job titles"
              summary={summarise(titles, "Job titles")}
              active={titleCount > 0}
            >
              <TagInput
                name="titles"
                label="Job titles"
                hint="From your CV. Add or remove any."
                initial={profile.targetRoles}
                suggestions={profile.suggestedRoles}
                placeholder="Data Scientist, ML Engineer"
                onChange={setTitles}
              />
            </FilterPill>

            {/* Several sources at once, because the boards do not overlap: a
                run on StepStone alone misses every LinkedIn posting, and
                finding that out means running the search twice. */}
            <FilterPill
              label="Sources"
              summary={
                sources.length > 2
                  ? `${sources.length} sources`
                  : summarise(sources, "Sources")
              }
              active={sources.length > 0}
              wide
            >
              <div className="flex flex-wrap gap-1.5">
                {sourcesVisibleTo(isOwner).map((option) => {
                  const on = sources.includes(option);
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => toggleSource(option)}
                      aria-pressed={on}
                      className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold transition ${
                        on
                          ? "border-brand bg-brand text-white"
                          : "border-line bg-surface text-ink-soft hover:border-ink-faint"
                      }`}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
              {sources.map((name) => (
                <input key={name} type="hidden" name="boards" value={name} />
              ))}
              {/* One hint per source rather than a merged paragraph: each
                  says something different about what that board can and
                  cannot do, and blending them loses the caveat someone
                  needed. */}
              <div className="mt-3 max-h-56 space-y-2 overflow-y-auto">
                {sources.map((name) => (
                  <p key={name} className="hint">
                    <span className="font-semibold text-ink">{name}. </span>
                    {SOURCE_HINTS[name]}
                  </p>
                ))}
              </div>
            </FilterPill>

            <FilterPill
              label="Experience level"
              summary={summarise(levels, "Experience level")}
              active={levels.length > 0}
            >
              <div className="flex flex-wrap gap-1.5">
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
              <p className="hint mt-3">
                {!filtersApply
                  ? `Not available on ${sources.join(" or ")}.`
                  : ignoring.length > 0
                    ? `${filterMethod(plan.scrapers.find(supportsFilters) ?? "LinkedIn")} ` +
                      `Ignored by ${ignoring.join(" and ")}, which ` +
                      `${ignoring.length === 1 ? "has" : "have"} no such filter.`
                    : filterMethod(sources[0])}
              </p>
            </FilterPill>

            <FilterPill label="Date posted" summary={postedLabel(hours)} active>
              <div className="flex flex-wrap gap-1.5">
                {PRESET_HOURS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setHours(preset)}
                    aria-pressed={hours === preset}
                    className={`rounded-md border px-2.5 py-1.5 text-xs font-semibold transition ${
                      hours === preset
                        ? "border-brand bg-brand text-white"
                        : "border-line bg-surface text-ink-soft hover:border-ink-faint"
                    }`}
                  >
                    {postedLabel(preset)}
                  </button>
                ))}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <input
                  id="hours"
                  name="hours"
                  type="number"
                  min={1}
                  max={720}
                  value={hours}
                  onChange={(event) => setHours(Number(event.target.value))}
                  className="field w-24"
                />
                <span className="text-sm text-ink-soft">hours</span>
              </div>
              {/* Measured, and the single biggest lever on how much a run
                  finds: a 24-hour StepStone search had 2 unseen postings
                  where a 7-day one had 24. */}
              <p className="hint mt-2">
                The setting that most often makes a run look empty. Widen it first.
              </p>
            </FilterPill>

            <FilterPill label="More filters" summary="More filters" active={moreChanged} wide>
              <div className="space-y-5">
                <div>
                  <label htmlFor="limit" className="label">
                    Jobs to score
                  </label>
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      id="limit"
                      name="limit"
                      type="number"
                      min={1}
                      max={MAX_JOBS_PER_RUN}
                      value={limit}
                      onChange={(event) => setLimit(Number(event.target.value))}
                      className="field w-24"
                    />
                    <span className="text-sm text-ink-soft">per run, at most</span>
                  </div>
                  <p className="hint">
                    Only postings not already in your feed are scored, so a repeat search
                    uses far fewer than this.
                  </p>
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
                  <div className="mt-3 flex items-center gap-2">
                    <input
                      id="maxYears"
                      name="maxYears"
                      type="number"
                      min={0}
                      max={15}
                      value={maxYears}
                      disabled={!capYears || !filtersApply}
                      onChange={(event) => setMaxYears(Number(event.target.value))}
                      className="field w-24 disabled:opacity-40"
                      aria-label="Maximum years required"
                    />
                    <span className="text-sm text-ink-soft">years maximum</span>
                  </div>
                </div>
              </div>
            </FilterPill>
          </div>

          {/* Summary + submit ------------------------------------------- */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-4">
            <p className="text-sm text-ink-soft">
              {/* An estimate for a search that cannot run is worse than no
                  estimate: "0 searches -- roughly 1 minute" reads as a
                  working plan. When something is missing, say that. */}
              {blocker ? (
                <span className="font-semibold text-ink">{blocker}</span>
              ) : (
                <>
                  <span className="font-semibold text-ink">
                    {sources.includes(API_BOARDS)
                      ? `${sources.length - 1 + API_BOARD_COUNT} boards`
                      : `${sources.length} ${sources.length === 1 ? "source" : "sources"}`}
                  </span>{" "}
                  {scraping ? (
                    <>
                      — {searches} scraped {searches === 1 ? "search" : "searches"} (
                      {titleCount} {titleCount === 1 ? "title" : "titles"} × {locationCount}{" "}
                      {locationCount === 1 ? "location" : "locations"}
                      {scraperCount > 1 ? ` × ${scraperCount} boards` : ""}), {pages}{" "}
                      {pages === 1 ? "page" : "pages"} each — roughly {minutes}{" "}
                      {minutes === 1 ? "minute" : "minutes"}.
                    </>
                  ) : (
                    <>searched — about a minute.</>
                  )}{" "}
                  Up to {limit} new {limit === 1 ? "posting is" : "postings are"} scored.
                </>
              )}
            </p>

            <SubmitButton
              pendingText="Fetching and scoring..."
              className="btn-primary px-8"
              disabled={Boolean(blocker)}
            >
              Fetch jobs
            </SubmitButton>
          </div>

          {longRun && (
            <p className="mt-3 text-sm text-stretch">
              That is more searches than one run can get through. Each scraped source
              stops once it has {perScraper} postings, so the later titles may never be
              searched — raise &ldquo;Jobs to score&rdquo; or run them separately if they
              matter.
            </p>
          )}
        </div>
      </form>

      {/* --------------------------------------- the run before this one */}
      {state.status === "idle" && lastRun.length > 0 && (
        <section className="mt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-xl font-bold tracking-tight">Your last search</h2>
            <Link href="/feed" className="text-sm font-semibold text-brand hover:underline">
              See all your jobs →
            </Link>
          </div>
          <p className="hint">
            {lastRun.length} {lastRun.length === 1 ? "job" : "jobs"} from the last time you
            pressed Fetch, best match first. Running a new search replaces these.
          </p>

          <div className="mt-5 space-y-4">
            {lastRun.map((item) => (
              <JobCard key={item.id} item={item} />
            ))}
          </div>
        </section>
      )}

      {/* ------------------------------------------------------- results */}
      {state.status !== "idle" && (
        <section className="mt-8">
          <div
            role="status"
            className={`card p-6 ${state.status === "error" ? "border-danger/30 bg-danger-soft" : ""}`}
          >
            <p className={`font-semibold ${failed ? "text-danger" : ""}`}>{message}</p>
            {hint && <p className="hint mt-2 max-w-3xl">{hint}</p>}

            {/* A bar, because "scoring 24 of 40" is a different experience
                from a spinner: it says the thing is moving and roughly how
                much is left. Only once the run knows its own size -- before
                that the honest display is the message alone. */}
            {running && target > 0 && (
              <div className="mt-4">
                <div className="h-2 overflow-hidden rounded-full bg-canvas">
                  <div
                    className="h-full rounded-full bg-brand transition-all duration-500"
                    style={{ width: `${Math.min(100, Math.round((scoredSoFar / target) * 100))}%` }}
                  />
                </div>
                <p className="hint mt-1.5">
                  {scoredSoFar} of {target} scored. You can leave this page — the run keeps going,
                  and everything lands in your feed.
                </p>
              </div>
            )}

            {stats.length > 0 && (
              <div className="mt-5 flex flex-wrap gap-2">
                {stats.map((stat) => (
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

          {results.length > 0 && (
            <div className="mt-8">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-xl font-bold tracking-tight">
                  {running ? "Scored so far" : `Found ${results.length}`}{" "}
                  {running ? `(${results.length})` : results.length === 1 ? "job" : "jobs"}
                </h2>
                <Link href="/feed" className="text-sm font-semibold text-brand hover:underline">
                  See all your jobs →
                </Link>
              </div>
              <p className="hint">
                Already saved to your feed, best match first. Nothing here is scored twice.
              </p>

              <div className="mt-5 space-y-4">
                {results.map((item) => (
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
