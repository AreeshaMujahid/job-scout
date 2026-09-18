import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { PreferencesForm } from "@/components/PreferencesForm";

export default async function PreferencesPage() {
  const user = await requireUser({ allowUnonboarded: true });

  // Nothing to confirm until a CV has been read.
  if (!user.profile) redirect("/onboarding");

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="text-sm font-semibold uppercase tracking-widest text-brand">Step 2 of 2</p>
      <h1 className="mt-3 text-3xl font-bold tracking-tight">What are you looking for?</h1>
      <p className="hint mt-3">
        Your CV suggested the roles below. Change them if they are wrong — they are what gets
        searched for.
      </p>

      <div className="card mt-8 p-5">
        <p className="font-medium">{user.profile.headline}</p>
        <p className="hint">
          {user.profile.seniority} · {user.profile.yearsExperience ?? 0} years ·{" "}
          {user.profile.domains.slice(0, 3).join(", ")}
        </p>
      </div>

      <PreferencesForm profile={user.profile} submitLabel="Find my jobs" />
    </main>
  );
}
