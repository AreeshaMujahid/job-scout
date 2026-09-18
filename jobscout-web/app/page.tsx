import Link from "next/link";

import { getCurrentUser } from "@/lib/auth/session";

const STEPS = [
  {
    title: "Upload your CV",
    body: "PDF or Word. It is read once to work out what you actually do — and what job titles that maps to.",
  },
  {
    title: "Six boards, searched at once",
    body: "Remotive, RemoteOK, Arbeitnow, Jobicy, The Muse and Himalayas. Around 700 postings read per run, de-duplicated down to the ones worth your attention.",
  },
  {
    title: "Scored, with the reasons",
    body: "Every job gets a number out of 100 and an argument: what in your CV fits this posting, and what you are missing.",
  },
];

export default async function LandingPage() {
  const user = await getCurrentUser();

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <span className="text-lg font-bold tracking-tight">Job Scout</span>
        {user ? (
          <Link href="/feed" className="btn-secondary">
            Go to your feed
          </Link>
        ) : (
          <Link href="/signin" className="btn-secondary">
            Sign in
          </Link>
        )}
      </header>

      <main className="mx-auto max-w-5xl px-6">
        <section className="py-16 sm:py-24">
          <p className="text-sm font-semibold uppercase tracking-widest text-brand">
            Stop reading job boards
          </p>
          <h1 className="mt-4 max-w-3xl text-4xl font-bold leading-tight tracking-tight sm:text-6xl">
            Which of these jobs is actually worth your evening?
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-ink-soft">
            Job Scout reads your CV, searches six job boards with terms taken from it, and scores
            what comes back — telling you why each one fits, and what you are missing. The reading
            is done by the time you sit down.
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-4">
            <Link href={user ? "/feed" : "/signin"} className="btn-primary px-6 py-3 text-base">
              {user ? "Go to your feed" : "Get started"}
            </Link>
            <span className="text-sm text-ink-faint">
              No password. No credit card. Delete everything in one click.
            </span>
          </div>
        </section>

        <section className="grid gap-6 pb-16 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <div key={step.title} className="card p-6">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-brand-soft text-sm font-bold text-brand">
                {index + 1}
              </span>
              <h2 className="mt-4 font-semibold">{step.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{step.body}</p>
            </div>
          ))}
        </section>

        <section className="card mb-24 overflow-hidden">
          <div className="border-b border-line bg-canvas px-6 py-4">
            <p className="text-sm font-semibold">What a scored job looks like</p>
          </div>
          <div className="p-6">
            <div className="flex items-start justify-between gap-6">
              <div>
                <h3 className="text-lg font-semibold">Senior Data Scientist</h3>
                <p className="text-sm text-ink-soft">Monzo · London · Arbeitnow</p>
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold text-strong">84</div>
                <div className="text-sm font-semibold text-strong">Good match</div>
              </div>
            </div>

            <p className="mt-6 text-sm font-semibold">Why you should apply</p>
            <ul className="mt-2 space-y-2 text-sm text-ink-soft">
              <li>
                • They hire into Fincrime and Borrowing squads, which matches your AML and risk
                modelling background directly.
              </li>
              <li>
                • Your penalty-prevention work in retail banking is the kind of commercial outcome
                this team is measured on.
              </li>
            </ul>

            <p className="mt-5 text-sm font-semibold">What to watch out for</p>
            <ul className="mt-2 space-y-2 text-sm text-ink-soft">
              <li>
                • Hiring at Senior grade, which is competitive against candidates with more than
                three years.
              </li>
            </ul>
          </div>
        </section>
      </main>

      <footer className="border-t border-line py-8">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 text-sm text-ink-faint">
          <span>Job Scout</span>
          <span>Your CV is used to match jobs, and for nothing else.</span>
        </div>
      </footer>
    </div>
  );
}
