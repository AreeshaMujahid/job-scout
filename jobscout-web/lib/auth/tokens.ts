import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { loginTokens, type TokenPurpose } from "@/lib/db/schema";

/** How long a sign-in link stays usable. Short: it arrives by email. */
export const TOKEN_TTL_MINUTES = 15;

/**
 * Verification links get longer, password resets do not.
 *
 * A verification mail is often opened hours later, on a phone, after the
 * moment of signing up has passed -- expiring it in fifteen minutes just
 * means sending it again. A reset link is the one thing that can take over
 * an account, so it keeps the short window.
 */
export const VERIFY_TTL_MINUTES = 60 * 24;
export const RESET_TTL_MINUTES = 15;

export function ttlFor(purpose: TokenPurpose): number {
  if (purpose === "verify") return VERIFY_TTL_MINUTES;
  if (purpose === "reset") return RESET_TTL_MINUTES;
  return TOKEN_TTL_MINUTES;
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Mint a sign-in link for an address.
 *
 * The raw token is returned to the caller (to put in the email) and never
 * stored -- only its SHA-256. Anyone reading the database, a backup, or a log
 * line therefore cannot sign in as this user.
 */
export async function createLoginToken(
  email: string,
  purpose: TokenPurpose = "signin",
): Promise<string> {
  const db = await getDb();
  const raw = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlFor(purpose) * 60_000);

  // Requesting a new link invalidates every outstanding one for that address,
  // whatever it was for. Deliberately across purposes: a reset supersedes a
  // sign-in link, and leaving the older one alive would mean a password just
  // changed in a panic can still be bypassed by a link already in the inbox.
  await db.delete(loginTokens).where(eq(loginTokens.email, email));
  await db.insert(loginTokens).values({ tokenHash: hashToken(raw), email, expiresAt, purpose });

  return raw;
}

/**
 * Spend a token. Returns the email it was issued to, or null.
 *
 * Single use and time limited: the row is marked used inside the same
 * conditional update that reads it, so two clicks on the same link cannot
 * both succeed.
 */
export async function consumeLoginToken(
  raw: string,
  purpose: TokenPurpose = "signin",
): Promise<string | null> {
  if (!raw) return null;

  const db = await getDb();
  const tokenHash = hashToken(raw);
  const now = new Date();

  // The purpose is part of the WHERE, not checked afterwards: a token issued
  // to verify an address must not be spendable to reset the password on it.
  // They are the same shape and travel the same way, so only this separates
  // them.
  const [row] = await db
    .update(loginTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(loginTokens.tokenHash, tokenHash),
        eq(loginTokens.purpose, purpose),
        isNull(loginTokens.usedAt),
      ),
    )
    .returning({ email: loginTokens.email, expiresAt: loginTokens.expiresAt });

  if (!row) return null;
  if (row.expiresAt.getTime() < now.getTime()) return null;

  return row.email;
}

/** Housekeeping, called opportunistically when a link is requested. */
export async function purgeExpiredTokens(): Promise<void> {
  const db = await getDb();
  await db.delete(loginTokens).where(lt(loginTokens.expiresAt, new Date()));
}

/** Constant-time compare, for anywhere a secret is checked against input. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
