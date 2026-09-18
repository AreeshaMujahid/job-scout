import { open } from "@/lib/crypto";
import { BODY_CHARS, recordMessage, recordSyncError, recordSyncSuccess } from "@/lib/inbox/mailbox";
import { htmlToText } from "@/lib/inbox/parse";
import type { Mailbox } from "@/lib/db/schema";

/**
 * The one-click connector, and why it is switched off by default.
 *
 * `gmail.readonly` is a Google "restricted" scope. Offering it to the public
 * requires OAuth verification plus an annual third-party CASA security
 * assessment; until that clears, the consent screen only admits test users
 * you add by hand. So this is real, tested code behind GMAIL_CONNECTOR_ENABLED
 * rather than the default path -- forwarding is what ships to everyone, and
 * this becomes available the day the assessment does.
 *
 * Read-only in the strict sense: every request below is messages.list or
 * messages.get. Nothing is sent, labelled, modified or deleted, and the body
 * is truncated before it is stored -- the goal is to move a tracker row, not
 * to mirror somebody's mail into another database.
 *
 * Talks to the REST API over fetch rather than pulling in googleapis: two
 * endpoints and a token refresh do not justify the dependency, and it keeps
 * the worker image small.
 */

export function gmailConnectorEnabled(): boolean {
  return (
    process.env.GMAIL_CONNECTOR_ENABLED === "true" &&
    Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
  );
}

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/**
 * Which mail is even looked at.
 *
 * Narrow on purpose: an application-tracking feature has no business reading
 * a whole mailbox. `newer_than` bounds it in time, the category filters drop
 * promotions and social, and the term list keeps it to mail that plausibly
 * concerns an application.
 */
const QUERY = [
  "newer_than:7d",
  "-category:promotions",
  "-category:social",
  "-in:chats",
  "(application OR applied OR candidate OR interview OR recruiter OR",
  '"your application" OR "we received" OR position OR vacancy)',
].join(" ");

class GmailError extends Error {
  constructor(
    message: string,
    /** True when polling again will never help -- a revoked or dead grant. */
    readonly fatal: boolean,
  ) {
    super(message);
    this.name = "GmailError";
  }
}

async function accessToken(refreshToken: string): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const body = (await response.json()) as { access_token?: string; error?: string };
  if (!response.ok || !body.access_token) {
    // invalid_grant means the user revoked access or changed their password.
    // That is a setup problem only they can fix, so it must stop the polling
    // and surface, not retry forever against a dead token.
    const fatal = body.error === "invalid_grant" || response.status === 400;
    throw new GmailError(
      fatal
        ? "Gmail access was revoked. Reconnect your account to resume tracking."
        : `Could not refresh Gmail access: ${body.error ?? response.status}`,
      fatal,
    );
  }
  return body.access_token;
}

type GmailHeader = { name: string; value: string };
type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
};

/** Depth-first walk for the best body part: plain text wins, HTML is the fallback. */
function extractBody(payload: GmailPart): string {
  const plain = findPart(payload, "text/plain");
  if (plain) return decode(plain);

  const html = findPart(payload, "text/html");
  return html ? htmlToText(decode(html)) : "";
}

function findPart(part: GmailPart, mimeType: string): GmailPart | null {
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

function decode(part: GmailPart): string {
  return Buffer.from(part.body?.data ?? "", "base64url").toString("utf8");
}

function header(headers: GmailHeader[], name: string): string {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/**
 * Poll one connected mailbox. Returns how many new messages were stored.
 *
 * A fatal error disables the mailbox rather than leaving it to fail on every
 * pass forever; the reason is stored so the settings page can tell the user
 * what to do about it.
 */
export async function pollGmail(mailbox: Mailbox): Promise<number> {
  if (!gmailConnectorEnabled()) return 0;
  if (!mailbox.refreshToken) return 0;

  try {
    const token = await accessToken(open(mailbox.refreshToken));
    const auth = { Authorization: `Bearer ${token}` };

    const listed = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?" +
        new URLSearchParams({ q: QUERY, maxResults: "25" }),
      { headers: auth, signal: AbortSignal.timeout(30_000) },
    );
    if (!listed.ok) throw new GmailError(`Gmail list failed: ${listed.status}`, listed.status === 401);

    const { messages = [] } = (await listed.json()) as { messages?: { id: string }[] };
    let stored = 0;

    for (const { id } of messages) {
      const detail = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
        { headers: auth, signal: AbortSignal.timeout(30_000) },
      );
      if (!detail.ok) continue; // one unreadable message is not a failed sync

      const message = (await detail.json()) as {
        id: string;
        internalDate?: string;
        payload?: { headers?: GmailHeader[] } & GmailPart;
      };
      const headers = message.payload?.headers ?? [];
      const body = message.payload ? extractBody(message.payload) : "";
      if (!body.trim()) continue;

      const created = await recordMessage({
        userId: mailbox.userId,
        // Gmail's own id, so an overlapping poll stores nothing twice.
        externalId: message.id,
        sender: header(headers, "From"),
        subject: header(headers, "Subject"),
        body: body.slice(0, BODY_CHARS),
        receivedAt: new Date(Number(message.internalDate ?? Date.now())),
      });
      if (created) stored += 1;
    }

    await recordSyncSuccess(mailbox.userId);
    return stored;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    await recordSyncError(mailbox.userId, message);

    if (cause instanceof GmailError && cause.fatal) {
      const { getDb } = await import("@/lib/db");
      const { mailboxes } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      await db.update(mailboxes).set({ enabled: false }).where(eq(mailboxes.userId, mailbox.userId));
    }
    return 0;
  }
}
