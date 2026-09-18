import { NextResponse, type NextRequest } from "next/server";

import { confirmEmail } from "@/app/actions/password";

/**
 * The other end of the confirmation email.
 *
 * A GET that changes something, which is normally worth avoiding -- but the
 * thing on the other end of an email is a link, and a link is a GET. The
 * token is single-use and carries its own authority, so the usual objection
 * (a stray request doing something on a signed-in user's behalf) does not
 * apply: there is no session involved until this creates one.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  const { ok, onboarded } = await confirmEmail(token);

  if (!ok) {
    return NextResponse.redirect(new URL("/signin?error=unconfirmed", request.url));
  }
  return NextResponse.redirect(new URL(onboarded ? "/feed" : "/onboarding", request.url));
}
