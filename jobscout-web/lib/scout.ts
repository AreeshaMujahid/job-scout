/**
 * Client for the Python rating service (job_scout/service.py).
 *
 * The searching and scoring live in Python because that is where the tested
 * pipeline is. This module is the only place that knows the service exists;
 * everything else talks in the types below.
 */

import type { Profile } from "@/lib/db/schema";

const BASE_URL = process.env.SCOUT_URL ?? "http://127.0.0.1:8000";

export class ScoutError extends Error {
  constructor(
    message: string,
    readonly status: number = 500,
  ) {
    super(message);
    this.name = "ScoutError";
  }
}

export type ScoutProfile = {
  name: string;
  headline: string;
  years_experience: number;
  seniority: string;
  core_skills: string[];
  tools: string[];
  domains: string[];
  search_queries: string[];
  strengths: string[];
  gaps: string[];
};

/** The stored profile, in the shape the Python service expects. One
 *  conversion, shared by every caller -- find.ts and the cover-letter
 *  action both need it, and a second copy is how the two would quietly
 *  drift apart. */
export function toScoutProfile(profile: Profile): ScoutProfile {
  return {
    name: profile.name ?? "Unknown",
    headline: profile.headline ?? "",
    years_experience: profile.yearsExperience ?? 0,
    seniority: profile.seniority ?? "mid",
    core_skills: profile.coreSkills,
    tools: profile.tools,
    domains: profile.domains,
    search_queries: profile.targetRoles,
    strengths: profile.strengths,
    gaps: profile.gaps,
  };
}

export type ScoutJob = {
  key: string;
  source: string;
  title: string;
  company: string;
  url: string;
  location: string;
  description: string;
  tags: string[];
  salary: string;
  posted_at: string;
  company_url: string;
  remote: boolean;
  relevance: number;
};

export type ScoutRating = {
  index: number;
  score: number;
  verdict: "strong" | "good" | "stretch" | "weak";
  skills_match: number;
  experience_match: number;
  domain_match: number;
  why_pick: string[];
  concerns: string[];
  matched_skills: string[];
  missing_skills: string[];
  pitch: string;
};

export type SearchResult = {
  jobs: ScoutJob[];
  fetched: Record<string, number>;
  kept: Record<string, number>;
  errors: Record<string, string>;
  duplicates: number;
  total_fetched: number;
};

export type RateResult = {
  ratings: { job_index: number; rating: ScoutRating }[];
  errors: string[];
};

export type CoverLetterResult = {
  letter: string;
  cv_suggestions: string[];
};

/** A CV read out of an upload: the profile it drives, plus its own plain
 *  text -- the only place that text survives, since the raw file is never
 *  stored. Tailoring a CV to a posting later needs this verbatim. */
export type ProfileResult = ScoutProfile & { cv_text: string };

/** One word-for-word swap to make inside the user's existing CV file. */
export type CVKeywordEdit = { find: string; replace: string; reason: string };

/** An edit that cannot be made to the real PDF, and why. */
export type SkippedEdit = { find: string; replace: string; reason: string };

export type CVKeywordEdits = {
  /** Edits that will actually appear in the downloaded CV -- verified by
   *  applying them to a throwaway copy, not merely proposed. */
  edits: CVKeywordEdit[];
  skipped: SkippedEdit[];
  /** Of `edits`, the ones that went on a NEW line because the line they
   *  belonged on was full. A different promise from the rest: the document
   *  is one line longer than the one uploaded, so it is said out loud. */
  inserted: CVKeywordEdit[];
  /** Of `inserted`, the ones whose new line could not be set in the CV's own
   *  typeface -- legible and correct, but visibly a different font. */
  font_substituted: CVKeywordEdit[];
  /** Short skill names the posting wants that the CV does not show, offered
   *  back to the user to confirm rather than assumed either way. */
  missing_skills: string[];
  /** What the posting asks for, to store and send back next round. */
  required_skills: string[];
  /** Set when the posting has too little text to tailor against. */
  warning?: string;
};

export type FollowUpResult = {
  subject: string;
  body: string;
};

export type OutreachResult = {
  /** LinkedIn caps a connection-request note at 300 characters. */
  connection_note: string;
  message: string;
};

export type ReferralContact = {
  name: string;
  profile_url: string;
  headline: string;
  degree: string;
};

export type ReferralResult = {
  contacts: ReferralContact[];
  /** Set when the company page had to be looked up from its name, so the
   *  caller can store it and skip the lookup next time. */
  resolved_company_url?: string;
  /** Set when the lookup failed -- distinct from "you know nobody there". */
  error: string;
};

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const token = process.env.SCOUT_TOKEN?.trim();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

