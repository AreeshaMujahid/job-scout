"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";

import {
  checkPassword,
  createAccount,
  findByEmail,
  markVerified,
  setPassword,
} from "@/lib/auth/accounts";
import {
  canRevealLink,
  sendAccountExists,
  sendPasswordReset,
  sendVerificationEmail,
} from "@/lib/auth/mail";
import { passwordProblem } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { consumeLoginToken, createLoginToken, purgeExpiredTokens } from "@/lib/auth/tokens";
import { getDb } from "@/lib/db";
import { loginTokens } from "@/lib/db/schema";

/**
 * Sign up, sign in, and reset -- the password half of authentication.
 *
 * One rule shapes most of this file: **the forms must not report who has an
 * account here.** Sign-up, sign-in and reset all answer identically whether
 * or not the address is registered, because a form that says "no account
 * with that email" is a form anyone can use to test a list of addresses
 * against your user table. Where somebody genuinely needs to be told
 * something, they are told by mail, at the address in question.
 */

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("That does not look like an email address.");

/** One verification or reset mail per address per minute. */
const RESEND_COOLDOWN_SECONDS = 60;

export type AuthState = {
  status: "idle" | "ok" | "error";
  message: string;
  /**
   * The address that was submitted, echoed back so the form can put it
   * there again. React resets an uncontrolled form once its action
   * resolves, so without this every rejected password also silently wipes
   * the email and makes the user type it a second time.
   *
   * The password is deliberately not echoed. It would have to travel back
   * through the page to do it, and no convenience is worth that.
   */
  email?: string;
  /** Only ever set in development with no SMTP configured. */
  devLink?: string;
};

