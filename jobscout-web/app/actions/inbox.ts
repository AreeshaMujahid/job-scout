"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { jobStatus, mailboxes, statusUpdates, type JobStatus } from "@/lib/db/schema";
import { addressFor, ensureMailbox } from "@/lib/inbox/mailbox";

/**
 * The user's half of inbox tracking: confirming what it found, and turning
 * it off.
 *
 * Every action here is scoped to the signed-in user in the WHERE clause
 * rather than checked beforehand. An id from a form is user input, and
 * `where(id = ? AND user_id = ?)` cannot be talked into touching someone
 * else's row -- a prior ownership check followed by an unscoped update can.
 */

/** The address to forward job mail to, created on first view. */
export async function getForwardingAddress(): Promise<string> {
  // allowUnonboarded, like the settings page itself: someone who signed up
  // and stopped still has an account and a mailbox, and must be able to see
  // and switch off what it does without first being made to upload a CV.
  const user = await requireUser({ allowUnonboarded: true });
  const mailbox = await ensureMailbox(user.id);
  return addressFor(mailbox.alias);
}

/**
 * Accept a detected update and move the tracker.
 *
 * previousStatus is kept on the row, so this stays reversible: undoing is
 * writing that value back, not guessing where the application used to be.
 */
export async function applyUpdate(updateId: string): Promise<void> {
  const user = await requireUser();
  const db = await getDb();

  const [update] = await db
    .select()
    .from(statusUpdates)
    .where(
      and(
        eq(statusUpdates.id, updateId),
        eq(statusUpdates.userId, user.id),
        eq(statusUpdates.state, "pending"),
      ),
    )
    .limit(1);

  // Already applied, dismissed, or never theirs. Silent rather than an error:
  // the usual cause is a double-click or a stale tab, and neither is worth
  // showing somebody a failure over.
  if (!update) return;

  await db
    .update(jobStatus)
    .set({ status: update.status, updatedAt: new Date() })
    .where(and(eq(jobStatus.userId, user.id), eq(jobStatus.jobId, update.jobId)));

  await db
    .update(statusUpdates)
    .set({ state: "applied", resolvedAt: new Date() })
    .where(eq(statusUpdates.id, update.id));

  revalidatePath("/tracker");
  revalidatePath(`/jobs/${update.jobId}`);
}

/** Reject a detected update. The tracker does not move. */
export async function dismissUpdate(updateId: string): Promise<void> {
  const user = await requireUser();
  const db = await getDb();

  await db
    .update(statusUpdates)
    .set({ state: "dismissed", resolvedAt: new Date() })
    .where(
      and(
        eq(statusUpdates.id, updateId),
        eq(statusUpdates.userId, user.id),
        eq(statusUpdates.state, "pending"),
      ),
    );

  revalidatePath("/tracker");
}

/**
 * Undo an update that was applied automatically.
 *
 * The reason auto-apply is defensible at all: anything the worker did on its
 * own can be put back, by the user, without them having to remember what the
 * row said before.
 */
export async function undoUpdate(updateId: string): Promise<void> {
  const user = await requireUser();
  const db = await getDb();

  const [update] = await db
    .select()
    .from(statusUpdates)
    .where(
      and(
        eq(statusUpdates.id, updateId),
        eq(statusUpdates.userId, user.id),
        eq(statusUpdates.state, "applied"),
      ),
    )
    .limit(1);

  if (!update || !update.previousStatus) return;

  await db
    .update(jobStatus)
    .set({ status: update.previousStatus as JobStatus, updatedAt: new Date() })
    .where(and(eq(jobStatus.userId, user.id), eq(jobStatus.jobId, update.jobId)));

  await db
    .update(statusUpdates)
    .set({ state: "dismissed", resolvedAt: new Date() })
    .where(eq(statusUpdates.id, update.id));

  revalidatePath("/tracker");
  revalidatePath(`/jobs/${update.jobId}`);
}

/**
 * Stop reading mail for this user.
 *
 * Disabling rather than deleting the row: the alias must stay claimed. If it
 * were freed and later re-issued to somebody else, mail still arriving from
 * an old forwarding filter would land in a stranger's tracker.
 */
export async function setInboxEnabled(enabled: boolean): Promise<void> {
  // See getForwardingAddress: reachable from settings before onboarding, so a
  // bare requireUser() would redirect instead of honouring the click.
  const user = await requireUser({ allowUnonboarded: true });
  const db = await getDb();

  await ensureMailbox(user.id);
  await db
    .update(mailboxes)
    .set({ enabled, lastError: "" })
    .where(eq(mailboxes.userId, user.id));

  revalidatePath("/settings");
}
