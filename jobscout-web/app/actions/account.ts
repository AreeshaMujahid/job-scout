"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { destroySession, requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { loginTokens, users } from "@/lib/db/schema";

export type DeleteState = { status: "idle" | "error"; message: string };

/**
 * Delete the account, for real.
 *
 * Every table that holds anything personal references users.id with ON DELETE
 * CASCADE, so this one statement takes the profile, the CV text, every rating
 * and the whole tracker with it. Jobs stay: they are public postings that
 * belong to nobody. Outstanding sign-in links are cleared too, or a link
 * already in the inbox would quietly recreate the account.
 */
export async function deleteAccount(
  _previous: DeleteState,
  formData: FormData,
): Promise<DeleteState> {
  const user = await requireUser({ allowUnonboarded: true });

  const typed = String(formData.get("confirm") ?? "").trim().toLowerCase();
  if (typed !== user.email.toLowerCase()) {
    return {
      status: "error",
      message: "Type your email address exactly to confirm. Nothing has been deleted.",
    };
  }

  const db = await getDb();
  await db.delete(loginTokens).where(eq(loginTokens.email, user.email));
  await db.delete(users).where(eq(users.id, user.id));

  await destroySession();
  redirect("/?deleted=1");
}
