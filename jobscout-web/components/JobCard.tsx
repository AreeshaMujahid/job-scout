"use client";

import Link from "next/link";

import { CompanyMark } from "@/components/CompanyMark";
import { StatusButtons } from "@/components/StatusButtons";
import type { JobView } from "@/lib/jobview";
import { isEarly, levelOf } from "@/lib/signals";
import { isFresh, postedAge, VERDICT, verdictOf } from "@/lib/score";

/**
 * One job in a list, laid out the way a job board lays one out.
 *
 * The score sits top-right in its own blue panel, because it is the only
 * thing on the card this app produced rather than copied, and it is the
 * reason to read one card rather than the next. Underneath the headline
 * number are the three parts it is made of: a bare 88 is a number you either
 * trust or you do not, while "skills 100, experience 100, industry 64" says
 * the gap is the sector rather than you -- a different decision entirely.
 * Those three have been stored since the first release and never shown.
 *
 * Everything below is quoted, not inferred. The chips are the board's own
 * labels, and where a posting says nothing the row is absent rather than
 * filled with "not stated" -- an empty cell is honest, an invented one is
 * not.
 *
 * Kept deliberately short. A feed is a list to scan, and everything that
 * reads rather than scans -- the skills asked for, the match count, the
 * pitch written for this job -- is one click away on the job page, where
 * there is room for it. What stays here is what decides whether to click:
 * who, where, how senior, how well it scores and why.
 *
 * A client component so the feed (server-rendered from Postgres) and the
 * search results (client state after a fetch) can both use it.
 */

/** Country flag for a location string, or "" when nothing matches.
 *
 * Deliberately small and literal. A location arrives as free text ("Wien",
 * "West Bromwich, West Midlands", "Remote - EU"), so anything clever guesses
 * wrong, and a wrong flag beside a real city reads as a bug. Only the places
 * this app actually searches are listed; everything else simply gets no flag.
 */
const FLAGS: [RegExp, string][] = [
  [/\b(germany|deutschland|berlin|münchen|munich|hamburg|frankfurt|köln|cologne|stuttgart|düsseldorf|leipzig|dresden|nürnberg|nuremberg|bremen|hannover)\b/i, "🇩🇪"],
  [/\b(austria|österreich|wien|vienna|graz|salzburg|linz)\b/i, "🇦🇹"],
  [/\b(switzerland|schweiz|zürich|zurich|geneva|genf|basel|bern|lausanne)\b/i, "🇨🇭"],
  [/\b(united kingdom|uk|england|scotland|wales|london|manchester|birmingham|edinburgh|bristol|leeds|glasgow|cambridge|oxford|kent|midlands)\b/i, "🇬🇧"],
  [/\b(ireland|dublin|cork)\b/i, "🇮🇪"],
  [/\b(netherlands|nederland|amsterdam|rotterdam|utrecht|eindhoven|hague)\b/i, "🇳🇱"],
  [/\b(france|paris|lyon|toulouse|nantes)\b/i, "🇫🇷"],
  [/\b(spain|españa|madrid|barcelona|valencia)\b/i, "🇪🇸"],
  [/\b(poland|polska|warsaw|warszawa|kraków|krakow|wrocław)\b/i, "🇵🇱"],
  [/\b(united states|usa|u\.s\.|new york|san francisco|seattle|austin|boston|chicago|los angeles|denver|atlanta)\b/i, "🇺🇸"],
  [/\b(canada|toronto|vancouver|montreal|ottawa|calgary)\b/i, "🇨🇦"],
  [/\b(india|bangalore|bengaluru|mumbai|delhi|hyderabad|pune)\b/i, "🇮🇳"],
  [/\b(pakistan|karachi|lahore|islamabad|rawalpindi)\b/i, "🇵🇰"],
];

function flagFor(location: string): string {
  if (!location) return "";
  for (const [pattern, flag] of FLAGS) if (pattern.test(location)) return flag;
  return "";
}

/* Inline SVGs rather than an icon package: a handful of glyphs do not justify
   a dependency, and these inherit currentColor so they follow the text. */
const ICON = "h-4 w-4 shrink-0 text-ink-faint";

