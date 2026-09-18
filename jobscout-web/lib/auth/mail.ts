import nodemailer from "nodemailer";

export type DeliveryResult =
  | { delivered: true }
  /**
   * No mail server configured. The caller may show the link on screen, but
   * only in development -- see `canRevealLink`.
   */
  | { delivered: false; link: string };

function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
}

/**
 * Never true in production. If mail is misconfigured on a deployed box the
 * sign-in page must fail closed, not print a working sign-in link to whoever
 * typed an address into it.
 */
export function canRevealLink(): boolean {
  return process.env.NODE_ENV !== "production" && !smtpConfigured();
}

/**
 * One send, whatever the mail is for.
 *
 * All three mails here are the same object: a single-use link, a sentence
 * saying what it does and how long it lasts, and a line telling anyone who
 * did not ask for it to ignore it. Keeping the transport and the no-SMTP
 * fallback in one place is what stops a fourth mail shipping without the
 * fallback -- which on a machine with no mail server means a link nobody can
 * ever see and a form that silently does nothing.
 */
async function deliver(options: {
  email: string;
  link: string;
  subject: string;
  heading: string;
  /** What the link does and how long it lasts. Shown in both text and HTML. */
  explanation: string;
  button: string;
  /** How this link is labelled when printed to the terminal in development. */
  label: string;
}): Promise<DeliveryResult> {
  const { email, link, subject, heading, explanation, button, label } = options;

  if (!smtpConfigured()) {
    // Dev: the terminal running `npm run dev` is the inbox.
    console.log(`\n  ${label} for ${email}:\n  ${link}\n`);
    return { delivered: false, link };
  }

  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASSWORD! },
  });

  await transport.sendMail({
    from: process.env.MAIL_FROM ?? process.env.SMTP_USER!,
    to: email,
    subject,
    text: [
      explanation,
      "",
      link,
      "",
      "If you did not ask for it, you can ignore this email.",
    ].join("\n"),
    html: `
      <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:32rem">
        <h2 style="margin:0 0 1rem">${heading}</h2>
        <p style="margin:0 0 1.5rem;color:#475569">${explanation}</p>
        <a href="${link}"
           style="display:inline-block;background:#1e3a8a;color:#fff;padding:.75rem 1.25rem;
                  border-radius:.5rem;text-decoration:none;font-weight:600">
          ${button}
        </a>
        <p style="margin:1.5rem 0 0;color:#94a3b8;font-size:.875rem">
          If you did not ask for this, you can ignore this email.
        </p>
      </div>`,
  });

  return { delivered: true };
}

export function sendMagicLink(email: string, link: string): Promise<DeliveryResult> {
  return deliver({
    email,
    link,
    subject: "Your Job Scout sign-in link",
    heading: "Sign in to Job Scout",
    explanation: "Here is your sign-in link. It works once and expires in 15 minutes.",
    button: "Sign in",
    label: "Sign-in link",
  });
}

/** Confirm an address before the account it belongs to can be used. */
export function sendVerificationEmail(email: string, link: string): Promise<DeliveryResult> {
  return deliver({
    email,
    link,
    subject: "Confirm your Job Scout account",
    heading: "Confirm your email",
    explanation:
      "Click below to confirm this address and finish setting up your account. " +
      "The link is good for 24 hours.",
    button: "Confirm my email",
    label: "Verification link",
  });
}

/**
 * Set a new password.
 *
 * Only ever sent to an address that actually has an account. Telling an
 * address that it has no account is how a reset form becomes a way to find
 * out who has signed up here, so the caller answers identically either way
 * and simply does not send this one.
 */
export function sendPasswordReset(email: string, link: string): Promise<DeliveryResult> {
  return deliver({
    email,
    link,
    subject: "Reset your Job Scout password",
    heading: "Reset your password",
    explanation:
      "Click below to choose a new password. The link works once and expires in 15 minutes.",
    button: "Choose a new password",
    label: "Password reset link",
  });
}

/**
 * Tell someone their address is already registered.
 *
 * Sent when a sign-up names an address that already has an account. The
 * sign-up form itself must answer exactly as it does for a new address --
 * otherwise it reports who is registered here to anyone who asks -- so this
 * is where the person actually affected finds out, and it goes only to them.
 */
export function sendAccountExists(email: string, link: string): Promise<DeliveryResult> {
  return deliver({
    email,
    link,
    subject: "Someone tried to sign up with your Job Scout address",
    heading: "You already have an account",
    explanation:
      "Somebody just tried to create an account with this address. If it was you, " +
      "there is nothing to do -- sign in with your existing password, or use the " +
      "link below to set a new one.",
    button: "Set a new password",
    label: "Account-exists notice (reset link)",
  });
}