async function call<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (cause) {
    const reason = cause instanceof Error && cause.name === "TimeoutError" ? "timed out" : "is not running";
    throw new ScoutError(
      `The rating service ${reason}. Start it with: python -m job_scout.service`,
      503,
    );
  }

  if (!response.ok) {
    // FastAPI puts the useful part in `detail`; fall back to the status line.
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      /* non-JSON error body: keep the status line */
    }
    throw new ScoutError(detail, response.status);
  }

  return (await response.json()) as T;
}

export async function scoutHealth(): Promise<{ ok: boolean; model: string; provider: string }> {
  return call("/health", { method: "GET" }, 5_000);
}

/** Read a CV. Slow -- it is a model call over the whole document. */
export async function readCv(file: File): Promise<ProfileResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  return call<ProfileResult>("/profile", { method: "POST", body: form, headers: headers() }, 120_000);
}

export type ScrapeSearch = { title: string; location: string; scraped: number; failed: boolean };

export type ScrapeResult = {
  jobs: ScoutJob[];
  stats: {
    scraped: number;
    kept: number;
    duplicates: number;
    searches: number;
    failed_searches: number;
    board: string;
    /** One entry per title x location, so a 'why is this 0' has an answer. */
    per_search: ScrapeSearch[];
    /** How many of the planned searches actually ran before the limit hit. */
    searches_run: number;
    /** True when the limit stopped the run before every search was tried. */
    stopped_early: boolean;
  };
};

/**
 * LinkedIn / Xing / Arbeitnow, one title at a time per location.
 *
 * Slower than the JSON boards and worth the wait: it is the only way to reach
 * on-site German postings, and it is where seniority and years-of-experience
 * filters actually apply. Every title-location pair is its own HTTP round
 * trip with a polite delay, so the timeout is generous.
 */
export async function scrapeJobs(request: {
  titles: string[];
  locations: string[];
  board: string;
  pages: number;
  max_age_hours: number | null;
  experience_levels: string[];
  max_years: number | null;
  limit?: number;
}): Promise<ScrapeResult> {
  return call<ScrapeResult>(
    "/scrape",
    {
      method: "POST",
      body: JSON.stringify(request),
      headers: headers({ "Content-Type": "application/json" }),
    },
    300_000,
  );
}

export async function searchJobs(request: {
  queries: string[];
  location?: string;
  remote_only?: boolean;
  boards?: string[] | null;
  min_relevance?: number;
  limit?: number;
}): Promise<SearchResult> {
  return call<SearchResult>(
    "/search",
    {
      method: "POST",
      body: JSON.stringify(request),
      headers: headers({ "Content-Type": "application/json" }),
    },
    60_000,
  );
}

/**
 * Score jobs against a profile.
 *
 * Ten minutes, not five. Rating is quota-bound rather than compute-bound:
 * the free Gemini tier allows ~10 requests a minute, so job_scout keeps
 * MAX_RATING_WORKERS at 2 and a full 30-posting run is six batches across
 * three sequential waves. Measured at 257s -- which fitted inside a
 * five-minute timeout only sometimes, and a run that times out has already
 * paid for every model call it made and throws all of them away.
 * Raising the worker count is NOT the fix: it was tried, and four batches
 * fired together 429'd on every one.
 */
export async function rateJobs(
  profile: ScoutProfile,
  jobs: ScoutJob[],
  extraContext = "",
): Promise<RateResult> {
  return call<RateResult>(
    "/rate",
    {
      method: "POST",
      body: JSON.stringify({ profile, jobs, extra_context: extraContext }),
      headers: headers({ "Content-Type": "application/json" }),
    },
    600_000,
  );
}

/**
 * Write a cover letter for one job, plus concrete CV edits that would help
 * it pass a keyword screen for this posting specifically.
 *
 * `missingSkills`/`concerns` are passed in from the job's own rating rather
 * than re-derived here, so the letter and the suggestions agree with what
 * the score card already told the user about where this match falls short.
 */
export async function generateCoverLetter(request: {
  profile: ScoutProfile;
  job: ScoutJob;
  missingSkills?: string[];
  concerns?: string[];
  extraContext?: string;
}): Promise<CoverLetterResult> {
  return call<CoverLetterResult>(
    "/cover-letter",
    {
      method: "POST",
      body: JSON.stringify({
        profile: request.profile,
        job: request.job,
        missing_skills: request.missingSkills ?? [],
        concerns: request.concerns ?? [],
        extra_context: request.extraContext ?? "",
      }),
      headers: headers({ "Content-Type": "application/json" }),
    },
    120_000,
  );
}

