import { eq } from "drizzle-orm";

import { secretsMatch } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { mailboxes } from "@/lib/db/schema";
import { aliasFromAddress, inboxConfigured, recordMessage } from "@/lib/inbox/mailbox";
import { parseInbound } from "@/lib/inbox/parse";

/**
 * Where forwarded application mail lands.
 *
 * Open to the internet by necessity, so it is written to be dull: it
 * authenticates the caller, stores at most one truncated row, and answers
 * 200 to almost everything.
 *
 * The 200-to-everything is deliberate, not sloppiness. Inbound providers
 * retry any non-2xx, so returning an error for mail we simply do not want --
 * an unknown alias, a disabled mailbox -- buys an endless redelivery loop for
 * a message that will never become wanted. Those get logged and accepted.
 * Only a bad secret (401) and unparseable JSON (400) refuse.
 */

export const runtime = "nodejs";

// Mail is not big, but a body is unbounded and this endpoint is public.
const MAX_BYTES = 1_000_000;

function unauthorised() {
  return Response.json({ error: "unauthorised" }, { status: 401 });
}

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.INBOUND_SECRET;
  if (!expected) {
    // Refusing to run unauthenticated rather than defaulting to open: an
    // unset secret in production would otherwise mean anyone can inject mail
    // into any user's tracker, and fail silently while looking healthy.
    console.error("[inbound] INBOUND_SECRET is not set; refusing all inbound mail");
    return unauthorised();
  }

  // Providers differ on where they put the shared secret, so both the header
  // and a query parameter are accepted -- Cloudflare Email Workers can set a
  // header, a plain SMTP-to-webhook relay often can only sign the URL.
  const url = new URL(request.url);
  const presented =
    request.headers.get("x-inbound-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    url.searchParams.get("secret") ??
    "";

  if (!presented || !secretsMatch(presented, expected)) return unauthorised();

  // Authenticated, but the feature is not set up. Refusing here keeps the
  // failure legible -- without a domain there is no alias to resolve, and
  // letting that surface as a 500 would look like a broken endpoint rather
  // than an unconfigured one.
  if (!inboxConfigured()) {
    console.error("[inbound] INBOUND_DOMAIN is not set; cannot route inbound mail");
    return Response.json({ error: "inbound mail is not configured" }, { status: 503 });
  }

  const raw = await request.text();
  if (raw.length > MAX_BYTES) {
    console.warn("[inbound] rejected oversized payload:", raw.length);
    return Response.json({ ok: true, ignored: "too large" });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const mail = parseInbound(payload);
  if (!mail) return Response.json({ ok: true, ignored: "unrecognised payload" });

  const alias = aliasFromAddress(mail.recipient);
  if (!alias) return Response.json({ ok: true, ignored: "not an inbox address" });

  const db = await getDb();
  const [mailbox] = await db
    .select({ userId: mailboxes.userId, enabled: mailboxes.enabled })
    .from(mailboxes)
    .where(eq(mailboxes.alias, alias))
    .limit(1);

  // An unknown or switched-off alias is accepted and dropped. The response
  // says nothing about which it was: this endpoint is a public oracle, and a
  // distinguishable answer would let anyone enumerate live addresses.
  if (!mailbox || !mailbox.enabled) return Response.json({ ok: true });

  const stored = await recordMessage({
    userId: mailbox.userId,
    externalId: mail.externalId,
    sender: mail.sender,
    subject: mail.subject,
    body: mail.body,
    receivedAt: mail.receivedAt,
  });

  // The worker picks it up on its next pass; nothing is classified inline.
  // A webhook that waits on a model call is a webhook that times out and
  // gets redelivered while the first attempt is still running.
  return Response.json({ ok: true, stored });
}
