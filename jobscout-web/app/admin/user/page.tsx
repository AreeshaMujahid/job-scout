import Link from "next/link";
import { and, desc, eq, isNull } from "drizzle-orm";

import { requireAdmin } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";
import {
  inboundMessages,
  jobStatus,
  jobs,
  mailboxes,
  profiles,
  ratings,
  statusUpdates,
  users,
} from "@/lib/db/schema";
import { timeAgo } from "@/lib/score";
import { UserActions } from "./UserActions";

export const dynamic = "force-dynamic";

/**
 * One user, for support.
 *
 * Shows the state you need to answer "why can they not get in" and "did their
 * CV tailoring work", plus the actions that fix those. What it deliberately
 * does not show: the text of anybody's forwarded mail. Subjects and senders
 * are enough to tell whether mail is arriving and being classified, which is
 * the actual question -- the bodies are other people's correspondence.
 *
 * The CV is different, and available: it is the user's own document, it is
 * what the tailoring operates on, and there is no way to check that tailoring
 * worked without looking at the file. Opening it writes an audit row.
 */
export default async function AdminUserPage({ searchParams }: PageProps<"/admin/user">) {
  await requireAdmin();
  const { email: raw } = await searchParams;
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";

  const db = await getDb();
  const [user] = email
    ? await db.select().from(users).where(eq(users.email, email)).limit(1)
    : [];

  return (
    <main>
      <h1 className="mt-8 text-2xl font-bold tracking-tight">Look up a user</h1>

      <form method="get" className="mt-4 flex flex-wrap gap-2">
        <input
          name="email"
          type="email"
          defaultValue={email}
          placeholder="them@example.com"
          className="field max-w-sm"
          autoFocus={!email}
        />
        <button type="submit" className="btn-secondary">
          Find
        </button>
      </form>

      {email && !user && (
        <p className="hint mt-6">No account with that address.</p>
      )}

      {user && <UserDetail userId={user.id} />}
    </main>
  );
}

