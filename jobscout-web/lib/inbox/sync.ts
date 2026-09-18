import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { getDb } from "@/lib/db";
import {
  inboundMessages,
  jobStatus,
  jobs,
  statusUpdates,
  type JobStatus,
} from "@/lib/db/schema";
import { classifyInbox, type DetectedUpdate } from "@/lib/scout";
import { recordSyncError, recordSyncSuccess } from "@/lib/inbox/mailbox";

/**
 * Turning received mail into tracker movement.
 *
 * This is the part that acts without being asked, so the whole file is built
 * around one rule: a wrong "rejected" is far more expensive than a missed
 * update. Someone who is told they were rejected stops chasing a live
 * application, and no amount of accuracy elsewhere buys that back. So every
 * ambiguity resolves towards leaving the tracker alone, and every decision --
 * applied or not -- is written down with the sentence behind it.
 */

/**
 * Applications worth matching against.
 *
 * Only ones the user actually sent. "saved" has no application to hear back
 * about, and "dismissed" is a job they walked away from -- mail about either
 * is not an update. "rejected" is excluded too: it is an end state, and the
 * rare genuine reversal is worth missing to avoid re-opening closed rows on
 * the strength of an automated footer.
 */
const LIVE_STATUSES: JobStatus[] = ["applied", "interviewing", "offer"];

/**
 * How far an application can move on its own.
 *
 * An application only ever moves forward through this list. A late
 * acknowledgement ("we have received your CV") arriving after a phone screen
 * is real mail about a real application, and acting on it would drag the row
 * back from `interviewing` to `applied` and lose what the user knows. Rank
 * order is what stops that, and it costs nothing: the forward cases are the
 * ones anybody cares about.
 */
const RANK: Record<string, number> = {
  saved: 0,
  applied: 1,
  interviewing: 2,
  offer: 3,
  // Terminal, and reachable from anywhere -- a rejection at any stage is
  // still a rejection, so it is never blocked by the rank check below.
  rejected: 99,
};

/** Statuses the classifier may return that the tracker understands. */
const ACCEPTED: JobStatus[] = ["applied", "interviewing", "offer", "rejected"];

export type SyncResult = {
  userId: string;
  messagesRead: number;
  updatesDetected: number;
  autoApplied: number;
  pending: number;
  errors: string[];
};

/**
 * Should the worker move the row itself, or ask first?
 *
 * Auto-apply is off unless INBOX_AUTO_APPLY is explicitly turned on, and even
 * then only high-confidence updates qualify. A rejection is never applied
 * automatically regardless: it is the one verdict whose cost is asymmetric
 * enough that a human should read the sentence before the row closes.
 */
function shouldAutoApply(update: DetectedUpdate): boolean {
  if (process.env.INBOX_AUTO_APPLY !== "true") return false;
  if (update.confidence !== "high") return false;
  if (update.status === "rejected") return false;
  return true;
}

