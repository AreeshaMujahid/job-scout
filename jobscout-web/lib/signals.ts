/**
 * Facts a posting states about itself, read from its own description.
 *
 * These are not judgements — no model is involved and nothing is inferred
 * from a vibe. Each one is a phrase the employer wrote, found or not found.
 * That is what makes them safe to put on a card beside a score: the score is
 * an opinion, these are quotes.
 *
 * Deliberately mirrors the rejection rules in job_scout/sources/filters.py.
 * There, the same phrases DROP a posting when it says it will not sponsor;
 * here they SURFACE the opposite when it says it will. Same evidence, and a
 * filter that silently removes things is worth less than one that also tells
 * you when the answer is yes.
 */

/** Phrases that amount to "we will sponsor a visa". */
const OFFERS_SPONSORSHIP =
  /(visa\s+sponsorship\s+(is\s+)?(available|offered|provided|possible))|(we\s+(can|do|will|offer|provide)\s+sponsor)|(sponsorship\s+available)|(relocation\s+(package|support|assistance)\s+(is\s+)?(available|offered|provided))|(we\s+support\s+visa)|(visa\s+support)|(arbeitserlaubnis\s+unterst)|(unterst(ü|ue)tzen\s+bei\s+der\s+visa)/i;

/** Phrases that amount to "we will not". Kept so a card never claims the
 *  opposite of what the posting says when both kinds of wording appear. */
const REFUSES_SPONSORSHIP =
  /(no\s+(visa\s+)?sponsorship)|(not?\s+(be\s+)?able\s+to\s+sponsor)|(cannot\s+sponsor)|(unable\s+to\s+sponsor)|(sponsorship\s+is\s+not\s+(available|offered|provided))|(must\s+(already\s+)?(have|possess)\s+(the\s+)?(valid\s+)?(right\s+to\s+work|work\s+authori[sz]ation|work\s+permit))|((eu|eea|us|uk)\s+(citizens?|nationals?)\s+only)/i;

export type SponsorshipSignal = "offers" | "refuses" | null;

/**
 * What this posting says about sponsoring a visa, if anything.
 *
 * A refusal outranks an offer: a description carrying both ("we support visa
 * applications… candidates must already hold the right to work") is a
 * refusal with warm wording, and the reader is better served by the harder
 * half. Most postings say nothing at all, and null is the honest answer.
 */
export function sponsorship(description: string): SponsorshipSignal {
  const text = description || "";
  if (REFUSES_SPONSORSHIP.test(text)) return "refuses";
  if (OFFERS_SPONSORSHIP.test(text)) return "offers";
  return null;
}

// "5+ years", "at least 3 years", "3-5 years", "mindestens 4 Jahre".
const YEARS = /(\d{1,2})\s*(?:\+|plus)?\s*(?:-|–|to)?\s*(?:\d{1,2})?\s*\+?\s*(?:years?|yrs?|jahre|jahren)/gi;

/**
 * The fewest years this posting asks for, or null when it does not say.
 *
 * The fewest, not the most: a description wanting "2+ years of Python" and
 * "5+ years in a regulated industry" is open to someone with two, and the
 * larger figure is usually a nice-to-have further down the page. Showing the
 * larger one would talk people out of jobs they would get.
 */
export function yearsRequired(description: string): number | null {
  const found: number[] = [];
  for (const match of (description || "").matchAll(YEARS)) {
    const value = Number(match[1]);
    // Above 25 is a company age or a founding year that wandered into range.
    if (value > 0 && value <= 25) found.push(value);
  }
  return found.length ? Math.min(...found) : null;
}

/** Was this posted recently enough that few people have seen it yet? */
export function isEarly(postedAt: string): boolean {
  if (!postedAt) return false;
  const posted = new Date(postedAt.slice(0, 10));
  if (Number.isNaN(posted.getTime())) return false;
  const days = (Date.now() - posted.getTime()) / 86_400_000;
  return days >= 0 && days <= 2;
}

/**
 * The seniority a title announces, for the card's level line.
 *
 * A deliberate port of level_of() in job_scout/sources/seniority.py, in the
 * same order -- most senior first, so "Senior Graduate Programme Lead" reads
 * as senior rather than graduate. It exists twice because the filter runs
 * where jobs are fetched and the label is drawn where they are shown.
 *
 * "Mid Level" is what an unmarked title gets ON THE CARD. That is a display
 * convention, not an inference: the filter still treats silence as silence
 * and never drops a posting for failing to state a level.
 */
// Word boundaries are load-bearing: without them "lead" matches
// "Leadership", "grad" matches "upgrade" and "sr" matches inside any
// word containing those letters, so half a feed reads as Senior.
const LEVEL_MARKERS: [string, RegExp][] = [
  ["Director", /\b(director|vp|vice president|head of|chief|cto|cio|principal|distinguished|fellow)\b/i],
  ["Senior", /\b(senior|sr|snr|staff|lead|iii|iv|leitung|leiter|leiterin)\b/i],
  // German study routes sit here too, matching seniority.py: a Duales
  // Studium is a degree and an Abschlussarbeit is a thesis, and a card
  // that labelled either "Entry Level" would describe a university
  // place as a job.
  ["Internship", /\b(intern|internship|praktikum|praktikant|working student|werkstudent|trainee|apprentice|duales studium|dualer student|ausbildung|auszubildende|abschlussarbeit|bachelorarbeit|masterarbeit|studentische[rn]?)\b/i],
  ["Entry Level", /\b(junior|jr|graduate|grad|entry[- ]level|einsteiger|berufseinsteiger|absolvent)\b/i],
];

export function levelOf(title: string): string {
  for (const [label, pattern] of LEVEL_MARKERS) {
    if (pattern.test(title || "")) return label;
  }
  return "Mid Level";
}
