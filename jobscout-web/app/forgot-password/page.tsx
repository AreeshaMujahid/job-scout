import Link from "next/link";

import { ForgotPasswordForm } from "./ForgotPasswordForm";

export default function ForgotPasswordPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <Link href="/signin" className="mb-10 text-sm font-semibold text-brand hover:underline">
        ← Sign in
      </Link>

      <h1 className="text-3xl font-bold tracking-tight">Forgot your password</h1>
      <p className="hint mt-2">
        Give us the address on your account and we will send a link to set a new password.
      </p>

      <ForgotPasswordForm />
    </main>
  );
}
