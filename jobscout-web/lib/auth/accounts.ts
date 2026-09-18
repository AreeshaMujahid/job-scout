import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { sessions, users, type User } from "@/lib/db/schema";
import { fakeVerify, hashPassword, needsRehash, verifyPassword } from "@/lib/auth/password";

/**
 * What the database does about passwords, kept away from what the forms say
 * about them.
 *
 * Everything here returns a result rather than throwing or redirecting, so
 * the caller decides what the user is told. That split matters because the
 * honest answer and the safe answer are often different: this module knows
 * whether an address exists, and app/actions/auth.ts is careful never to
 * repeat that back to whoever typed it in.
 */

/** Consecutive failures before the account stops accepting attempts. */
const MAX_FAILED_LOGINS = 8;
/** How long it then refuses, regardless of the password offered. */
const LOCKOUT_MINUTES = 15;

export type SignInOutcome =
  | { ok: true; user: User }
  /** Wrong password, no such address, or that account has no password set. */
  | { ok: false; reason: "bad-credentials" }
  /** Correct password, but the address was never confirmed. */
  | { ok: false; reason: "unverified"; email: string }
  /** Too many recent failures. `until` is when it will listen again. */
  | { ok: false; reason: "locked"; until: Date };

export async function findByEmail(email: string): Promise<User | null> {
  const db = await getDb();
  const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return row ?? null;
}

/**
 * Create an account that signs in with a password.
 *
 * The address is NOT verified by this. The caller sends a confirmation link
 * and `checkPassword` refuses until it has been clicked -- anyone can type a
 * stranger's address into a sign-up form, and without that an account could
 * be created and used in the name of someone who never asked for one.
 */
export async function createAccount(email: string, password: string): Promise<User> {
  const db = await getDb();
  const [row] = await db
    .insert(users)
    .values({ id: randomUUID(), email, passwordHash: await hashPassword(password) })
    .returning();
  return row;
}

/**
 * Give an existing account a password.
 *
 * For the accounts that predate passwords, and for anyone who has only ever
 * signed in by link. Every existing session is dropped: setting a password is
 * either the owner securing their account or someone who should not be there,
 * and both cases are better served by everything having to sign in again.
 */
export async function setPassword(userId: string, password: string): Promise<void> {
  const db = await getDb();
  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(password),
      failedLogins: 0,
      lockedUntil: null,
      // Choosing a password through a link sent to the address proves the
      // address, so this is the moment it becomes verified if it was not.
      emailVerifiedAt: new Date(),
    })
    .where(eq(users.id, userId));

  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** Mark an address confirmed. Idempotent: clicking twice is not an error. */
export async function markVerified(userId: string): Promise<void> {
  const db = await getDb();
  await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId));
}

/**
 * Check an email and password.
 *
 * Every path costs about the same wall-clock time. An address with no
 * account, and one whose account has no password, both still run a hash --
 * otherwise the fast answer is itself the answer, and the form becomes a way
 * to enumerate who has signed up here.
 */
export async function checkPassword(email: string, password: string): Promise<SignInOutcome> {
  const db = await getDb();
  const user = await findByEmail(email);

  if (!user || !user.passwordHash) {
    await fakeVerify();
    return { ok: false, reason: "bad-credentials" };
  }

  // Checked before the password, so a locked account cannot be probed for
  // which password is the right one by watching what it says.
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    await fakeVerify();
    return { ok: false, reason: "locked", until: user.lockedUntil };
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    const failed = user.failedLogins + 1;
    await db
      .update(users)
      .set({
        failedLogins: failed,
        lockedUntil:
          failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
      })
      .where(eq(users.id, user.id));

    return { ok: false, reason: "bad-credentials" };
  }

  // Right password. Clear the counter first: an unverified account that
  // proves it knows the password should not stay one attempt from a lockout.
  if (user.failedLogins > 0 || user.lockedUntil) {
    await db
      .update(users)
      .set({ failedLogins: 0, lockedUntil: null })
      .where(eq(users.id, user.id));
  }

  if (!user.emailVerifiedAt) {
    return { ok: false, reason: "unverified", email: user.email };
  }

  // The stored hash is cheaper than the one we would make today -- upgrade
  // it now, while the plaintext is in hand. The user notices nothing.
  if (needsRehash(user.passwordHash)) {
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(password) })
      .where(eq(users.id, user.id));
  }

  return { ok: true, user };
}

/**
 * The user for an address, created if there is none.
 *
 * The magic-link path: arriving by a link sent to an address proves the
 * address, so it both creates the account and verifies it. Accounts made this
 * way have no password until someone sets one.
 */
export async function upsertVerifiedUser(email: string): Promise<User> {
  const db = await getDb();
  const existing = await findByEmail(email);

  if (existing) {
    if (!existing.emailVerifiedAt) await markVerified(existing.id);
    return existing;
  }

  const [row] = await db
    .insert(users)
    .values({ id: randomUUID(), email, emailVerifiedAt: new Date() })
    .returning();
  return row;
}