/**
 * Render an already-written letter as a PDF and return the raw bytes.
 *
 * Separate from `call()`: that helper always parses the response as JSON,
 * and this response is binary. No model call happens here -- the letter is
 * already written -- so the timeout is short.
 */
export async function renderCoverLetterPdf(request: {
  letter: string;
  jobTitle?: string;
  company?: string;
  candidateName?: string;
  candidateEmail?: string;
}): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/cover-letter/pdf`, {
      method: "POST",
      body: JSON.stringify({
        letter: request.letter,
        job_title: request.jobTitle ?? "",
        company: request.company ?? "",
        candidate_name: request.candidateName ?? "",
        candidate_email: request.candidateEmail ?? "",
      }),
      headers: headers({ "Content-Type": "application/json" }),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch (cause) {
    const reason = cause instanceof Error && cause.name === "TimeoutError" ? "timed out" : "is not running";
    throw new ScoutError(`The rating service ${reason}. Start it with: python -m job_scout.service`, 503);
  }

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      /* non-JSON error body: keep the status line */
    }
    throw new ScoutError(detail, response.status);
  }

  return response.arrayBuffer();
}

/**
 * Which of this CV's words should become this posting's words.
 *
 * Returns swaps, not a rewritten CV. Needs the CV's own text, not just the
 * profile: every edit has to quote the original wording verbatim to be
 * findable in the file. See ProfileResult for where that text comes from.
 */
export async function tailorCv(request: {
  profile: ScoutProfile;
  job: ScoutJob;
  cvText: string;
  /** Skills the user says they have that their CV never mentions. Their own
   *  claim, so it counts as evidence a term may be added. */
  extraSkills?: string;
  /** The CV itself. Sent so the reply lists edits that genuinely land in the
   *  file rather than ones that were merely proposed. */
  cvBase64?: string;
  /** The posting's catalogue from an earlier round, so the gaps shown stay
   *  one shrinking list rather than a fresh guess each time. */
  requiredSkills?: string[];
}): Promise<CVKeywordEdits> {
  return call<CVKeywordEdits>(
    "/tailor-cv",
    {
      method: "POST",
      body: JSON.stringify({
        profile: request.profile,
        job: request.job,
        cv_text: request.cvText,
        extra_skills: request.extraSkills ?? "",
        cv_base64: request.cvBase64 ?? "",
        required_skills: request.requiredSkills ?? [],
      }),
      headers: headers({ "Content-Type": "application/json" }),
    },
    // Two model calls on a free tier that backs off for up to 90 seconds on
    // a rate limit. They run in parallel server-side, but a retry on either
    // still outlasts two minutes, and timing out here loses work already
    // paid for.
    300_000,
  );
}

export type TailoredCvPdf = { bytes: ArrayBuffer; applied: number; skipped: number };

/**
 * Apply the edits to the user's real CV file and return the new bytes.
 *
 * The original PDF goes out and comes back edited in place -- photo, fonts
 * and layout untouched -- rather than a document rebuilt from its text. No
 * model call happens here, so the timeout is short.
 *
 * `applied`/`skipped` come back in headers: an edit whose phrase was not
 * found, or whose replacement would not fit its line, is left alone rather
 * than forced, and the caller should be able to say so.
 */
export async function renderTailoredCvPdf(request: {
  cvBase64: string;
  edits: CVKeywordEdit[];
}): Promise<TailoredCvPdf> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/tailor-cv/pdf`, {
      method: "POST",
      body: JSON.stringify({ cv_base64: request.cvBase64, edits: request.edits }),
      headers: headers({ "Content-Type": "application/json" }),
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
  } catch (cause) {
    const reason = cause instanceof Error && cause.name === "TimeoutError" ? "timed out" : "is not running";
    throw new ScoutError(`The rating service ${reason}. Start it with: python -m job_scout.service`, 503);
  }

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      /* non-JSON error body: keep the status line */
    }
    throw new ScoutError(detail, response.status);
  }

  return {
    bytes: await response.arrayBuffer(),
    applied: Number(response.headers.get("X-CV-Edits-Applied") ?? 0),
    skipped: Number(response.headers.get("X-CV-Edits-Skipped") ?? 0),
  };
}

/**
 * Draft the nudge for an application that has gone quiet.
 *
 * `daysSinceApplied` is what the e-mail is built around ("I applied N days
 * ago"), so it is required rather than optional -- a follow-up with no sense
 * of how long it has been is just a second cover letter.
 */
