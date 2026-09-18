import Link from "next/link";
import { count, eq } from "drizzle-orm";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { jobStatus, ratings } from "@/lib/db/schema";
import { PreferencesForm } from "@/components/PreferencesForm";
import { InboxSettings } from "@/components/InboxSettings";
import { addressFor, ensureMailbox, inboxConfigured } from "@/lib/inbox/mailbox";
import { DeleteAccount } from "./DeleteAccount";
import { visaLabel } from "@/lib/preferences";

export default async function SettingsPage() {
  // Deliberately reachable before onboarding is finished. Someone who signed
  // up and stopped still has an account, and must be able to delete it
  // without first being made to upload a CV.
  const user = await requireUser({ allowUnonboarded: true });
  const profile = user.profile;

  // Allocated on first view rather than at sign-up, so the address exists
  // the moment somebody comes looking for it. Skipped entirely where no
  // inbound domain is configured -- a fresh clone has none, and handing out
  // an address nothing can deliver to would be worse than saying nothing.
  const mailbox = inboxConfigured() ? await ensureMailbox(user.id) : null;

  const db = await getDb();
  const [[rated], [tracked]] = await Promise.all([
    db.select({ value: count() }).from(ratings).where(eq(ratings.userId, user.id)),
    db.select({ value: count() }).from(jobStatus).where(eq(jobStatus.userId, user.id)),
  ]);

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-3xl font-bold tracking-tight">Settings</h1>

      {/* Account ------------------------------------------------------ */}
      <section className="card mt-8 p-6">
        <h2 className="font-semibold">Account</h2>
        <dl className="mt-4 space-y-3 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-ink-soft">Email</dt>
            <dd className="font-medium">{user.email}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-soft">CV on file</dt>
            <dd className="font-medium">{profile?.cvFilename ?? "None"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-soft">Work authorisation</dt>
            <dd className="font-medium">{visaLabel(profile?.visaStatus ?? null)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-soft">Jobs scored</dt>
            <dd className="font-medium">{rated.value}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-soft">Jobs tracked</dt>
            <dd className="font-medium">{tracked.value}</dd>
          </div>
        </dl>

        <Link href="/onboarding" className="btn-secondary mt-5">
          {profile ? "Replace my CV" : "Upload a CV"}
        </Link>
      </section>

      {/* Application e-mail -------------------------------------------- */}
      {mailbox && (
        <InboxSettings
          address={addressFor(mailbox.alias)}
          enabled={mailbox.enabled}
          lastSyncAt={mailbox.lastSyncAt}
          lastError={mailbox.lastError}
        />
      )}

      {/* Search preferences ------------------------------------------- */}
      {profile && (
        <section className="mt-10">
          <h2 className="text-xl font-bold tracking-tight">What you are looking for</h2>
          <p className="hint mt-1">
            Changes apply to your next search. Jobs already scored keep their scores.
          </p>
          <PreferencesForm profile={profile} submitLabel="Save preferences" />
        </section>
      )}

      {/* Danger zone -------------------------------------------------- */}
      <section className="mt-16 rounded-xl border border-danger/30 bg-danger-soft p-6">
        <h2 className="font-semibold text-danger">Delete my account</h2>
        <p className="mt-2 text-sm text-ink-soft">
          This removes your account, your CV and its text, every score, and your whole tracker.
          It happens immediately and cannot be undone. Job postings themselves are public listings
          and stay in the shared database, with nothing linking them to you.
        </p>
        <DeleteAccount email={user.email} />
      </section>
    </div>
  );
}
