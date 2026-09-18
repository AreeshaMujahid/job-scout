import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, lt, sql } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { inboundMessages, mailboxes, type Mailbox, type MailboxProvider } from "@/lib/db/schema";

/**
 * Forwarding addresses, and the rows behind them.
 *
 * The address is the whole trick of the forwarding provider: the user points
 * one filter in their own mail client at it, and from then on the only mail
 * we can see is mail they chose to send us. No provider grants anything, no
 * scope is requested, and revoking it is deleting their own filter.
 */

/**
 * Is inbox tracking set up on this deployment at all?
 *
 * It needs a domain whose MX records point at an inbound provider, which a
 * fresh clone does not have. Everything else in this app runs with no
 * configuration -- an embedded database, sign-in links printed to the
 * terminal -- and a feature that crashed the settings page until someone
 * bought a domain would break that. Callers that can offer the feature check
 * this first; the ones that cannot proceed without it still throw.
 */
export function inboxConfigured(): boolean {
  return Boolean(process.env.INBOUND_DOMAIN?.trim());
}

/** The domain inbound mail is accepted on, e.g. "inbox.jobscout.app". */
export function inboxDomain(): string {
  const domain = process.env.INBOUND_DOMAIN;
  if (!domain) {
    throw new Error(
      "INBOUND_DOMAIN must be set (e.g. inbox.example.com) before forwarding " +
        "addresses can be handed out.",
    );
  }
  return domain.trim().toLowerCase().replace(/^@/, "");
}

/**
 * A fresh alias.
 *
 * Random rather than derived from the user id or e-mail: the address ends up
 * in a filter in somebody's mail client and in message headers, so it must
 * not be guessable from a known user, and it must not leak who the user is
 * to anyone who sees it.
 */
function newAlias(): string {
  return `u${randomBytes(9).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

export function addressFor(alias: string): string {
  return `${alias}@${inboxDomain()}`;
}

/** Parse the alias out of a recipient address, or null if it is not one of ours. */
export function aliasFromAddress(address: string): string | null {
  // Envelope recipients arrive in every shape from "Name <a@b>" to "<a@b>".
  const match = address.match(/[\w.+-]+@[\w.-]+/);
  if (!match) return null;

  const [local, domain] = match[0].toLowerCase().split("@");
  if (domain !== inboxDomain()) return null;

  // Strip any "+tag" a forwarder may have appended -- the alias is the part
  // before it, and dropping the tag is what keeps a tagged copy routable.
  return local.split("+")[0] || null;
}

export async function getMailbox(userId: string): Promise<Mailbox | null> {
  const db = await getDb();
  const [row] = await db.select().from(mailboxes).where(eq(mailboxes.userId, userId)).limit(1);
  return row ?? null;
}

/**
 * The user's mailbox row, created on first use.
 *
 * Every user gets an alias whether or not they use forwarding, so the address
 * can be shown on the settings page without a write happening behind a page
 * view. The retry loop covers the vanishingly unlikely alias collision.
 */
export async function ensureMailbox(
  userId: string,
  provider: MailboxProvider = "forward",
): Promise<Mailbox> {
  const existing = await getMailbox(userId);
  if (existing) return existing;

  const db = await getDb();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [row] = await db
      .insert(mailboxes)
      .values({ userId, provider, alias: newAlias() })
      .onConflictDoNothing()
      .returning();
    if (row) return row;

    // Conflict on user_id means a concurrent request won the race; conflict
    // on alias means we drew a taken one. Re-read tells the two apart.
    const raced = await getMailbox(userId);
    if (raced) return raced;
  }
  throw new Error("Could not allocate a forwarding address");
}

/** Record why syncing stopped, so the settings page can tell the user. */
export async function recordSyncError(userId: string, message: string): Promise<void> {
  const db = await getDb();
  await db
    .update(mailboxes)
    .set({ lastError: message.slice(0, 500), lastSyncAt: new Date() })
    .where(eq(mailboxes.userId, userId));
}

export async function recordSyncSuccess(userId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(mailboxes)
    .set({ lastError: "", lastSyncAt: new Date() })
    .where(eq(mailboxes.userId, userId));
}

/** How much of a message the classifier sees. Mirrors job_scout/inbox.py. */
export const BODY_CHARS = 1200;

/**
 * Store a received message, ignoring one we already have.
 *
 * Returns true when the row is new. Redelivery is routine -- inbound webhooks
 * retry until they get a 2xx, and Gmail polls overlap -- so a duplicate is a
 * no-op rather than an error, and never a second trip through the classifier.
 */
export async function recordMessage(input: {
  userId: string;
  externalId: string;
  sender: string;
  subject: string;
  body: string;
  receivedAt: Date;
}): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .insert(inboundMessages)
    .values({
      id: randomUUID(),
      userId: input.userId,
      externalId: input.externalId,
      sender: input.sender.slice(0, 320),
      subject: input.subject.slice(0, 500),
      body: input.body.slice(0, BODY_CHARS),
      receivedAt: input.receivedAt,
    })
    .onConflictDoNothing()
    .returning({ id: inboundMessages.id });

  return Boolean(row);
}

/**
 * Drop messages older than the retention window.
 *
 * This is a tracker, not a mail archive. Once a message has been classified
 * there is no further use for its text, and keeping other people's
 * correspondence indefinitely is a liability rather than a feature -- the
 * decision it produced lives on in status_updates, with its one quoted line.
 */
export async function purgeOldMessages(): Promise<number> {
  const days = Number(process.env.INBOX_RETENTION_DAYS ?? 30);
  if (!Number.isFinite(days) || days <= 0) return 0;

  const db = await getDb();
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const deleted = await db
    .delete(inboundMessages)
    .where(and(lt(inboundMessages.receivedAt, cutoff), sql`${inboundMessages.processedAt} IS NOT NULL`))
    .returning({ id: inboundMessages.id });

  return deleted.length;
}
