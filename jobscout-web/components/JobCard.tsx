"use client";

import Link from "next/link";

import { StatusButtons } from "@/components/StatusButtons";
import type { JobView } from "@/lib/jobview";
import { isFresh, postedAge, scoreText, VERDICT, verdictOf } from "@/lib/score";

/**
 * One job in a list. Shows the score and the single best reason to apply --
 * enough to decide whether to open it, and no more. The full argument is on
 * the detail page, because a list of six-bullet cases is not a list.
 *
 * A client component so the feed (server-rendered from Postgres) and the
 * search results (held in client state after a fetch) can both use it.
 *
 * Laid out as a job-board card: accent edge, a company monogram, and the
 * facts on one icon-led line. The score keeps the top-right corner, which on
 * an ordinary board holds the company logo -- here the fit score is the
 * reason to look at one card over another, so it takes the strongest spot.
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

/** Which board a job was found on, as its own badge rather than a plain grey
 *  chip lost among skill tags -- "where did this come from" is orientation
 *  info worth seeing before the reader even reads the title.
 *
 *  One colour per board, all eight this app can actually return (see
 *  SCRAPER_BOARDS and BOARDS in job_scout/sources/boards.py) -- picked for
 *  contrast against each other, not sampled from any board's real branding,
 *  so this never gets into reproducing someone else's logo colours. Falls
 *  back to a neutral grey for anything not in the list, so a new board added
 *  later never renders unstyled. */
const SOURCE_COLORS: Record<string, string> = {
  LinkedIn: "bg-[#0A66C2]/10 text-[#0A66C2]",
  Xing: "bg-[#00805F]/10 text-[#00805F]",
  Arbeitnow: "bg-[#EA580C]/10 text-[#EA580C]",
  Remotive: "bg-[#7C3AED]/10 text-[#7C3AED]",
  RemoteOK: "bg-[#334155]/10 text-[#334155]",
  Jobicy: "bg-[#2563EB]/10 text-[#2563EB]",
  "The Muse": "bg-[#DC2626]/10 text-[#DC2626]",
  Himalayas: "bg-[#CA8A04]/10 text-[#CA8A04]",
};
const DEFAULT_SOURCE_COLOR = "bg-ink-faint/10 text-ink-soft";

function sourceColor(source: string): string {
  return SOURCE_COLORS[source] ?? DEFAULT_SOURCE_COLOR;
}

/** Company monogram. Skips the legal-form noise ("GmbH", "Ltd") that would
 *  otherwise make half the cards read "G" or "L". */
function monogram(company: string): string {
  const words = company
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !/^(gmbh|ag|ltd|limited|inc|llc|plc|bv|nv|sa|se|co|group|holding|the)$/i.test(w));
  const source = words.length ? words : company.split(/\s+/).filter(Boolean);
  return source.slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";
}

/* Inline SVGs rather than an icon package: three glyphs do not justify a
   dependency, and these inherit currentColor so they follow the text. */
const ICON = "h-3.5 w-3.5 shrink-0";

