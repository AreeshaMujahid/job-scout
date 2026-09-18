import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, lt } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { profiles, sessions, users } from "@/lib/db/schema";
import type { Profile, User } from "@/lib/db/schema";

export const SESSION_COOKIE = "jobscout_session";
const SESSION_TTL_DAYS = 30;

/**
 * Opaque random session ids in a table, not a signed JWT.
 *
 * The point is revocation: signing out, deleting an account, or a stolen
 * cookie all need the session to stop working immediately, and a stateless
 * token cannot be withdrawn before it expires.
 */
export async function createSession(userId: string): Promise<void> {
  const db = await getDb();
  const id = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);

  await db.insert(sessions).values({ id, userId, expiresAt });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;

  if (id) {
    const db = await getDb();
    await db.delete(sessions).where(eq(sessions.id, id));
  }
  jar.delete(SESSION_COOKIE);
}

export type SignedInUser = User & { profile: Profile | null };

/** The current user, or null. Safe to call from any server component. */
export async function getCurrentUser(): Promise<SignedInUser | null> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (!id) return null;

  const db = await getDb();
  const [row] = await db
    .select({ user: users, profile: profiles })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (!row) return null;
  return { ...row.user, profile: row.profile };
}

/**
 * The current user, or a redirect. Use in any page behind sign-in.
 *
 * Onboarding is part of being signed in: a user with no profile is sent to
 * finish it rather than shown an empty feed. `allowUnonboarded` lets the
 * onboarding and settings screens opt out of that bounce.
 */
export async function requireUser(
  options: { allowUnonboarded?: boolean } = {},
): Promise<SignedInUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!options.allowUnonboarded && !user.onboardedAt) redirect("/onboarding");
  return user;
}

export async function purgeExpiredSessions(): Promise<void> {
  const db = await getDb();
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
