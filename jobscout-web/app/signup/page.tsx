import Link from "next/link";
import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth/session";
import { SignUpForm } from "./SignUpForm";

export default async function SignUpPage() {
  if (await getCurrentUser()) redirect("/feed");

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <Link href="/" className="mb-10 text-sm font-semibold text-brand hover:underline">
        ← Job Scout
      </Link>

      <h1 className="text-3xl font-bold tracking-tight">Create an account</h1>
      <p className="hint mt-2">
        We send one email to confirm the address is yours. Nothing else, ever.
      </p>

      <SignUpForm />

      <p className="mt-8 text-sm text-ink-soft">
        Already have an account?{" "}
        <Link href="/signin" className="font-medium text-brand hover:underline">
          Sign in
        </Link>
      </p>

      <p className="mt-4 text-xs text-ink-faint">
        You can delete your account, and everything in it, from Settings at any time.
      </p>
    </main>
  );
}