function PinIcon() {
  return (
    <svg className={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0Z" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg className={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9.5Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LevelIcon() {
  return (
    <svg className={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WalletIcon() {
  return (
    <svg className={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18" strokeLinecap="round" />
      <circle cx="16.5" cy="14.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg className={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" strokeLinecap="round" />
    </svg>
  );
}

function SourceIcon() {
  return (
    <svg className={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.6 2.8 2.6 15.2 0 18M12 3c-2.6 2.8-2.6 15.2 0 18" strokeLinecap="round" />
    </svg>
  );
}

/** The tracker state, phrased for a card rather than a button. */
const TRACKER_WORDS: Record<string, string> = {
  saved: "Saved",
  applied: "Applied",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  dismissed: "Not interested",
};

/**
 * One fact, with its glyph.
 *
 * Renders nothing at all when there is no fact, rather than "not stated".
 * These flow rather than sit in fixed cells, so a posting with no salary
 * closes up instead of leaving a hole. The icons are the labels, and a row
 * of them reads as one sentence about the job.
 */
function Fact({ icon, children }: { icon: React.ReactNode; children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <span className="flex min-w-0 items-center gap-2 text-sm text-ink">
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * One part of the score, as a labelled row.
 *
 * The number is the point, so it is the heaviest thing in the row and sits
 * hard right where the eye can run down all three. Tabular figures keep 69
 * and 100 in the same column.
 */
function Part({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="truncate text-sm text-ink-soft">{label}</span>
      <span className="shrink-0 text-base font-bold tabular-nums text-ink">
        {value}
        <span className="text-xs font-semibold text-ink-soft">%</span>
      </span>
    </div>
  );
}

export function JobCard({ item }: { item: JobView }) {
  const key = verdictOf(item.verdict);
  const verdict = VERDICT[key];
  const age = postedAge(item.postedAt);
  const flag = flagFor(item.location);

  return (
    <article className="card group overflow-hidden p-5 transition hover:shadow-md">
      {/* -------------------------------------------- header + the score */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        {/* The posting. The facts sit in this column rather than below the
            row: the score panel is much taller than a title, so a facts row
            placed after the row began beneath the panel and left a hole in
            the left column exactly as tall as the panel. */}
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <CompanyMark company={item.company} logoUrl={item.logoUrl} />

            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                {item.companyUrl ? (
                  <a
                    href={item.companyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-ink hover:text-brand hover:underline"
                  >
                    {item.company}
                  </a>
                ) : (
                  <span className="font-semibold text-ink">{item.company}</span>
                )}
                {age && (
                  <>
                    <span className="text-ink-faint" aria-hidden="true">
                      ·
                    </span>
                    <span className="text-ink-soft">{age}</span>
                  </>
                )}
                {isEarly(item.postedAt) ? (
                  <span className="rounded-md bg-match-tint px-2 py-0.5 text-xs font-semibold text-match-ink">
                    Early applicant
                  </span>
                ) : (
                  isFresh(item.postedAt) && (
                    <span className="rounded-md bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand">
                      New
                    </span>
                  )
                )}
                {item.status && (
                  <span className="rounded-md border border-line px-2 py-0.5 text-xs font-semibold text-ink-soft">
                    {TRACKER_WORDS[item.status] ?? item.status}
                  </span>
                )}
              </p>

              <h3 className="mt-1 text-xl font-bold tracking-tight">
                <Link href={`/jobs/${item.id}`} className="transition group-hover:text-brand hover:underline">
                  {item.title}
                </Link>
              </h3>
            </div>
          </div>

        {/* ---------------------------------------------------------- facts */}
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
          <Fact icon={<PinIcon />}>
            {item.location ? (
              <>
                {item.location}
                {flag && <span aria-hidden="true"> {flag}</span>}
              </>
            ) : null}
          </Fact>
          <Fact icon={<HomeIcon />}>{item.remote ? "Remote" : "Onsite"}</Fact>
          <Fact icon={<LevelIcon />}>{levelOf(item.title)}</Fact>
          <Fact icon={<CalendarIcon />}>
            {item.yearsRequired !== null ? `${item.yearsRequired}+ years exp` : null}
          </Fact>
          <Fact icon={<WalletIcon />}>{item.salary || null}</Fact>
          <Fact icon={<SourceIcon />}>{item.source}</Fact>
        </div>
        </div>

        {/* The match panel. Headline and verdict on the deeper tint, the
            three parts beneath on the lighter one -- one blue family, so it
            reads as a single object rather than two stacked boxes. */}
        <div className="w-full shrink-0 overflow-hidden rounded-xl bg-match-soft sm:w-72">
          <div className="flex items-center justify-between gap-3 bg-match-tint px-4 py-3">
            <span className="text-3xl font-extrabold leading-none tabular-nums text-ink">
              {item.score}
              <span className="text-base font-bold">%</span>
            </span>
            <span className="text-right text-xs font-bold uppercase tracking-wide text-match-ink">
              {verdict.label}
            </span>
          </div>
          <div className="space-y-1.5 px-4 py-3">
            <Part label="Experience Level" value={item.experienceMatch} />
            <Part label="Skill" value={item.skillsMatch} />
            <Part label="Industry Exp." value={item.domainMatch} />
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------------- tags */}
      {item.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {item.tags.slice(0, 6).map((tag) => (
            <span
              key={tag}
              className="rounded-md bg-match-soft px-2.5 py-1 text-xs font-medium text-match-ink"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* ------------------------------------ what the posting says it does */}
      {item.sponsorship !== null && (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          {item.sponsorship === "offers" && (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-match-tint px-2.5 py-1 font-semibold text-match-ink">
              <span aria-hidden="true">✓</span> Sponsorship likely
            </span>
          )}
          {item.sponsorship === "refuses" && (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-canvas px-2.5 py-1 font-semibold text-ink-soft">
              <span aria-hidden="true">✕</span> No sponsorship
            </span>
          )}
        </div>
      )}

      {/* -------------------------------------------------------- actions */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <Link href={`/jobs/${item.id}`} className="text-sm font-semibold text-brand hover:underline">
          See the full match →
        </Link>
        <StatusButtons jobId={item.id} current={item.status} size="small" />
      </div>
    </article>
  );
}