function PinIcon() {
  return (
    <svg className={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 1 1 16 0Z" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function BuildingIcon() {
  return (
    <svg className={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M3 21h18M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M15 21V9h2a2 2 0 0 1 2 2v10" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 7h2M9 11h2M9 15h2" strokeLinecap="round" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg className={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Recognisable marks for the two boards asked for by name: a coloured
 *  rounded square with the platform's own initial, the same treatment
 *  "Sign in with LinkedIn" buttons use everywhere on the web -- built as
 *  plain shapes in each platform's real brand colour, not a traced copy of
 *  an official logo file, and used here only to say where a listing came
 *  from. Every other board keeps the plain coloured-text pill below. */
function LinkedInMark() {
  return (
    <svg className="h-4 w-4 shrink-0 rounded-[3px]" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="4" fill="#0A66C2" />
      <text x="12" y="16.5" textAnchor="middle" fontSize="12" fontWeight="700" fontFamily="Arial, Helvetica, sans-serif" fill="#fff">
        in
      </text>
    </svg>
  );
}

function XingMark() {
  return (
    <svg className="h-4 w-4 shrink-0 rounded-[3px]" viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="4" fill="#00805F" />
      <text x="12" y="16.5" textAnchor="middle" fontSize="13" fontWeight="700" fontFamily="Arial, Helvetica, sans-serif" fill="#fff">
        X
      </text>
    </svg>
  );
}

const SOURCE_ICONS: Partial<Record<string, typeof LinkedInMark>> = {
  LinkedIn: LinkedInMark,
  Xing: XingMark,
};

function WalletIcon() {
  return (
    <svg className={ICON} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18" strokeLinecap="round" />
      <circle cx="16.5" cy="14.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function JobCard({ item }: { item: JobView }) {
  const verdict = VERDICT[verdictOf(item.verdict)];
  const age = postedAge(item.postedAt);
  const flag = flagFor(item.location);
  const SourceMark = SOURCE_ICONS[item.source];

  return (
    <article className="card group border-l-4 border-l-brand p-5 transition hover:border-ink-faint hover:border-l-brand hover:shadow-sm">
      {/* Badge row, kept above the title so the eye meets freshness first --
          the same reason a board leads with "New". */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2.5 text-xs font-semibold ${sourceColor(item.source)} ${SourceMark ? "pl-0.5" : "pl-2.5"}`}
          >
            {SourceMark && <SourceMark />}
            {item.source}
          </span>
          {isFresh(item.postedAt) && (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2.5 py-0.5 text-xs font-semibold text-brand">
              <span aria-hidden="true">✦</span> New
            </span>
          )}
          {item.remote && (
            <span className="inline-flex items-center rounded-full bg-strong/10 px-2.5 py-0.5 text-xs font-semibold text-strong">
              Remote
            </span>
          )}
        </div>

        <div className="shrink-0 text-right">
          <div className={`text-3xl font-bold leading-none ${scoreText(item.score)}`}>
            {item.score}
          </div>
          <div className={`mt-1 text-xs font-semibold ${verdict.text}`}>{verdict.label}</div>
        </div>
      </div>

      <div className="mt-3 flex items-start gap-3">
        <div
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-sm font-bold text-brand"
          aria-hidden="true"
        >
          {monogram(item.company)}
        </div>

        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold sm:text-lg">
            <Link href={`/jobs/${item.id}`} className="transition group-hover:text-brand hover:underline">
              {item.title}
            </Link>
          </h3>

          {/* The company name links to the employer's own page when the
              listing gave one. Opens in a new tab and carries rel=noreferrer:
              this is an outbound link to a third party, and the reader is
              mid-triage on a list they will come back to. */}
          <p className="mt-1 flex items-center gap-1.5 truncate text-sm font-medium text-ink">
            <BuildingIcon />
            {item.companyUrl ? (
              <a
                href={item.companyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate hover:text-brand hover:underline"
                title={`${item.company} on ${item.source}`}
              >
                {item.company}
              </a>
            ) : (
              <span className="truncate">{item.company}</span>
            )}
          </p>

          {/* One line of facts, each led by its own glyph. Wraps rather than
              truncates: a salary is worth a second line, and a card that hides
              it is a card you have to open to rule out. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-soft">
            <span className="inline-flex items-center gap-1.5">
              <PinIcon />
              {item.location || "location not stated"}
              {flag && <span aria-hidden="true">{flag}</span>}
            </span>

            {item.salary && (
              <span className="inline-flex items-center gap-1.5">
                <WalletIcon />
                {item.salary}
              </span>
            )}

            {age && (
              <span className="inline-flex items-center gap-1.5 text-brand">
                <ClockIcon />
                {age}
              </span>
            )}
          </div>
        </div>
      </div>

      {item.whyPick[0] && (
        <p className="mt-4 line-clamp-2 text-sm leading-relaxed text-ink-soft">
          <span className="font-semibold text-ink">Why: </span>
          {item.whyPick[0]}
        </p>
      )}

      {item.missingSkills.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold text-ink-faint">Missing:</span>
          {item.missingSkills.slice(0, 4).map((skill) => (
            <span key={skill} className="chip">
              {skill}
            </span>
          ))}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <StatusButtons jobId={item.id} current={item.status} size="small" />
        <Link
          href={`/jobs/${item.id}`}
          className="text-sm font-semibold text-brand hover:underline"
        >
          See the full match →
        </Link>
      </div>
    </article>
  );
}
