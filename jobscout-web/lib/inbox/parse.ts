/**
 * Turning an inbound-mail webhook into the four fields a status decision needs.
 *
 * Every provider posts a different JSON shape, and none of them is worth a
 * dedicated adapter: they all carry sender, recipient, subject, a text body
 * and a message id under one of a handful of names. This reads whichever is
 * present, so swapping Postmark for SendGrid or Cloudflare Email Workers is a
 * DNS change rather than a code change.
 */

export type ParsedMail = {
  /** Where the forwarder delivered it -- this is what identifies the user. */
  recipient: string;
  sender: string;
  subject: string;
  body: string;
  externalId: string;
  receivedAt: Date;
};

const TAG = /<[^>]+>/g;
const STYLE_BLOCK = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi;
const WHITESPACE = /[ \t\xa0]+/g;

/** Plain text from an HTML part, for the senders who send nothing else. */
export function htmlToText(html: string): string {
  return html
    .replace(STYLE_BLOCK, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(TAG, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(WHITESPACE, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Cut a forwarded message down to the part the employer wrote.
 *
 * A forwarded mail arrives wrapped in the user's own client boilerplate
 * ("---------- Forwarded message ---------", quoted headers). The outcome
 * sentence is in the original, so the wrapper is noise that pushes the real
 * content past the truncation limit.
 */
export function unwrapForwarded(text: string): string {
  const markers = [
    /-{2,}\s*Forwarded message\s*-{2,}/i,
    /^\s*Begin forwarded message:\s*$/im,
    /^-{2,}\s*Original Message\s*-{2,}$/im,
  ];

  for (const marker of markers) {
    const match = text.match(marker);
    if (!match || match.index === undefined) continue;

    const after = text.slice(match.index + match[0].length);
    // Drop the quoted header block (From:/Date:/Subject:/To:) that follows the
    // marker; the body proper starts at the first blank line after it.
    const bodyStart = after.search(/\n\s*\n/);
    return (bodyStart === -1 ? after : after.slice(bodyStart)).trim();
  }
  return text;
}

function firstString(payload: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const value = payload[k];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Read a provider payload. Returns null when the essentials are missing,
 * which the route answers with a 400 rather than a retry-inducing 500.
 */
export function parseInbound(payload: Record<string, unknown>): ParsedMail | null {
  // "To" is the wrong field to trust: a forwarded message keeps the original
  // recipient there. The envelope destination -- OriginalRecipient, envelope.to,
  // rcpt_to -- is where our alias actually appears, so it is preferred.
  const envelope = (payload.envelope ?? {}) as Record<string, unknown>;
  const recipient =
    firstString(payload, ["OriginalRecipient", "recipient", "rcpt_to", "to"]) ||
    firstString(envelope, ["to", "recipient"]);

  const sender =
    firstString(payload, ["From", "from", "sender", "FromFull"]) ||
    firstString(envelope, ["from"]);

  const html = firstString(payload, ["HtmlBody", "html", "body-html"]);
  const text = firstString(payload, ["TextBody", "text", "body-plain", "plain"]);

  const body = unwrapForwarded(text || htmlToText(html));
  if (!recipient || !body) return null;

  const date = firstString(payload, ["Date", "date", "timestamp", "received_at"]);
  const parsed = date ? new Date(date) : new Date();

  return {
    recipient,
    sender,
    subject: firstString(payload, ["Subject", "subject"]),
    body,
    // Falling back to the provider's own id, then to a sender+subject key, so
    // a provider that sends no Message-ID still de-duplicates its own retries.
    externalId:
      firstString(payload, ["MessageID", "MessageId", "message_id", "Message-Id", "id"]) ||
      `${sender}:${firstString(payload, ["Subject", "subject"])}:${parsed.toISOString().slice(0, 13)}`,
    receivedAt: Number.isNaN(parsed.getTime()) ? new Date() : parsed,
  };
}
