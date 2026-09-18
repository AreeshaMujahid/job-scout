import type { JobStatus } from "@/lib/db/schema";

/**
 * Class names are written out in full rather than built from fragments --
 * Tailwind scans source text, so `text-${verdict}` compiles to nothing.
 */
export const VERDICT = {
  strong: { label: "Strong match", text: "text-strong", bg: "bg-strong/10", border: "border-strong/30" },
  good: { label: "Good match", text: "text-good", bg: "bg-good/10", border: "border-good/30" },
  stretch: { label: "Stretch", text: "text-stretch", bg: "bg-stretch/10", border: "border-stretch/30" },
  weak: { label: "Weak", text: "text-weak", bg: "bg-weak/10", border: "border-weak/30" },
} as const;

export type Verdict = keyof typeof VERDICT;

export function verdictOf(value: string): Verdict {
  return value in VERDICT ? (value as Verdict) : "weak";
}

export function scoreText(score: number): string {
  if (score >= 80) return "text-strong";
  if (score >= 65) return "text-good";
  if (score >= 50) return "text-stretch";
  return "text-weak";
}

export const STATUS_LABELS: Record<JobStatus, string> = {
  saved: "Saved",
  applied: "Applied",
  interviewing: "Interviewing",
  offer: "Offer",
  rejected: "Rejected",
  dismissed: "Not interested",
};

/** The order the tracker shows columns in: how far along you are. */
export const TRACKER_ORDER: JobStatus[] = [
  "saved",
  "applied",
  "interviewing",
  "offer",
  "rejected",
];

/**
 * How long ago a posting went up, in the words a person would use.
 *
 * Separate from `timeAgo` because that one counts in whole days, which is the
 * right grain for "you saved this three days ago" and the wrong one for a job
 * ad: the scraper recovers a real time (LinkedIn's `datetime` attribute is
 * date-only, so it prefers the visible "3 hours ago" text and converts it),
 * and applying early matters enough that an hour is worth showing.
 *
 * Falls back to the stored string if it will not parse -- older rows hold a
 * plain "2026-09-04", and a date beats a blank.
 */
export function postedAge(raw: string): string {
  if (!raw) return "";
  const then = new Date(raw);
  if (Number.isNaN(then.getTime())) return raw;

  const minutes = Math.round((Date.now() - then.getTime()) / 60000);
  if (minutes < 0) return "just now";
  if (minutes < 60) return minutes <= 1 ? "just now" : `${minutes} minutes ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? "yesterday" : `${days} days ago`;
  return then.toLocaleDateString();
}

/** Posted within the last day -- what earns the "New" badge. */
export function isFresh(raw: string): boolean {
  if (!raw) return false;
  const then = new Date(raw);
  if (Number.isNaN(then.getTime())) return false;
  return Date.now() - then.getTime() < 86_400_000;
}

/**
 * How long an application sits before it is worth chasing.
 *
 * Ten days is the compromise between the two ways of getting this wrong: a
 * week is often still inside a company's own review cycle, and a month is
 * long enough that the shortlist is already drawn.
 */
export const FOLLOW_UP_AFTER_DAYS = 10;

/** Whole days since a tracker row was last touched. */
export function daysSince(date: Date | string): number {
  const then = typeof date === "string" ? new Date(date) : date;
  return Math.floor((Date.now() - then.getTime()) / 86_400_000);
}

export function timeAgo(date: Date | string | null): string {
  if (!date) return "";
  const then = typeof date === "string" ? new Date(date) : date;
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "a month ago" : `${months} months ago`;
}
