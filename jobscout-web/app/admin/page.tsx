import Link from "next/link";
import { count, desc, eq, gte, isNotNull, isNull } from "drizzle-orm";

import { getDb } from "@/lib/db";
import {
  adminActions,
  inboundMessages,
  jobStatus,
  jobs,
  profiles,
  ratings,
  statusUpdates,
  users,
} from "@/lib/db/schema";
import { scoutHealth } from "@/lib/scout";
import { timeAgo } from "@/lib/score";

// Counts change on every signup; a cached admin page is a misleading one.
export const dynamic = "force-dynamic";

/** Is the Python service answering? Its absence breaks rating and tailoring. */
async function scoutStatus(): Promise<{ ok: boolean; detail: string }> {
  try {
    const health = await scoutHealth();
    return { ok: health.ok, detail: `${health.provider} · ${health.model}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "unreachable" };
  }
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

/**
 * Everything the page draws, gathered outside the component.
 *
 * Not merely tidiness: reading the clock during render is flagged as impure,
 * because a component may be re-run at any time and would then quietly
 * produce different numbers. Fetching here and rendering the result keeps the
 * component a pure function of what it is given.
 */
async function loadOverview() {
  const db = await getDb();
  const now = Date.now();
  const dayAgo = new Date(now - 86_400_000);
  const weekAgo = new Date(now - 7 * 86_400_000);

  const [
    [allUsers],
    [verified],
    [onboarded],
    [newThisWeek],
    [locked],
    [withCv],
    [allJobs],
    [allRatings],
    [tracked],
    [pendingMail],
    [pendingUpdates],
    recent,
    recentActions,
    scout,
  ] = await Promise.all([
    db.select({ n: count() }).from(users),
    db.select({ n: count() }).from(users).where(isNotNull(users.emailVerifiedAt)),
    db.select({ n: count() }).from(users).where(isNotNull(users.onboardedAt)),
    db.select({ n: count() }).from(users).where(gte(users.createdAt, weekAgo)),
    db.select({ n: count() }).from(users).where(isNotNull(users.lockedUntil)),
    db.select({ n: count() }).from(profiles).where(isNotNull(profiles.cvFile)),
    db.select({ n: count() }).from(jobs),
    db.select({ n: count() }).from(ratings),
    db.select({ n: count() }).from(jobStatus),
    db.select({ n: count() }).from(inboundMessages).where(isNull(inboundMessages.processedAt)),
    db.select({ n: count() }).from(statusUpdates).where(eq(statusUpdates.state, "pending")),
    db
      .select({
        email: users.email,
        createdAt: users.createdAt,
        verifiedAt: users.emailVerifiedAt,
        onboardedAt: users.onboardedAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(10),
    db.select().from(adminActions).orderBy(desc(adminActions.createdAt)).limit(8),
    scoutStatus(),
  ]);

  // Signups that never confirmed. A handful is normal; a lot at once usually
  // means mail has stopped being delivered rather than that people changed
  // their minds.
  const unverified = allUsers.n - verified.n;
  const stalledToday = recent.filter(
    (row) => !row.verifiedAt && row.createdAt.getTime() > dayAgo.getTime(),
  ).length;

  return {
    allUsers, onboarded, newThisWeek, locked, withCv, allJobs, allRatings,
    tracked, pendingMail, pendingUpdates, recent, recentActions, scout,
    unverified, stalledToday,
  };
}

export default async function AdminOverview() {
  const {
    allUsers, onboarded, newThisWeek, locked, withCv, allJobs, allRatings,
    tracked, pendingMail, pendingUpdates, recent, recentActions, scout,
    unverified, stalledToday,
  } = await loadOverview();

  return (
    <main>
      <h1 className="mt-8 text-2xl font-bold tracking-tight">Overview</h1>

      {/* Health -------------------------------------------------------- */}
      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <div className="card p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Rating service
          </p>
          <p className={`mt-1 font-semibold ${scout.ok ? "text-ink" : "text-danger"}`}>
            {scout.ok ? "Up" : "Down"}
          </p>
          <p className="hint break-words">{scout.detail}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Mail
          </p>
          <p className={`mt-1 font-semibold ${process.env.SMTP_HOST ? "text-ink" : "text-danger"}`}>
            {process.env.SMTP_HOST ? "Configured" : "Not configured"}
          </p>
          <p className="hint">
            {process.env.SMTP_HOST
              ? process.env.SMTP_HOST
              : "Nobody can sign up: confirmation mail cannot be sent."}
          </p>
        </div>
        <div className="card p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Inbox worker
          </p>
          <p className={`mt-1 font-semibold ${pendingMail.n > 50 ? "text-danger" : "text-ink"}`}>
            {pendingMail.n} waiting
          </p>
          <p className="hint">
            {pendingMail.n > 50
              ? "Backlog building — is the worker running?"
              : "Unprocessed forwarded mail"}
          </p>
        </div>
      </section>

      {/* Numbers ------------------------------------------------------- */}
      <section className="mt-8 grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Stat label="Users" value={allUsers.n} hint={`${newThisWeek.n} in the last 7 days`} />
        <Stat
          label="Unconfirmed"
          value={unverified}
          hint={stalledToday > 0 ? `${stalledToday} from today` : "never clicked the link"}
        />
        <Stat
          label="Onboarded"
          value={onboarded.n}
          hint={allUsers.n ? `${Math.round((onboarded.n / allUsers.n) * 100)}% of signups` : ""}
        />
        <Stat label="PDF CVs on file" value={withCv.n} />
        <Stat label="Jobs scored" value={allRatings.n} />
        <Stat label="Postings stored" value={allJobs.n} hint="shared across users" />
        <Stat label="Tracked jobs" value={tracked.n} />
        <Stat
          label="Locked accounts"
          value={locked.n}
          hint={locked.n > 0 ? "too many failed sign-ins" : ""}
        />
      </section>

      {pendingUpdates.n > 0 && (
        <p className="hint mt-4">
          {pendingUpdates.n} detected status update{pendingUpdates.n === 1 ? "" : "s"} awaiting
          confirmation across all users.
        </p>
      )}

      {/* Recent signups ------------------------------------------------ */}
      <section className="mt-10">
        <h2 className="font-semibold">Recent signups</h2>
        {recent.length === 0 ? (
          <p className="hint mt-2">Nobody has signed up yet.</p>
        ) : (
          <div className="card mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
                <tr>
                  <th className="p-3 font-semibold">Email</th>
                  <th className="p-3 font-semibold">Signed up</th>
                  <th className="p-3 font-semibold">Confirmed</th>
                  <th className="p-3 font-semibold">Onboarded</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((row) => (
                  <tr key={row.email} className="border-b border-line last:border-0">
                    <td className="p-3">
                      <Link
                        href={`/admin/user?email=${encodeURIComponent(row.email)}`}
                        className="font-medium text-brand hover:underline"
                      >
                        {row.email}
                      </Link>
                    </td>
                    <td className="p-3 text-ink-soft">{timeAgo(row.createdAt)}</td>
                    <td className="p-3">
                      {row.verifiedAt ? (
                        <span className="text-ink-soft">yes</span>
                      ) : (
                        <span className="font-medium text-danger">no</span>
                      )}
                    </td>
                    <td className="p-3 text-ink-soft">{row.onboardedAt ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Audit --------------------------------------------------------- */}
      <section className="mt-10">
        <h2 className="font-semibold">Recent admin activity</h2>
        <p className="hint">
          Every action taken through this panel, including reading a CV.
        </p>
        {recentActions.length === 0 ? (
          <p className="hint mt-2">Nothing yet.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {recentActions.map((entry) => (
              <li key={entry.id} className="flex flex-wrap gap-x-2 text-ink-soft">
                <span className="text-ink-faint tabular-nums">{timeAgo(entry.createdAt)}</span>
                <span className="font-medium text-ink">{entry.action}</span>
                {entry.subjectEmail && <span>→ {entry.subjectEmail}</span>}
                {entry.detail && <span className="text-ink-faint">({entry.detail})</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
