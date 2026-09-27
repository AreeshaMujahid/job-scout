"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";

import { isAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { jobs, ratings } from "@/lib/db/schema";
import { extraContext } from "@/lib/preferences";
import {
  fetchCompanyPeople,
  fetchReferrals,
  generateOutreach,
  toScoutProfile,
  ScoutError,
  type OutreachResult,
  type ReferralContact,
  type ScoutJob,
} from "@/lib/scout";

export type ReferralState =
  | { status: "idle" }
  | { status: "ok"; contacts: ReferralContact[] }
  | { status: "error"; message: string };

/**
 * Who the owner could ask for a referral on one job.
 *
 * Reads the module LinkedIn renders on the posting -- connections and school
 * alumni -- and caches it against the rating row, because every lookup
 * drives a browser at LinkedIn and once per job beats once per page view.
 *
 * OWNER ONLY, and for the same reason LinkedIn search is: the browser it
 * drives is signed in as whoever owns the deployment, through the profile in
 * .pw-profile. On a shared install this would show one person's connections
 * to everybody, and send every visitor's lookup out through that person's
 * account. The source check below is not enough on its own -- postings are
 * shared between users, so "only LinkedIn jobs" is not "only the owner's".
 */
export async function fetchReferralsAction(jobId: string): Promise<ReferralState> {
  const user = await requireUser();
  if (!(await isAdmin())) {
    return {
      status: "error",
      message: "Referral lookups are not available on this account.",
    };
  }
  const db = await getDb();

  const [row] = await db
    .select({ job: jobs, rating: ratings })
    .from(jobs)
    .innerJoin(ratings, and(eq(ratings.jobId, jobs.id), eq(ratings.userId, user.id)))
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!row) {
    return { status: "error", message: "That job has not been rated for you yet." };
  }
  if (row.job.source !== "LinkedIn") {
    // Only LinkedIn renders this module; saying so beats a silent empty list
    // that reads as "you know nobody there".
    return {
      status: "error",
      message: `This posting came from ${row.job.source}, and only LinkedIn shows who you know at a company.`,
    };
  }

  let result;
  try {
    result = await fetchReferrals(row.job.url);
  } catch (error) {
    const message = error instanceof ScoutError ? error.message : "Could not look up contacts.";
    return { status: "error", message };
  }

  if (result.error) {
    return { status: "error", message: result.error };
  }

  await db
    .update(ratings)
    .set({ referralContacts: result.contacts, referralsAt: new Date() })
    .where(and(eq(ratings.userId, user.id), eq(ratings.jobId, jobId)));

  revalidatePath(`/jobs/${jobId}`);

  return { status: "ok", contacts: result.contacts };
}

/**
 * Staff at the company behind one job, when the user has no connection there.
 *
 * Not cached against the rating row the way the network lookup is: this is a
 * live view of a company's staff rather than a fact about the user's own
 * network, and keeping a stored copy of strangers' details around is a
 * retention decision nobody asked for. Fetched, shown, and gone on reload.
 */
export async function fetchCompanyPeopleAction(
  jobId: string,
  keyword: string,
): Promise<ReferralState> {
  const user = await requireUser();
  const db = await getDb();

  const [row] = await db
    .select({ job: jobs })
    .from(jobs)
    .innerJoin(ratings, and(eq(ratings.jobId, jobs.id), eq(ratings.userId, user.id)))
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!row) return { status: "error", message: "That job has not been rated for you yet." };
  if (!row.job.companyUrl && !row.job.company) {
    return { status: "error", message: "This listing has no company on it to search." };
  }

  try {
    // Only LinkedIn postings arrive with a company URL. Everything else is
    // looked up by name, which costs an extra page load -- so a URL found
    // that way is written back to the job and the lookup happens once per
    // company rather than once per click.
    const result = await fetchCompanyPeople(
      { url: row.job.companyUrl, name: row.job.company },
      keyword,
    );
    if (result.error) return { status: "error", message: result.error };

    if (result.resolved_company_url && !row.job.companyUrl) {
      await db
        .update(jobs)
        .set({ companyUrl: result.resolved_company_url })
        .where(eq(jobs.id, jobId));
    }
    return { status: "ok", contacts: result.contacts };
  } catch (error) {
    const message = error instanceof ScoutError ? error.message : "Could not search the company.";
    return { status: "error", message };
  }
}

export type OutreachState =
  | { status: "idle" }
  | { status: "ok"; note: string; message: string }
  | { status: "error"; message: string };

/**
 * Draft a message to one person about one job.
 *
 * Returns the draft; it is never sent. Not stored either -- a draft for one
 * stranger about one job is a throwaway, and keeping it would mean holding
 * their name in the database alongside it.
 */
export async function draftOutreachAction(
  jobId: string,
  contactName: string,
  contactHeadline: string,
): Promise<OutreachState> {
  const user = await requireUser();
  if (!user.profile) {
    return { status: "error", message: "Upload a CV first — it is what the message is written from." };
  }

  const db = await getDb();
  const [row] = await db
    .select({ job: jobs })
    .from(jobs)
    .innerJoin(ratings, and(eq(ratings.jobId, jobs.id), eq(ratings.userId, user.id)))
    .where(eq(jobs.id, jobId))
    .limit(1);

  if (!row) return { status: "error", message: "That job has not been rated for you yet." };

  const job = row.job;
  const scoutJob: ScoutJob = {
    key: job.id,
    source: job.source,
    title: job.title,
    company: job.company,
    url: job.url,
    location: job.location,
    description: job.description,
    tags: job.tags,
    salary: job.salary,
    posted_at: job.postedAt,
    company_url: job.companyUrl,
    remote: job.remote,
    relevance: 0,
  };

  let result: OutreachResult;
  try {
    result = await generateOutreach({
      profile: toScoutProfile(user.profile),
      job: scoutJob,
      contactName,
      contactHeadline,
      extraContext: extraContext(user.profile),
    });
  } catch (error) {
    const msg = error instanceof ScoutError ? error.message : "Could not draft a message.";
    return { status: "error", message: msg };
  }

  return { status: "ok", note: result.connection_note, message: result.message };
}