export async function generateFollowUp(request: {
  profile: ScoutProfile;
  job: ScoutJob;
  daysSinceApplied: number;
  extraContext?: string;
}): Promise<FollowUpResult> {
  return call<FollowUpResult>(
    "/follow-up",
    {
      method: "POST",
      body: JSON.stringify({
        profile: request.profile,
        job: request.job,
        days_since_applied: request.daysSinceApplied,
        extra_context: request.extraContext ?? "",
      }),
      headers: headers({ "Content-Type": "application/json" }),
    },
    90_000,
  );
}

/**
 * Who the user could ask for a referral on one posting.
 *
 * Slow by nature: it drives a real signed-in browser at a real LinkedIn
 * page, so the timeout is generous and the caller should treat it as a
 * deliberate, user-initiated action rather than something to prefetch.
 */
export async function fetchReferrals(jobUrl: string): Promise<ReferralResult> {
  return call<ReferralResult>(
    "/referrals",
    {
      method: "POST",
      body: JSON.stringify({ job_url: jobUrl }),
      headers: headers({ "Content-Type": "application/json" }),
    },
    90_000,
  );
}

/**
 * Staff at one company, for when nobody in your own network is there.
 *
 * Heavier than fetchReferrals: these people have no relationship to the
 * user, so it is capped server-side and only ever called for one company on
 * explicit request.
 */
export async function fetchCompanyPeople(
  company: { url?: string; name?: string },
  keyword = "",
): Promise<ReferralResult> {
  return call<ReferralResult>(
    "/company-people",
    {
      method: "POST",
      body: JSON.stringify({
        company_url: company.url ?? "",
        company_name: company.name ?? "",
        keyword,
      }),
      headers: headers({ "Content-Type": "application/json" }),
    },
    120_000,
  );
}

/**
 * Draft a message to one person about one job.
 *
 * A draft only -- nothing here sends anything. The user reads it and presses
 * send themselves, in LinkedIn.
 */
export async function generateOutreach(request: {
  profile: ScoutProfile;
  job: ScoutJob;
  contactName: string;
  contactHeadline?: string;
  extraContext?: string;
}): Promise<OutreachResult> {
  return call<OutreachResult>(
    "/outreach",
    {
      method: "POST",
      body: JSON.stringify({
        profile: request.profile,
        job: request.job,
        contact_name: request.contactName,
        contact_headline: request.contactHeadline ?? "",
        extra_context: request.extraContext ?? "",
      }),
      headers: headers({ "Content-Type": "application/json" }),
    },
    90_000,
  );
}

export type ScoutInboxMessage = {
  message_id: string;
  sender: string;
  subject: string;
  received_at: string;
  body: string;
};

export type ScoutTrackedApplication = {
  job_id: string;
  company: string;
  title: string;
  applied_on: string;
  current_status: string;
};

export type DetectedUpdate = {
  job_id: string;
  status: string;
  confidence: string;
  evidence: string;
};

/**
 * What a batch of messages says about a batch of tracked applications.
 *
 * Errors come back in the body rather than as a thrown ScoutError, because
 * this is called from an unattended worker: a model hiccup on one user should
 * cost that user's sync its updates, not stop the loop for everyone else.
 * A service that is genuinely down still throws -- that is worth retrying.
 */
export async function classifyInbox(request: {
  applications: ScoutTrackedApplication[];
  messages: ScoutInboxMessage[];
}): Promise<{ updates: DetectedUpdate[]; errors: string[] }> {
  return call(
    "/inbox/classify",
    {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(request),
    },
    // A model call over a batch of messages; the same order as rating a page
    // of jobs, which uses a comparable budget.
    120_000,
  );
}

export type ApplicationChatTurn = { role: "user" | "assistant"; content: string };

export type ApplicationChatResult = {
  reply: string;
  /** What the question asked for that the CV could not back up. */
  unsupported: string[];
  /** Set when the draft could not be produced; the panel says so in the thread. */
  error: string;
};

/**
 * Draft an answer to an open question on an application form.
 *
 * Stateless at the service: the whole transcript goes every turn, which is
 * what lets "make it shorter" or "use the other project" work without the
 * service remembering anything.
 */
export async function applicationChat(request: {
  profile: ScoutProfile;
  cvText: string;
  history: ApplicationChatTurn[];
  job?: ScoutJob;
}): Promise<ApplicationChatResult> {
  return call(
    "/application-chat",
    {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        profile: request.profile,
        cv_text: request.cvText,
        history: request.history,
        job: request.job,
      }),
    },
    // A drafting turn, with the CV and the posting in the prompt.
    120_000,
  );
}
