import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";

import { getCurrentUser, type SignedInUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { adminActions } from "@/lib/db/schema";

/**
 * Who may open the admin panel.
 *
 * An allowlist of addresses in the environment, not a role column. For a
 * one-person product that is the right shape: there is no admin-invite flow
 * to build, no second login to secure, no way to escalate yourself by
 * editing a row, and revoking access is an edit and a restart. Introduce a
 * real role the day somebody else needs in.
 *
 * Unset means nobody, including in development. An admin panel that defaults
 * to open is one deploy away from being open to the internet.
 */
function allowlist(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export function adminConfigured(): boolean {
  return allowlist().length > 0;
}

/**
 * The signed-in admin, or a 404.
 *
 * Both checks matter. `emailVerifiedAt` is required because the allowlist is
 * a list of addresses, and an address nobody has proven is not an identity --
 * without it, anyone who signs up as an allowlisted address gets in without
 * ever reading a mail sent to it.
 */
/**
 * Whether this request may use the sources that run on the owner's own
 * logged-in browser -- LinkedIn, Xing, Indeed.
 *
 * The owner always may. Everybody else may only when SHARE_OWNER_SOURCES is
 * switched on, and that switch is off unless someone sets it.
 *
 * It exists because the owner asked for it, twice, having been told what it
 * costs: every visitor's search then goes out through one real LinkedIn
 * account from one IP, which is the pattern that gets accounts restricted,
 * and it is the account they are job hunting with. A flag rather than a code
 * change so it can be turned off in one line when that happens, without a
 * deploy that has to be written first.
 *
 * Referrals stay owner-only whatever this says. That feature lists the
 * owner's own connections at a company, and showing those to strangers
 * exposes other people who never agreed to it -- a different problem from
 * risking your own account, and not the owner's to trade away.
 */
export function ownerSourcesShared(): boolean {
  return (process.env.SHARE_OWNER_SOURCES ?? "").trim().toLowerCase() === "true";
}

export async function canUsePersonalSources(): Promise<boolean> {
  return ownerSourcesShared() || (await isAdmin());
}

export async function requireAdmin(): Promise<SignedInUser> {
  const user = await getCurrentUser();

  // notFound(), not a redirect to sign-in and not a 403. Someone probing for
  // an admin panel should not learn that this one exists.
  if (!user || !user.emailVerifiedAt) notFound();
  if (!allowlist().includes(user.email.toLowerCase())) notFound();

  return user;
}

export async function isAdmin(): Promise<boolean> {
  const user = await getCurrentUser();
  return Boolean(
    user && user.emailVerifiedAt && allowlist().includes(user.email.toLowerCase()),
  );
}

/**
 * Record an administrative action.
 *
 * Called for everything that reads personal data or changes an account --
 * not for merely loading a dashboard of counts. Failures are logged and
 * swallowed: a broken audit insert must not block an admin from deleting an
 * account someone has asked to have deleted.
 */
export async function logAdminAction(
  actorEmail: string,
  action: string,
  subjectEmail = "",
  detail = "",
): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(adminActions).values({
      id: randomUUID(),
      actorEmail,
      action,
      subjectEmail,
      detail: detail.slice(0, 500),
    });
  } catch (error) {
    console.error("admin audit write failed", { action, subjectEmail, error });
  }
}
