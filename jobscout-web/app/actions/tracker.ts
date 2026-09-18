"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { JOB_STATUSES, jobStatus, type JobStatus } from "@/lib/db/schema";

/**
 * Move a job through the tracker, or take it out of it.
 *
 * "none" is not a status but the absence of one -- clicking Saved again on a
 * saved job should un-save it, not leave a row saying nothing.
 */
export async function setJobStatus(jobId: string, status: JobStatus | "none"): Promise<void> {
  const user = await requireUser();
  const db = await getDb();

  if (status === "none") {
    await db
      .delete(jobStatus)
      .where(and(eq(jobStatus.userId, user.id), eq(jobStatus.jobId, jobId)));
  } else {
    if (!JOB_STATUSES.includes(status)) throw new Error(`Unknown status: ${status}`);

    await db
      .insert(jobStatus)
      .values({ userId: user.id, jobId, status, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [jobStatus.userId, jobStatus.jobId],
        set: { status, updatedAt: new Date() },
      });
  }

  revalidatePath("/feed");
  revalidatePath("/tracker");
  revalidatePath(`/jobs/${jobId}`);
}

export async function saveNote(jobId: string, note: string): Promise<void> {
  const user = await requireUser();
  const db = await getDb();

  // A note implies you are tracking the job, so this creates the row if the
  // user typed a note before pressing any status button.
  await db
    .insert(jobStatus)
    .values({
      userId: user.id,
      jobId,
      status: "saved",
      note: note.slice(0, 2000),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [jobStatus.userId, jobStatus.jobId],
      set: { note: note.slice(0, 2000), updatedAt: new Date() },
    });

  revalidatePath("/tracker");
  revalidatePath(`/jobs/${jobId}`);
}
