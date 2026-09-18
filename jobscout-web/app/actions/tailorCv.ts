"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { jobs, ratings } from "@/lib/db/schema";
import {
  tailorCv,
  toScoutProfile,
  ScoutError,
  type CVKeywordEdit,
  type ScoutJob,
  type SkippedEdit,
} from "@/lib/scout";

export type TailorCvState =
  | { status: "idle" }
  | {
      status: "ok";
      edits: CVKeywordEdit[];
      skipped: SkippedEdit[];
      /** Of `edits`, the ones added on a new line rather than swapped in
       *  place -- the download is a line longer than the upload. */
      inserted: CVKeywordEdit[];
      /** Of `inserted`, the ones set in a substitute typeface. */
      fontSubstituted: CVKeywordEdit[];
      missingSkills: string[];
      requiredSkills: string[];
      warning: string;
    }
  | { status: "error"; message: string };

/**
 * Work out which words in the user's CV should become this posting's words,
 * and save the swaps against that rating -- same convention as
 * generateCoverLetterAction: coming back to the job later shows the same
 * suggestions rather than paying for a fresh model call every visit.
 *
 * Only the edits are stored, never a tailored copy of the CV. The file is
 * built by applying these to the original PDF at download time, so
 * re-uploading a CV can never leave a stale document behind.
 */
export async function tailorCvAction(
  jobId: string,
  /** Skills the user states they have that their CV never mentions. Their own
   *  claim about their own experience, so it counts as evidence; the model's
   *  guesses never do. */
  extraSkills = "",
  /** The posting's catalogue from an earlier round. Sent back so the gaps
   *  shown stay one shrinking list instead of a fresh guess each time. */
  requiredSkills: string[] = [],
): Promise<TailorCvState> {
  const user = await requireUser();
  if (!user.profile) {
    return { status: "error", message: "Upload a CV first — it is what this tailors." };
  }
  if (!user.profile.cvText) {
    return {
      status: "error",
      message: "Your CV's text was not saved when you uploaded it — re-upload it to enable this.",
    };
  }
  if (!user.profile.cvFile) {
    return {
      status: "error",
      message:
        "This edits your original PDF in place, so it needs a PDF upload. Re-upload your CV as a PDF to use it.",
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

  const { job } = row;
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
    result = await tailorCv({
      profile: toScoutProfile(user.profile),
      job: scoutJob,
      cvText: user.profile.cvText,
      extraSkills: extraSkills.slice(0, 2000),
      // Sent so the reply is what will really be in the download.
      cvBase64: user.profile.cvFile,
      requiredSkills: requiredSkills.length ? requiredSkills : row.rating.tailoredCvRequired,
    });
  } catch (error) {
    const message = error instanceof ScoutError ? error.message : "Could not tailor the CV.";
    return { status: "error", message };
  }

  await db
    .update(ratings)
    .set({
      tailoredCvEdits: result.edits,
      tailoredCvMissing: result.missing_skills,
      tailoredCvRequired: result.required_skills ?? [],
      tailoredCvAt: new Date(),
    })
    .where(and(eq(ratings.userId, user.id), eq(ratings.jobId, jobId)));

  revalidatePath(`/jobs/${jobId}`);

  return {
    status: "ok",
    edits: result.edits,
    skipped: result.skipped ?? [],
    inserted: result.inserted ?? [],
    fontSubstituted: result.font_substituted ?? [],
    missingSkills: result.missing_skills,
    requiredSkills: result.required_skills ?? [],
    warning: result.warning ?? "",
  };
}
