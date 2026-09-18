import { and, eq } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { mailboxes } from "@/lib/db/schema";
import { gmailConnectorEnabled, pollGmail } from "@/lib/inbox/gmail";
import { purgeOldMessages } from "@/lib/inbox/mailbox";
import { syncUser, usersWithUnprocessedMail } from "@/lib/inbox/sync";

/**
 * The daily check, as a process rather than a cron endpoint.
 *
 * Run alongside the app (see docker-compose.yml). It does three things on a
 * loop: poll any connected Gmail mailboxes, classify whatever mail has
 * arrived by either route, and drop messages past their retention window.
 *
 * Written to keep running. One user's model timeout, one revoked Google
 * grant, one malformed message must not stop the other users' sync -- so
 * every unit of work is wrapped, and the loop's own failure mode is to log
 * and wait for the next tick rather than exit. The process exits only on a
 * signal, and finishes the pass it is in before it does.
 */

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_SECONDS ?? 900) * 1000;

let stopping = false;

function log(message: string, extra: Record<string, unknown> = {}): void {
  // One JSON object per line: greppable in `docker compose logs`, and ready
  // for a log shipper the day there is one.
  console.log(JSON.stringify({ at: new Date().toISOString(), message, ...extra }));
}

/** Poll every connected Gmail mailbox. No-op while the connector is off. */
async function pollConnectedMailboxes(): Promise<number> {
  if (!gmailConnectorEnabled()) return 0;

  const db = await getDb();
  const connected = await db
    .select()
    .from(mailboxes)
    .where(and(eq(mailboxes.provider, "gmail"), eq(mailboxes.enabled, true)));

  let fetched = 0;
  for (const mailbox of connected) {
    if (stopping) break;
    try {
      fetched += await pollGmail(mailbox);
    } catch (cause) {
      // pollGmail handles its own errors; this is the backstop for anything
      // it did not anticipate, so one mailbox cannot end the pass.
      log("gmail poll failed", { userId: mailbox.userId, error: String(cause) });
    }
  }
  return fetched;
}

/** Classify whatever has arrived, for every user with mail waiting. */
async function classifyWaiting(): Promise<void> {
  const userIds = await usersWithUnprocessedMail();
  if (userIds.length === 0) return;

  log("classifying", { users: userIds.length });

  for (const userId of userIds) {
    if (stopping) break;
    try {
      const result = await syncUser(userId);
      if (result.updatesDetected > 0 || result.errors.length > 0) {
        log("sync", {
          userId,
          read: result.messagesRead,
          detected: result.updatesDetected,
          auto: result.autoApplied,
          pending: result.pending,
          errors: result.errors,
        });
      }
    } catch (cause) {
      log("sync failed", { userId, error: String(cause) });
    }
  }
}

async function pass(): Promise<void> {
  const started = Date.now();
  try {
    const fetched = await pollConnectedMailboxes();
    await classifyWaiting();
    const purged = await purgeOldMessages();
    log("pass complete", { ms: Date.now() - started, fetched, purged });
  } catch (cause) {
    // A pass can fail wholesale -- the database is down, the rating service
    // is unreachable. Log it and wait for the next tick; exiting would take
    // the restart decision away from the supervisor that should make it.
    log("pass failed", { error: String(cause) });
  }
}

async function main(): Promise<void> {
  log("worker started", {
    intervalSeconds: INTERVAL_MS / 1000,
    gmailConnector: gmailConnectorEnabled(),
    autoApply: process.env.INBOX_AUTO_APPLY === "true",
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      // Finish the pass in flight rather than leaving messages half-processed.
      log("stopping", { signal });
      stopping = true;
    });
  }

  while (!stopping) {
    await pass();
    if (stopping) break;
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }

  log("worker stopped");
  process.exit(0);
}

void main();
