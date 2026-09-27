import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { jobStatus, jobs, ratings } from "@/lib/db/schema";
import { StatusButtons } from "@/components/StatusButtons";
import { NoteBox } from "@/components/NoteBox";
import { CoverLetterPanel } from "@/components/CoverLetterPanel";
import { TailorCvPanel } from "@/components/TailorCvPanel";
import { ApplicationChat } from "@/components/ApplicationChat";
import { loadThread } from "@/app/actions/applicationChat";
import { FollowUpPanel } from "@/components/FollowUpPanel";
import { ReferralPanel } from "@/components/ReferralPanel";
import { PostingDetail, QualificationPanel } from "@/components/PostingDetail";
import { daysSince, scoreText, timeAgo, VERDICT, verdictOf } from "@/lib/score";

export default async function JobDetailPage({ params }: PageProps<"/jobs/[id]">) {
  const user = await requireUser();
  const { id } = await params;

  const db = await getDb();
  const [row] = await db
    .select({ job: jobs, rating: ratings, tracked: jobStatus })
    .from(jobs)
    .innerJoin(ratings, and(eq(ratings.jobId, jobs.id), eq(ratings.userId, user.id)))
    .leftJoin(jobStatus, and(eq(jobStatus.jobId, jobs.id), eq(jobStatus.userId, user.id)))
    .where(eq(jobs.id, id))
    .limit(1);

  if (!row) notFound();

  const { job, rating, tracked } = row;
  const verdict = VERDICT[verdictOf(rating.verdict)];

  // The application-question thread for this posting, so a refresh mid-draft
  // does not lose answers that took several rounds to get right.
  const thread = await loadThread(job.id);

  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/feed" className="text-sm font-medium text-ink-soft hover:underline">
        ← Back to feed
      </Link>

      {/* Header ------------------------------------------------------- */}
      <div className="mt-6 flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight">{job.title}</h1>
          <p className="mt-2 text-ink-soft">
            {job.company} · {job.location || "location not stated"}
          </p>
          <p className="mt-1 text-sm text-ink-faint">
            From {job.source}
            {job.salary ? ` · ${job.salary}` : ""}
            {job.postedAt ? ` · posted ${job.postedAt}` : ""}
            {job.remote ? " · remote" : ""}
          </p>
        </div>

        <div className={`shrink-0 rounded-xl border px-6 py-4 text-center ${verdict.border} ${verdict.bg}`}>
          <div className={`text-4xl font-bold leading-none ${scoreText(rating.score)}`}>
            {rating.score}
          </div>
          <div className={`mt-1 text-sm font-semibold ${verdict.text}`}>{verdict.label}</div>
        </div>
      </div>

      {/* Actions ------------------------------------------------------ */}
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <a href={job.url} target="_blank" rel="noopener noreferrer" className="btn-primary">
          Apply on {job.source} ↗
        </a>
        <StatusButtons jobId={job.id} current={tracked?.status ?? null} />
      </div>
      {tracked && (
        <p className="mt-2 text-xs text-ink-faint">
          Marked {tracked.status} {timeAgo(tracked.updatedAt)}.
        </p>
      )}

      {/* Sub-scores --------------------------------------------------- */}
      <section className="card mt-8 grid gap-6 p-6 sm:grid-cols-3">
        <Meter label="Skills" value={rating.skillsMatch} />
        <Meter label="Experience" value={rating.experienceMatch} />
        <Meter label="Domain" value={rating.domainMatch} />
      </section>

      {/* The argument ------------------------------------------------- */}
      <section className="mt-8 grid gap-6 sm:grid-cols-2">
        <div className="card p-6">
          <h2 className="font-semibold text-strong">Why it fits</h2>
          <ul className="mt-4 space-y-3 text-sm leading-relaxed text-ink-soft">
            {rating.whyPick.map((reason) => (
              <li key={reason} className="flex gap-2">
                <span aria-hidden className="text-strong">+</span>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="card p-6">
          <h2 className="font-semibold text-stretch">What you&rsquo;re missing</h2>
          <ul className="mt-4 space-y-3 text-sm leading-relaxed text-ink-soft">
            {rating.concerns.map((concern) => (
              <li key={concern} className="flex gap-2">
                <span aria-hidden className="text-stretch">−</span>
                <span>{concern}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* What they ask for, against your CV ---------------------------
          High on the page because it is the one panel about YOU against
          this job rather than the employer describing it -- the rest of the
          posting reads below, after the tools. */}
      <QualificationPanel
        description={job.description}
        matchedSkills={rating.matchedSkills}
        missingSkills={rating.missingSkills}
      />

      {/* Pitch -------------------------------------------------------- */}
      {rating.pitch && (
        <section className="card mt-6 p-6">
          <h2 className="text-sm font-semibold">Open your application with</h2>
          <blockquote className="mt-3 border-l-2 border-brand pl-4 text-sm italic leading-relaxed text-ink-soft">
            {rating.pitch}
          </blockquote>
        </section>
      )}

      <ReferralPanel
        jobId={job.id}
        company={job.company}
        companyUrl={job.companyUrl}
        jobTitle={job.title}
        source={job.source}
        initialContacts={rating.referralContacts}
        checked={rating.referralsAt !== null}
      />

      {/* Only for an application still waiting on a reply -- the panel
          itself stays silent until it is actually old enough to chase. */}
      {tracked?.status === "applied" && (
        <FollowUpPanel
          jobId={job.id}
          company={job.company}
          daysSinceApplied={daysSince(tracked.updatedAt)}
          initialSubject={tracked.followUpSubject}
          initialBody={tracked.followUpBody}
        />
      )}

      <CoverLetterPanel
        jobId={job.id}
        initialLetter={rating.coverLetter}
        initialCvSuggestions={rating.cvSuggestions}
      />

      <TailorCvPanel
        jobId={job.id}
        hasPdfCv={Boolean(user.profile?.cvFile)}
        initialEdits={rating.tailoredCvEdits}
        initialMissing={rating.tailoredCvMissing}
        initialRequired={rating.tailoredCvRequired}
      />

      <ApplicationChat
        jobId={job.id}
        hasCv={Boolean(user.profile?.cvText)}
        initialMessages={thread.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          unsupported: message.unsupported,
        }))}
      />

      <NoteBox jobId={job.id} initialNote={tracked?.note ?? ""} />

      {/* The rest of the posting -------------------------------------- */}
      <PostingDetail
        description={job.description}
        url={job.url}
        source={job.source}
        matchedSkills={rating.matchedSkills}
        missingSkills={rating.missingSkills}
      />
    </div>
  );
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold">{label}</span>
        <span className={`text-sm font-bold ${scoreText(value)}`}>{value}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-canvas">
        <div
          className="h-full rounded-full bg-brand"
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
      </div>
    </div>
  );
}
