import { NextResponse, type NextRequest } from "next/server";

import { upsertVerifiedUser } from "@/lib/auth/accounts";
import { createSession } from "@/lib/auth/session";
import { consumeLoginToken } from "@/lib/auth/tokens";

/**
 * The other end of the magic link.
 *
 * Signing in and signing up are still the same act here: an address that has
 * never been seen gets a user row, with no password, and can set one later
 * from settings if they want one.
 *
 * Arriving here at all proves the address -- the token was only ever sent to
 * it -- so this is also a verification. That matters for anyone who signed up
 * with a password, never clicked the confirmation mail, and later asked for a
 * sign-in link instead: the link confirms them just as the other mail would.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const email = await consumeLoginToken(token, "signin");

  if (!email) {
    return NextResponse.redirect(new URL("/signin?error=expired", request.url));
  }

  const user = await upsertVerifiedUser(email);
  await createSession(user.id);

  // New users, and anyone who abandoned onboarding, finish that first.
  return NextResponse.redirect(new URL(user.onboardedAt ? "/feed" : "/onboarding", request.url));
}
