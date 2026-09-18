"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { jobStatus, jobs } from "@/lib/db/schema";
import { extraContext } from "@/lib/preferences";
import { generateFollowUp, toScoutProfile, ScoutError, type ScoutJob } from "@/lib/scout";
// A "use server" file may only export async functions, so the threshold
// and the day-count helper live with the other time helpers instead.
import { daysSince } from "@/lib/score";

export type FollowUpState =
  | { status: "idle" }
  | { status: "ok"; subject: string; body: string }
  | { status: "error"; message: string };

export async function generateFollowUpAction(jobId: string): Promise<FollowUpState> {
  const user = await requireUser();
  if (!user.profile) {
    return { status: "error", message: "Upload a CV first — it is what the e-mail is written from." };
  }

  const db = await getDb();
  const [row] = await db
    .select({ job: jobs, tracked: jobStatus })
    .from(jobStatus)
    .innerJoin(jobs, eq(jobStatus.jobId, jobs.id))
    .where(and(eq(jobStatus.userId, user.id), eq(jobStatus.jobId, jobId)))
    .limit(1);

  if (!row) {
    return { status: "error", message: "That job is not in your tracker." };
  }
  if (row.tracked.status !== "applied") {
    // Chasing something you never applied to, or that already moved on, is
    // not a follow-up -- and an e-mail saying "I applied 12 days ago" to a
    // company that already interviewed you reads as though nobody is paying
    // attention.
    return {
      status: "error",
      message: `This is marked "${row.tracked.status}", not "applied" — a follow-up only makes sense for an application still waiting on a reply.`,
    };
  }

  const { job, tracked } = row;
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

  let result;
  try {
    result = await generateFollowUp({
      profile: toScoutProfile(user.profile),
      job: scoutJob,
      daysSinceApplied: Math.max(1, daysSince(tracked.updatedAt)),
      extraContext: extraContext(user.profile),
    });
  } catch (error) {
    const message = error instanceof ScoutError ? error.message : "Could not draft a follow-up.";
    return { status: "error", message };
  }

  // Deliberately does NOT touch updatedAt: that column is what "days since
  // applied" is measured from, so writing to it here would reset the clock
  // and make the nudge disappear the moment it was acted on.
  await db
    .update(jobStatus)
    .set({
      followUpSubject: result.subject,
      followUpBody: result.body,
      followUpAt: new Date(),
    })
    .where(and(eq(jobStatus.userId, user.id), eq(jobStatus.jobId, jobId)));

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/tracker");

  return { status: "ok", subject: result.subject, body: result.body };
}
