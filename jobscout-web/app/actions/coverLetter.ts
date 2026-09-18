"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { jobs, ratings } from "@/lib/db/schema";
import { extraContext } from "@/lib/preferences";
import { generateCoverLetter, toScoutProfile, ScoutError, type ScoutJob } from "@/lib/scout";

export type CoverLetterState =
  | { status: "idle" }
  | { status: "ok"; letter: string; cvSuggestions: string[] }
  | { status: "error"; message: string };

/**
 * Write a cover letter for one job the user has already had rated, and save
 * it against that rating -- reopening the job later shows the same letter
 * rather than paying for a fresh one on every visit.
 *
 * Reuses the SAME missing_skills/concerns the score card already shows, so
 * the letter never disagrees with what the user was told about this match.
 */
export async function generateCoverLetterAction(jobId: string): Promise<CoverLetterState> {
  const user = await requireUser();
  if (!user.profile) {
    return { status: "error", message: "Upload a CV first — it is what the letter is written from." };
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

  const { job, rating } = row;
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
    result = await generateCoverLetter({
      profile: toScoutProfile(user.profile),
      job: scoutJob,
      missingSkills: rating.missingSkills,
      concerns: rating.concerns,
      extraContext: extraContext(user.profile),
    });
  } catch (error) {
    const message = error instanceof ScoutError ? error.message : "Could not generate a cover letter.";
    return { status: "error", message };
  }

  await db
    .update(ratings)
    .set({
      coverLetter: result.letter,
      cvSuggestions: result.cv_suggestions,
      coverLetterAt: new Date(),
    })
    .where(and(eq(ratings.userId, user.id), eq(ratings.jobId, jobId)));

  revalidatePath(`/jobs/${jobId}`);

  return { status: "ok", letter: result.letter, cvSuggestions: result.cv_suggestions };
}