/** One user: read what arrived, decide what it means, write it down. */
export async function syncUser(userId: string): Promise<SyncResult> {
  const db = await getDb();
  const result: SyncResult = {
    userId,
    messagesRead: 0,
    updatesDetected: 0,
    autoApplied: 0,
    pending: 0,
    errors: [],
  };

  const messages = await db
    .select()
    .from(inboundMessages)
    .where(and(eq(inboundMessages.userId, userId), isNull(inboundMessages.processedAt)))
    .orderBy(asc(inboundMessages.receivedAt))
    // A batch bound, so one user who forwarded a year of mail cannot occupy
    // the worker for an hour. The rest waits for the next pass.
    .limit(40);

  if (messages.length === 0) return result;
  result.messagesRead = messages.length;

  const tracked = await db
    .select({
      jobId: jobStatus.jobId,
      status: jobStatus.status,
      updatedAt: jobStatus.updatedAt,
      company: jobs.company,
      title: jobs.title,
    })
    .from(jobStatus)
    .innerJoin(jobs, eq(jobs.id, jobStatus.jobId))
    .where(and(eq(jobStatus.userId, userId), inArray(jobStatus.status, LIVE_STATUSES)));

  // Nothing to match against. The messages are still marked processed --
  // re-reading them on every pass forever would be paying a model to tell us
  // the same nothing.
  if (tracked.length === 0) {
    await markProcessed(messages.map((m) => m.id));
    return result;
  }

  let detected: DetectedUpdate[] = [];
  try {
    const response = await classifyInbox({
      applications: tracked.map((t) => ({
        job_id: t.jobId,
        company: t.company,
        title: t.title,
        applied_on: t.updatedAt.toISOString().slice(0, 10),
        current_status: t.status,
      })),
      messages: messages.map((m) => ({
        message_id: m.id,
        sender: m.sender,
        subject: m.subject,
        received_at: m.receivedAt.toISOString(),
        body: m.body,
      })),
    });
    detected = response.updates;
    result.errors.push(...response.errors);
  } catch (cause) {
    // The service is down or timed out. Leave the messages unprocessed so the
    // next pass retries them -- this is the one failure worth repeating.
    const message = cause instanceof Error ? cause.message : String(cause);
    result.errors.push(message);
    await recordSyncError(userId, message);
    return result;
  }

  const byJob = new Map(tracked.map((t) => [t.jobId, t]));

  for (const update of detected) {
    const current = byJob.get(update.job_id);
    if (!current) continue; // an id for an application we did not send

    const status = update.status as JobStatus;
    if (!ACCEPTED.includes(status)) continue;
    if (status === current.status) continue; // already there; nothing to move
    if ((RANK[status] ?? 0) <= (RANK[current.status] ?? 0)) continue; // backwards

    const auto = shouldAutoApply(update);

    // Anything still awaiting the user for this job is now out of date. Two
    // pending rows for one application would make the review screen ask the
    // same question twice with different answers.
    await db
      .update(statusUpdates)
      .set({ state: "superseded", resolvedAt: new Date() })
      .where(
        and(
          eq(statusUpdates.userId, userId),
          eq(statusUpdates.jobId, update.job_id),
          eq(statusUpdates.state, "pending"),
        ),
      );

    await db.insert(statusUpdates).values({
      id: randomUUID(),
      userId,
      jobId: update.job_id,
      messageId: sourceMessage(update.evidence, messages),
      previousStatus: current.status,
      status,
      confidence: update.confidence,
      evidence: update.evidence,
      state: auto ? "applied" : "pending",
      auto,
      resolvedAt: auto ? new Date() : null,
    });

    result.updatesDetected += 1;

    if (auto) {
      await db
        .update(jobStatus)
        .set({ status, updatedAt: new Date() })
        .where(and(eq(jobStatus.userId, userId), eq(jobStatus.jobId, update.job_id)));
      result.autoApplied += 1;
      // Keep the in-memory view honest, so a second message in the same batch
      // is ranked against where the row now is rather than where it started.
      byJob.set(update.job_id, { ...current, status });
    } else {
      result.pending += 1;
    }
  }

  await markProcessed(messages.map((m) => m.id));
  await recordSyncSuccess(userId);
  return result;
}

/**
 * Which message an update came from.
 *
 * The classifier returns the deciding sentence but not which message it read
 * it in, so the quote is matched back against the batch. That is reliable
 * because the prompt requires the evidence to be quoted rather than
 * paraphrased -- and when it is not found, null is the honest answer. This
 * only decides whether the review screen can offer "show me the e-mail"; it
 * never affects whether the update itself is trusted.
 */
function sourceMessage(evidence: string, batch: { id: string; body: string }[]): string | null {
  const needle = evidence.trim().toLowerCase();
  if (needle.length < 12) return null; // too short to identify anything

  const exact = batch.find((m) => m.body.toLowerCase().includes(needle));
  if (exact) return exact.id;

  // Models normalise whitespace when quoting out of a wrapped e-mail, so a
  // literal match can fail on a sentence that is plainly present.
  const flat = needle.replace(/\s+/g, " ");
  const loose = batch.find((m) => m.body.toLowerCase().replace(/\s+/g, " ").includes(flat));
  return loose?.id ?? null;
}

async function markProcessed(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDb();
  await db
    .update(inboundMessages)
    .set({ processedAt: new Date() })
    .where(inArray(inboundMessages.id, ids));
}

/** Users with mail waiting. Cheaper than walking every account each pass. */
export async function usersWithUnprocessedMail(): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .selectDistinct({ userId: inboundMessages.userId })
    .from(inboundMessages)
    .where(isNull(inboundMessages.processedAt))
    .limit(500);
  return rows.map((r) => r.userId);
}

/** Pending updates awaiting this user, newest first, for the review screen. */
export async function pendingUpdates(userId: string) {
  const db = await getDb();
  return db
    .select({
      id: statusUpdates.id,
      jobId: statusUpdates.jobId,
      status: statusUpdates.status,
      previousStatus: statusUpdates.previousStatus,
      confidence: statusUpdates.confidence,
      evidence: statusUpdates.evidence,
      detectedAt: statusUpdates.detectedAt,
      company: jobs.company,
      title: jobs.title,
    })
    .from(statusUpdates)
    .innerJoin(jobs, eq(jobs.id, statusUpdates.jobId))
    .where(and(eq(statusUpdates.userId, userId), eq(statusUpdates.state, "pending")))
    .orderBy(sql`${statusUpdates.detectedAt} DESC`)
    .limit(50);
}
