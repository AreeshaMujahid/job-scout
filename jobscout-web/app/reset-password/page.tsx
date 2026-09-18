import Link from "next/link";

import { ResetPasswordForm } from "./ResetPasswordForm";

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const { token } = await searchParams;

  // The token is not checked here, only carried. Spending it on a page view
  // would mean a mail client that prefetches links burns the reset before
  // the person ever sees the form.
  if (typeof token !== "string" || !token) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
        <h1 className="text-3xl font-bold tracking-tight">Nothing to reset</h1>
        <p className="hint mt-2">
          This page needs the link from your email.{" "}
          <Link href="/forgot-password" className="font-medium text-brand hover:underline">
            Ask for a new one
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <Link href="/signin" className="mb-10 text-sm font-semibold text-brand hover:underline">
        ← Sign in
      </Link>

      <h1 className="text-3xl font-bold tracking-tight">Choose a new password</h1>
      <p className="hint mt-2">
        Setting it signs you in, and signs out anything else that was using your account.
      </p>

      <ResetPasswordForm token={token} />
    </main>
  );
}
