"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { and, eq, gt } from "drizzle-orm";
import { z } from "zod";

import { canRevealLink, sendMagicLink } from "@/lib/auth/mail";
import { createLoginToken, purgeExpiredTokens } from "@/lib/auth/tokens";
import { destroySession, purgeExpiredSessions } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { loginTokens } from "@/lib/db/schema";

const emailSchema = z.string().trim().toLowerCase().email("That does not look like an email address.");

/** A fresh link may be requested once a minute per address. */
const RESEND_COOLDOWN_SECONDS = 60;

export type SignInState = {
  status: "idle" | "sent" | "error";
  message: string;
  /** Only ever set in development with no SMTP configured. */
  devLink?: string;
};

async function appUrl(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  // Fall back to the host the request actually arrived on, so this works on
  // localhost and on a preview deployment without configuration.
  const head = await headers();
  const host = head.get("x-forwarded-host") ?? head.get("host") ?? "localhost:3000";
  const proto = head.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function requestMagicLink(
  _previous: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const parsed = emailSchema.safeParse(formData.get("email"));
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0].message };
  }
  const email = parsed.data;

  const db = await getDb();
  await purgeExpiredTokens();

  // Throttle. Without this, one form is a way to send someone a lot of email.
  const [recent] = await db
    .select({ createdAt: loginTokens.createdAt })
    .from(loginTokens)
    .where(
      and(
        eq(loginTokens.email, email),
        gt(loginTokens.createdAt, new Date(Date.now() - RESEND_COOLDOWN_SECONDS * 1000)),
      ),
    )
    .limit(1);

  if (recent) {
    return {
      status: "error",
      message: "A link was just sent to that address. Check your inbox, or try again in a minute.",
    };
  }

  const token = await createLoginToken(email);
  const link = `${await appUrl()}/auth/verify?token=${encodeURIComponent(token)}`;

  try {
    const result = await sendMagicLink(email, link);
    return {
      status: "sent",
      message: result.delivered
        ? `Check ${email} for a sign-in link. It expires in 15 minutes.`
        : "No mail server is configured, so the link is below.",
      devLink: !result.delivered && canRevealLink() ? result.link : undefined,
    };
  } catch (error) {
    console.error("magic link delivery failed", error);
    return {
      status: "error",
      message: "The link could not be sent. Check the mail settings and try again.",
    };
  }
}

export async function signOutAction(): Promise<void> {
  await destroySession();
  await purgeExpiredSessions();
  redirect("/");
}
