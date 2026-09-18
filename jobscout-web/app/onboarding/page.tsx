import Link from "next/link";

import { requireUser } from "@/lib/auth/session";
import { UploadForm } from "./UploadForm";

export default async function OnboardingPage() {
  const user = await requireUser({ allowUnonboarded: true });
  const existing = user.profile;

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="text-sm font-semibold uppercase tracking-widest text-brand">Step 1 of 2</p>
      <h1 className="mt-3 text-3xl font-bold tracking-tight">Upload your CV</h1>
      <p className="hint mt-3">
        It is read once, to work out what you do and which job titles that maps to. You confirm
        those titles on the next screen.
      </p>

      {existing?.headline && (
        <div className="card mt-8 p-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Already on file
          </p>
          <p className="mt-2 font-medium">{existing.headline}</p>
          <p className="hint">
            From {existing.cvFilename}. Upload a new file to replace it, or{" "}
            <Link href="/onboarding/preferences" className="font-medium text-brand hover:underline">
              skip to your preferences
            </Link>
            .
          </p>
        </div>
      )}

      <UploadForm />

      <p className="mt-8 text-xs text-ink-faint">
        Your CV text is stored so jobs can be scored against it, and is deleted with your account.
      </p>
    </main>
  );
}
