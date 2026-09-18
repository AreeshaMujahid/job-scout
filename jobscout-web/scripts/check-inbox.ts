/**
 * Checks on the parts of inbox tracking that decide things.
 *
 *   npx tsx scripts/check-inbox.ts
 *
 * No database and no model: this covers the pure functions, where the
 * failures are silent rather than loud. A forwarded message whose wrapper is
 * not stripped still classifies -- badly. An alias that matches on the wrong
 * domain still routes -- to the wrong place. Neither throws.
 */
import { open, seal, secretsMatch } from "@/lib/crypto";
import { htmlToText, parseInbound, unwrapForwarded } from "@/lib/inbox/parse";
import { addressFor, aliasFromAddress } from "@/lib/inbox/mailbox";

// Both modules read their configuration when called rather than when loaded,
// so setting it here -- after the imports ESM hoists -- is soon enough.
process.env.ENCRYPTION_KEY ??= "test-only-key-that-is-at-least-32-characters";
process.env.INBOUND_DOMAIN ??= "inbox.example.com";

const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  pass  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

console.log("\nsealing secrets");
const token = "1//0eXaMpLe-refresh-token";
const sealed = seal(token);
check("a sealed token round-trips", open(sealed) === token);
check("the ciphertext does not contain the token", !sealed.includes(token));
check("sealing twice gives different ciphertext", seal(token) !== seal(token), "the IV must be random");
check(
  "a tampered ciphertext will not open",
  (() => {
    const [iv, tag, body] = sealed.split(".");
    const flipped = Buffer.from(body, "base64url");
    flipped[0] ^= 0xff;
    try {
      open(`${iv}.${tag}.${flipped.toString("base64url")}`);
      return false;
    } catch {
      return true;
    }
  })(),
  "GCM must reject a modified row rather than decrypt it",
);
check("matching secrets compare equal", secretsMatch("hunter2", "hunter2"));
check("different secrets do not", !secretsMatch("hunter2", "hunter3"));
check("secrets of different lengths do not", !secretsMatch("short", "a much longer secret"));

console.log("\nrouting an address to a user");
check("our own address yields its alias", aliasFromAddress("u7f3a@inbox.example.com") === "u7f3a");
check("a display-name form still parses", aliasFromAddress("Job Scout <u7f3a@inbox.example.com>") === "u7f3a");
check("case is ignored", aliasFromAddress("U7F3A@Inbox.Example.COM") === "u7f3a");
check("a +tag is stripped", aliasFromAddress("u7f3a+gmail@inbox.example.com") === "u7f3a");
check(
  "another domain is refused",
  aliasFromAddress("u7f3a@evil.example.net") === null,
  "accepting any domain would let anyone inject mail into a tracker",
);
check(
  "a lookalike subdomain is refused",
  aliasFromAddress("u7f3a@inbox.example.com.evil.net") === null,
);
check("addressFor is the inverse", addressFor("u7f3a") === "u7f3a@inbox.example.com");

console.log("\nreading a forwarded message");
const forwarded = `Here you go.

---------- Forwarded message ---------
From: Recruiting <jobs@acme.example>
Date: Mon, 15 Sep 2026 at 09:14
Subject: Your application for Data Analyst
To: <someone@gmail.com>

Dear Areesha,

Unfortunately we have decided to move forward with other candidates.

Best regards,
Acme Recruiting`;

const unwrapped = unwrapForwarded(forwarded);
check(
  "the user's own covering note is dropped",
  !unwrapped.includes("Here you go"),
  "it is not part of what the employer said",
);
check(
  "the quoted headers are dropped",
  !unwrapped.includes("Subject: Your application"),
  "they push the real content past the truncation limit",
);
check(
  "the deciding sentence survives",
  unwrapped.includes("move forward with other candidates"),
  "this is the sentence the whole feature turns on",
);

check(
  "a message with no wrapper is left alone",
  unwrapForwarded("We would like to invite you to interview.") ===
    "We would like to invite you to interview.",
);

console.log("\nreading an HTML-only message");
const html = `<html><head><style>p{color:red}</style></head><body>
<p>Hi Areesha,</p><p>We&#39;d like to schedule a call &amp; meet you.</p>
<script>alert(1)</script></body></html>`;
const text = htmlToText(html);
check("the text survives", text.includes("We'd like to schedule a call & meet you"));
check("style and script contents do not", !text.includes("color:red") && !text.includes("alert"));
check("tags are gone", !text.includes("<p>"));

console.log("\nparsing a provider payload");
const postmark = parseInbound({
  OriginalRecipient: "u7f3a@inbox.example.com",
  From: "Recruiting <jobs@acme.example>",
  Subject: "Your application",
  TextBody: "We have received your application and will be in touch.",
  MessageID: "abc-123",
  Date: "Mon, 15 Sep 2026 09:14:00 +0000",
});
check("the recipient is read", postmark?.recipient === "u7f3a@inbox.example.com");
check("the body is read", postmark?.body.includes("We have received your application") === true);
check("the provider id is used for de-duplication", postmark?.externalId === "abc-123");

check(
  "the envelope recipient wins over the To: header",
  parseInbound({
    to: "someone@gmail.com",
    OriginalRecipient: "u7f3a@inbox.example.com",
    text: "body text here",
  })?.recipient === "u7f3a@inbox.example.com",
  "a forwarded message keeps the original recipient in To:",
);

check(
  "a SendGrid-shaped payload parses too",
  parseInbound({
    envelope: { to: "u7f3a@inbox.example.com" },
    from: "jobs@acme.example",
    subject: "Interview",
    "body-plain": "Are you free on Tuesday at 14:00?",
  })?.body === "Are you free on Tuesday at 14:00?",
);

check(
  "an HTML-only payload falls back to the HTML",
  parseInbound({
    recipient: "u7f3a@inbox.example.com",
    html: "<p>We regret to inform you.</p>",
  })?.body === "We regret to inform you.",
);

check("a payload with no body is refused", parseInbound({ recipient: "u7f3a@inbox.example.com" }) === null);
check("a payload with no recipient is refused", parseInbound({ text: "hello" }) === null);
check(
  "a payload with no message id still gets a stable one",
  (() => {
    const args = { recipient: "u7f3a@inbox.example.com", text: "hello there", from: "a@b.c", subject: "Hi", date: "2026-09-15T09:14:00Z" };
    return parseInbound(args)?.externalId === parseInbound(args)?.externalId;
  })(),
  "otherwise a provider that sends none would store its own retries twice",
);

console.log(`\n${failures.length === 0 ? "all checks passed" : `${failures.length} FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