async function appUrl(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const head = await headers();
  const host = head.get("x-forwarded-host") ?? head.get("host") ?? "localhost:3000";
  const proto = head.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** True when a mail to this address was sent within the cooldown. */
async function sentRecently(email: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ createdAt: loginTokens.createdAt })
    .from(loginTokens)
    .where(
      and(
        eq(loginTokens.email, email),
        gt(loginTokens.createdAt, new Date(Date.now() - RESEND_COOLDOWN_SECONDS * 1000)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Create an account.
 *
 * Answers the same whether or not the address is taken. When it is, the
 * person who owns it gets a mail saying so -- which is both the security
 * answer and the kind one, since the usual cause is someone who forgot they
 * already signed up.
 */
export async function signUpAction(_previous: AuthState, formData: FormData): Promise<AuthState> {
  const parsedEmail = emailSchema.safeParse(formData.get("email"));
  if (!parsedEmail.success) {
    return {
      status: "error",
      message: parsedEmail.error.issues[0].message,
      email: String(formData.get("email") ?? ""),
    };
  }
  const email = parsedEmail.data;
  const password = String(formData.get("password") ?? "");

  // Checked before anything is created, and before the address is looked up,
  // so a weak password is rejected the same way for every address.
  const problem = passwordProblem(password, email);
  if (problem) return { status: "error", message: problem, email };

  await purgeExpiredTokens();

  const sameAnswer: AuthState = {
    status: "ok",
    message: `Check ${email} for a link to confirm your account. It is good for 24 hours.`,
  };

  if (await sentRecently(email)) {
    return {
      status: "error",
      email,
      message: "A mail was just sent to that address. Check your inbox, or try again in a minute.",
    };
  }

  const existing = await findByEmail(email);

  if (existing) {
    // Not an error to the person at the keyboard: they get the same message
    // as a new signup. The account's owner is told by mail instead, and
    // offered a reset in case they are the one who forgot.
    try {
      const token = await createLoginToken(email, "reset");
      const link = `${await appUrl()}/reset-password?token=${encodeURIComponent(token)}`;
      const result = await sendAccountExists(email, link);
      return {
        ...sameAnswer,
        devLink: !result.delivered && canRevealLink() ? result.link : undefined,
      };
    } catch (error) {
      console.error("account-exists notice failed", error);
      return sameAnswer;
    }
  }

  await createAccount(email, password);

  try {
    const token = await createLoginToken(email, "verify");
    const link = `${await appUrl()}/auth/confirm?token=${encodeURIComponent(token)}`;
    const result = await sendVerificationEmail(email, link);
    return {
      ...sameAnswer,
      message: result.delivered
        ? sameAnswer.message
        : "No mail server is configured, so the confirmation link is below.",
      devLink: !result.delivered && canRevealLink() ? result.link : undefined,
    };
  } catch (error) {
    // The account exists but the mail did not go. Say so plainly -- silence
    // here strands somebody with an account they cannot confirm.
    console.error("verification mail failed", error);
    return {
      status: "error",
      email,
      message:
        "Your account was created but the confirmation email could not be sent. " +
        "Use 'email me a link instead' on the sign-in page.",
    };
  }
}

/**
 * Sign in with a password.
 *
 * Redirects on success rather than returning, so the session cookie is set
 * on a response the browser then navigates from.
 */
export async function signInWithPassword(
  _previous: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const parsedEmail = emailSchema.safeParse(formData.get("email"));
  const password = String(formData.get("password") ?? "");

  // One message for every kind of failure below, so none of them is a
  // signal. It has to be built before the checks, not chosen after them.
  const typed = parsedEmail.success ? parsedEmail.data : String(formData.get("email") ?? "");
  const refused: AuthState = {
    status: "error",
    email: typed,
    message: "That email and password do not match an account.",
  };

  if (!parsedEmail.success || !password) return refused;

  const outcome = await checkPassword(parsedEmail.data, password);

  if (!outcome.ok) {
    if (outcome.reason === "locked") {
      const minutes = Math.max(1, Math.ceil((outcome.until.getTime() - Date.now()) / 60_000));
      return {
        status: "error",
        email: typed,
        message:
          `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, ` +
          "or use 'email me a link instead' to get in now.",
      };
    }
    if (outcome.reason === "unverified") {
      // Safe to be specific: this needs the right password, so whoever is
      // reading it already had the credentials.
      return {
        status: "error",
        email: typed,
        message:
          "Confirm your email first — check your inbox for the link we sent when you signed up.",
      };
    }
    return refused;
  }

  await createSession(outcome.user.id);
  redirect(outcome.user.onboardedAt ? "/feed" : "/onboarding");
}

/**
 * Ask for a reset link.
 *
 * Answers identically for an address with no account, so this cannot be used
 * to find out who is registered. An address that has one gets the mail.
 */
export async function requestPasswordReset(
  _previous: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const parsed = emailSchema.safeParse(formData.get("email"));
  if (!parsed.success) {
    return {
      status: "error",
      message: parsed.error.issues[0].message,
      email: String(formData.get("email") ?? ""),
    };
  }
  const email = parsed.data;
  await purgeExpiredTokens();

  const sameAnswer: AuthState = {
    status: "ok",
    message: `If ${email} has an account, a link to set a new password is on its way.`,
  };

  if (await sentRecently(email)) return sameAnswer;

  const user = await findByEmail(email);
  if (!user) return sameAnswer;

  try {
    const token = await createLoginToken(email, "reset");
    const link = `${await appUrl()}/reset-password?token=${encodeURIComponent(token)}`;
    const result = await sendPasswordReset(email, link);
    return {
      ...sameAnswer,
      devLink: !result.delivered && canRevealLink() ? result.link : undefined,
    };
  } catch (error) {
    console.error("reset mail failed", error);
    return sameAnswer;
  }
}

/**
 * Spend a reset link and set the new password.
 *
 * setPassword drops every existing session for that user, so a reset done
 * because somebody else got in also puts them out.
 */
export async function resetPasswordAction(
  _previous: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");

  // The password is judged BEFORE the token is spent. The other order burns
  // the link on a typo: the user picks something too short, is told so, and
  // the link they are standing on is already used up.
  const problem = passwordProblem(password);
  if (problem) return { status: "error", message: problem };

  const email = await consumeLoginToken(token, "reset");
  if (!email) {
    return {
      status: "error",
      message: "That link has expired or was already used. Ask for a new one.",
    };
  }

  const user = await findByEmail(email);
  if (!user) {
    return { status: "error", message: "That link is no longer valid. Ask for a new one." };
  }

  await setPassword(user.id, password);
  await createSession(user.id);
  redirect(user.onboardedAt ? "/feed" : "/onboarding");
}

/** Spend a confirmation link. Called by the /auth/confirm route. */
export async function confirmEmail(token: string): Promise<{ ok: boolean; onboarded: boolean }> {
  const email = await consumeLoginToken(token, "verify");
  if (!email) return { ok: false, onboarded: false };

  const user = await findByEmail(email);
  if (!user) return { ok: false, onboarded: false };

  await markVerified(user.id);
  // Signed in on confirmation: they have just proved the address and they
  // set the password minutes ago, so asking them to type it again is
  // friction with nothing behind it.
  await createSession(user.id);
  return { ok: true, onboarded: Boolean(user.onboardedAt) };
}
