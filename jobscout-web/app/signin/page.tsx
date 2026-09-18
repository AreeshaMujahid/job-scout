import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { PasswordSignInForm } from "./PasswordSignInForm";

export default async function SignInPage({ searchParams }: PageProps<"/signin">) {
  if (await getCurrentUser()) redirect("/feed");

  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <Link href="/" className="mb-10 text-sm font-semibold text-brand hover:underline">
        ← Job Scout
      </Link>

      <h1 className="text-3xl font-bold tracking-tight">Sign in</h1>
      <p className="hint mt-2">Your email and password, or a link if you would rather.</p>

      {error === "expired" && (
        <p className="mt-6 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
          That link has already been used or has expired. Links work once — sign in below, or
          ask for a new one.
        </p>
      )}
      {error === "unconfirmed" && (
        <p className="mt-6 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
          That confirmation link has expired or was already used. Sign in and we will send
          another, or ask for a sign-in link.
        </p>
      )}

      <PasswordSignInForm />

      <p className="mt-8 text-sm text-ink-soft">
        No account yet?{" "}
        <Link href="/signup" className="font-medium text-brand hover:underline">
          Create one
        </Link>
      </p>
    </main>
  );
}
