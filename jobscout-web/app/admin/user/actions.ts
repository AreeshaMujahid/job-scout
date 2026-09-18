"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";

import { logAdminAction, requireAdmin } from "@/lib/auth/admin";
import { canRevealLink, sendPasswordReset, sendVerificationEmail } from "@/lib/auth/mail";
import { createLoginToken } from "@/lib/auth/tokens";
import { getDb } from "@/lib/db";
import { loginTokens, users } from "@/lib/db/schema";

/**
 * The four things support actually needs to do.
 *
 * Each one calls requireAdmin() itself. A server action is an endpoint: it is
 * reachable by anyone who can construct the request, whatever page it was
 * declared next to, so inheriting the layout's check would be no check at all.
 *
 * Every action writes an audit row.
 */

export type AdminResult = { ok: boolean; message: string; devLink?: string };

async function appUrl(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const head = await headers();
  const host = head.get("x-forwarded-host") ?? head.get("host") ?? "localhost:3000";
  const proto = head.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** For "I never got the confirmation email" -- the commonest ticket. */
export async function resendVerification(email: string): Promise<AdminResult> {
  const admin = await requireAdmin();
  const db = await getDb();

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) return { ok: false, message: "No account with that address." };
  if (user.emailVerifiedAt) {
    return { ok: false, message: "That address is already confirmed." };
  }

  const token = await createLoginToken(email, "verify");
  const link = `${await appUrl()}/auth/confirm?token=${encodeURIComponent(token)}`;
  const result = await sendVerificationEmail(email, link);

  await logAdminAction(admin.email, "resent confirmation", email);
  revalidatePath("/admin/user");

  return {
    ok: true,
    message: result.delivered ? "Confirmation email sent." : "No SMTP configured — link below.",
    devLink: !result.delivered && canRevealLink() ? result.link : undefined,
  };
}

/** For someone locked out by failed attempts who cannot wait it out. */
export async function unlockAccount(email: string): Promise<AdminResult> {
  const admin = await requireAdmin();
  const db = await getDb();

  const [updated] = await db
    .update(users)
    .set({ failedLogins: 0, lockedUntil: null })
    .where(eq(users.email, email))
    .returning({ id: users.id });

  if (!updated) return { ok: false, message: "No account with that address." };

  await logAdminAction(admin.email, "unlocked account", email);
  revalidatePath("/admin/user");
  return { ok: true, message: "Unlocked. They can try again now." };
}

/**
 * Send a reset link. The admin never sees or sets the password -- the link
 * goes to the user, and they choose it.
 */
export async function sendReset(email: string): Promise<AdminResult> {
  const admin = await requireAdmin();
  const db = await getDb();

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) return { ok: false, message: "No account with that address." };

  const token = await createLoginToken(email, "reset");
  const link = `${await appUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  const result = await sendPasswordReset(email, link);

  await logAdminAction(admin.email, "sent password reset", email);
  revalidatePath("/admin/user");

  return {
    ok: true,
    message: result.delivered ? "Reset email sent." : "No SMTP configured — link below.",
    devLink: !result.delivered && canRevealLink() ? result.link : undefined,
  };
}

/**
 * Delete an account on request.
 *
 * One statement, because everything personal cascades from users.id -- the
 * same deletion the user's own Settings page performs, proved by
 * scripts/check-deletion.mjs. A deletion request is legally time-bound, so
 * this needs to be one click rather than a database session.
 *
 * The audit row survives: it does not reference users.id.
 */
export async function deleteAccount(email: string, confirmation: string): Promise<AdminResult> {
  const admin = await requireAdmin();

  // Typed confirmation, because this is irreversible and the button sits
  // beside three that are not.
  if (confirmation.trim().toLowerCase() !== email.toLowerCase()) {
    return { ok: false, message: "Type the address exactly to confirm." };
  }

  const db = await getDb();
  const [deleted] = await db
    .delete(users)
    .where(eq(users.email, email))
    .returning({ id: users.id });

  if (!deleted) return { ok: false, message: "No account with that address." };

  // Outstanding sign-in links are keyed by address, not by user id, so they
  // outlive the cascade and have to go explicitly.
  await db.delete(loginTokens).where(eq(loginTokens.email, email));

  await logAdminAction(admin.email, "DELETED ACCOUNT", email);
  revalidatePath("/admin");
  return { ok: true, message: `${email} and everything belonging to it is gone.` };
}