async function UserDetail({ userId }: { userId: string }) {
  const db = await getDb();

  const [[row], [profile], [mailbox], tailored, recentMail, updates] = await Promise.all([
    db.select().from(users).where(eq(users.id, userId)).limit(1),
    db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1),
    db.select().from(mailboxes).where(eq(mailboxes.userId, userId)).limit(1),
    // Jobs this user has had a CV tailored for -- the list that answers
    // "is CV tailoring working for them".
    db
      .select({
        jobId: ratings.jobId,
        title: jobs.title,
        company: jobs.company,
        edits: ratings.tailoredCvEdits,
        at: ratings.tailoredCvAt,
      })
      .from(ratings)
      .innerJoin(jobs, eq(jobs.id, ratings.jobId))
      .where(eq(ratings.userId, userId))
      .orderBy(desc(ratings.tailoredCvAt))
      .limit(25),
    db
      .select({
        sender: inboundMessages.sender,
        subject: inboundMessages.subject,
        receivedAt: inboundMessages.receivedAt,
        processedAt: inboundMessages.processedAt,
      })
      .from(inboundMessages)
      .where(eq(inboundMessages.userId, userId))
      .orderBy(desc(inboundMessages.receivedAt))
      .limit(5),
    db
      .select({ n: statusUpdates.id })
      .from(statusUpdates)
      .where(and(eq(statusUpdates.userId, userId), eq(statusUpdates.state, "pending"))),
  ]);

  const [trackedRows, unprocessed] = await Promise.all([
    db.select({ jobId: jobStatus.jobId }).from(jobStatus).where(eq(jobStatus.userId, userId)),
    db
      .select({ id: inboundMessages.id })
      .from(inboundMessages)
      .where(and(eq(inboundMessages.userId, userId), isNull(inboundMessages.processedAt))),
  ]);

  const withEdits = tailored.filter((t) => t.edits.length > 0);
  const locked = isLocked(row.lockedUntil);

  return (
    <>
      {/* Account ------------------------------------------------------- */}
      <section className="card mt-8 p-6">
        <h2 className="font-semibold">{row.email}</h2>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <Row label="Signed up" value={timeAgo(row.createdAt)} />
          <Row
            label="Email confirmed"
            value={row.emailVerifiedAt ? timeAgo(row.emailVerifiedAt) : "NO — cannot sign in with a password"}
            bad={!row.emailVerifiedAt}
          />
          <Row label="Onboarded" value={row.onboardedAt ? timeAgo(row.onboardedAt) : "not finished"} />
          <Row
            label="Password"
            value={row.passwordHash ? "set" : "none — link sign-in only"}
          />
          <Row
            label="Failed sign-ins"
            value={String(row.failedLogins)}
            bad={row.failedLogins > 0}
          />
          <Row
            label="Locked"
            value={locked ? `until ${row.lockedUntil!.toISOString().slice(11, 16)} UTC` : "no"}
            bad={Boolean(locked)}
          />
        </dl>
      </section>

      <UserActions
        email={row.email}
        verified={Boolean(row.emailVerifiedAt)}
        locked={Boolean(locked)}
      />

      {/* CV ------------------------------------------------------------ */}
      <section className="card mt-6 p-6">
        <h2 className="font-semibold">CV</h2>
        {!profile?.cvFilename ? (
          <p className="hint mt-2">No CV uploaded.</p>
        ) : (
          <>
            <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
              <Row label="Filename" value={profile.cvFilename} />
              <Row
                label="PDF stored"
                value={profile.cvFile ? "yes — can be tailored" : "no — non-PDF upload"}
                bad={!profile.cvFile}
              />
              <Row label="Text extracted" value={`${profile.cvText?.length ?? 0} characters`} />
              <Row label="Last updated" value={timeAgo(profile.updatedAt)} />
            </dl>

            {profile.cvFile && (
              <a
                href={`/admin/user/cv?email=${encodeURIComponent(row.email)}`}
                className="btn-secondary mt-4 text-sm"
              >
                Download original CV
              </a>
            )}

            <h3 className="mt-6 text-sm font-semibold">
              Tailoring{" "}
              <span className="hint font-normal">
                {withEdits.length} of {tailored.length} rated jobs have saved edits
              </span>
            </h3>

            {withEdits.length === 0 ? (
              <p className="hint mt-2">
                No CV tailoring generated yet. Nothing to compare against.
              </p>
            ) : (
              <ul className="mt-3 space-y-2 text-sm">
                {withEdits.map((job) => (
                  <li
                    key={job.jobId}
                    className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2 last:border-0"
                  >
                    <span>
                      <span className="font-medium">{job.title}</span>
                      <span className="text-ink-soft"> · {job.company}</span>
                      <span className="hint ml-2">
                        {job.edits.length} edit{job.edits.length === 1 ? "" : "s"}
                        {job.at ? ` · ${timeAgo(job.at)}` : ""}
                      </span>
                    </span>
                    {profile.cvFile && (
                      <a
                        href={`/admin/user/cv?email=${encodeURIComponent(row.email)}&job=${encodeURIComponent(job.jobId)}`}
                        className="font-medium text-brand hover:underline"
                      >
                        Download tailored
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="hint mt-4">
              Downloading either file is recorded in the audit log on the overview page.
            </p>
          </>
        )}
      </section>

      {/* Activity ------------------------------------------------------ */}
      <section className="card mt-6 p-6">
        <h2 className="font-semibold">Activity</h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <Row label="Jobs tracked" value={String(trackedRows.length)} />
          <Row label="Updates awaiting them" value={String(updates.length)} />
          <Row
            label="Forwarding address"
            value={mailbox ? `${mailbox.provider}${mailbox.enabled ? "" : " (off)"}` : "not set up"}
          />
          <Row
            label="Last inbox sync"
            value={
              mailbox?.lastError
                ? `failed: ${mailbox.lastError}`
                : mailbox?.lastSyncAt
                  ? timeAgo(mailbox.lastSyncAt)
                  : "never"
            }
            bad={Boolean(mailbox?.lastError)}
          />
          <Row
            label="Mail waiting to classify"
            value={String(unprocessed.length)}
            bad={unprocessed.length > 20}
          />
        </dl>

        {recentMail.length > 0 && (
          <>
            <h3 className="mt-6 text-sm font-semibold">Recent forwarded mail</h3>
            <p className="hint">
              Senders and subjects only — enough to see whether mail is arriving and being
              classified. The contents are not shown here.
            </p>
            <ul className="mt-2 space-y-1 text-sm text-ink-soft">
              {recentMail.map((message, index) => (
                <li key={index} className="truncate">
                  <span className="text-ink-faint">{timeAgo(message.receivedAt)}</span>{" "}
                  {message.sender} — {message.subject || "(no subject)"}
                  {!message.processedAt && (
                    <span className="text-ink-faint"> · not yet classified</span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <p className="hint mt-6">
        <Link href="/admin" className="font-medium text-brand hover:underline">
          ← Overview
        </Link>
      </p>
    </>
  );
}

/**
 * Whether a lockout is still in force.
 *
 * Outside the component on purpose: reading the clock during render is
 * impure -- a re-render could flip the answer -- so the comparison is made
 * here and the component only renders the result.
 */
function isLocked(until: Date | null): boolean {
  return Boolean(until && until.getTime() > Date.now());
}

function Row({ label, value, bad = false }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-ink-soft">{label}</dt>
      <dd className={`text-right font-medium ${bad ? "text-danger" : ""}`}>{value}</dd>
    </div>
  );
}
