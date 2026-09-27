/**
 * Checks that a search shows what it found, and nothing it did not.
 *
 *   PGLITE_DIR=./.pglite-runcheck npx tsx scripts/check-runs.ts
 *
 * Two rules meet here and it is their meeting that keeps breaking:
 *
 *   1. find.ts will not pay to score a posting twice, so a repeat search
 *      writes very few new ratings.
 *   2. the feed's default window asks for the current run.
 *
 * Apply (2) to only the ratings (1) wrote and a search that legitimately
 * found sixty jobs displays two. The fix is that a run re-stamps everything
 * it re-found; this file is here to notice if that ever stops happening.
 *
 * Runs the feed's real filter from lib/feed/window.ts rather than a copy.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";

process.env.PGLITE_DIR ??= "./.pglite-runcheck";

const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  pass  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const { jobStatus, jobs, profiles, ratings, users } = await import("@/lib/db/schema");
  const { feedWhere, lastRunWhere, WINDOWS, DEFAULT_WINDOW } =
    await import("@/lib/feed/window");

  const db = await getDb();
  const email = "runcheck@example.com";

  await db.delete(users).where(eq(users.email, email));
  const [user] = await db
    .insert(users)
    .values({ id: randomUUID(), email })
    .returning();

  // Four postings. One board, one search, told apart only by which run found
  // them and whether the person did anything about them.
  const ids = ["rc-old-kept", "rc-old-saved", "rc-old-gone", "rc-new"];
  await db
    .insert(jobs)
    .values(
      ids.map((id) => ({
        id,
        source: "StepStone",
        title: `Posting ${id}`,
        company: "Example GmbH",
        location: "Berlin",
        url: `https://example.com/${id}`,
        description: "",
        salary: "",
        postedAt: "",
        companyUrl: "",
        remote: false,
        tags: [],
      })),
    )
    .onConflictDoNothing();

  // Run one scored three of them.
  await db.insert(ratings).values(
    ["rc-old-kept", "rc-old-saved", "rc-old-gone"].map((jobId) => ({
      userId: user.id,
      jobId,
      score: 80,
      verdict: "good",
      skillsMatch: 80,
      experienceMatch: 80,
      domainMatch: 80,
      whyPick: [],
      concerns: [],
      matchedSkills: [],
      missingSkills: [],
      pitch: "",
      runId: "run-1",
      ratedAt: new Date(),
    })),
  );
  await db
    .insert(jobStatus)
    .values({ userId: user.id, jobId: "rc-old-saved", status: "saved" });

  // Run two re-finds two of the three and turns up one genuinely new one.
  // rc-old-gone is NOT re-found: the board stopped returning it.
  const runId = "run-2";
  const rediscovered = ["rc-old-kept", "rc-old-saved"];
  for (let i = 0; i < rediscovered.length; i += 400) {
    await db
      .update(ratings)
      .set({ runId })
      .where(
        and(eq(ratings.userId, user.id), inArray(ratings.jobId, rediscovered.slice(i, i + 400))),
      );
  }
  await db.insert(ratings).values({
    userId: user.id,
    jobId: "rc-new",
    score: 80,
    verdict: "good",
    skillsMatch: 80,
    experienceMatch: 80,
    domainMatch: 80,
    whyPick: [],
    concerns: [],
    matchedSkills: [],
    missingSkills: [],
    pitch: "",
    runId,
    ratedAt: new Date(),
  });
  await db
    .insert(profiles)
    .values({ userId: user.id, lastRunId: runId })
    .onConflictDoUpdate({ target: profiles.userId, set: { lastRunId: runId } });

  async function shown(useRun: boolean, hours: number | null): Promise<string[]> {
    const rows = await db
      .select({ jobId: ratings.jobId })
      .from(ratings)
      .innerJoin(jobs, eq(jobs.id, ratings.jobId))
      .leftJoin(
        jobStatus,
        and(eq(jobStatus.jobId, ratings.jobId), eq(jobStatus.userId, ratings.userId)),
      )
      .where(
        feedWhere({
          userId: user.id,
          minScore: 0,
          lastRunId: runId,
          useRun,
          hours,
          board: null,
        }),
      );
    return rows.map((r) => r.jobId).sort();
  }

  console.log("the default window shows what this search found");
  const thisSearch = await shown(true, 24);
  check(
    "a re-found posting is shown, not hidden as a duplicate",
    thisSearch.includes("rc-old-kept"),
    "scored on run 1, found again on run 2 -- the search returned it, so it belongs here",
  );
  check("a newly scored posting is shown", thisSearch.includes("rc-new"));
  check(
    "a saved posting survives a search that did not re-find it",
    thisSearch.includes("rc-old-saved"),
    "acted on, so it is the person's, not the search's",
  );
  check(
    "a stale unacted posting is not shown",
    !thisSearch.includes("rc-old-gone"),
    `this search never returned it; got ${JSON.stringify(thisSearch)}`,
  );

  console.log("\nthe wider windows still hold everything");
  const all = await shown(false, null);
  check("all time shows every rating", all.length === 4, JSON.stringify(all));

  console.log("\nratings scored before runs existed");
  await db
    .update(ratings)
    .set({ runId: null })
    .where(and(eq(ratings.userId, user.id), eq(ratings.jobId, "rc-old-gone")));
  const legacy = await shown(true, 24);
  check(
    "a null run id is not mistaken for the current run",
    !legacy.includes("rc-old-gone"),
    "null means 'no run recorded', which must never match a real id",
  );
  check("and it is still reachable under all time", (await shown(false, null)).length === 4);

  console.log("\nthe Find page\'s \"your last search\"");
  // The same expression app/(app)/find/page.tsx runs, not a copy of it.
  async function lastSearch(wanted: string): Promise<string[]> {
    const rows = await db
      .select({ jobId: ratings.jobId })
      .from(ratings)
      .innerJoin(jobs, eq(jobs.id, ratings.jobId))
      .leftJoin(
        jobStatus,
        and(eq(jobStatus.jobId, ratings.jobId), eq(jobStatus.userId, ratings.userId)),
      )
      .where(lastRunWhere(user.id, wanted))
      .orderBy(desc(ratings.score));
    return rows.map((r) => r.jobId);
  }

  const runResults = await lastSearch(runId);
  check(
    "shows what the run found, re-found postings included",
    runResults.includes("rc-old-kept") && runResults.includes("rc-new"),
    JSON.stringify(runResults),
  );
  check(
    "and nothing from an earlier run",
    !runResults.includes("rc-old-gone"),
    "an older job is not an answer to what THIS run turned up",
  );

  await db
    .insert(jobStatus)
    .values({ userId: user.id, jobId: "rc-new", status: "dismissed" })
    .onConflictDoUpdate({
      target: [jobStatus.userId, jobStatus.jobId],
      set: { status: "dismissed" },
    });
  const afterDismiss = await lastSearch(runId);
  check(
    "a dismissed posting drops out",
    !afterDismiss.includes("rc-new"),
    "already said no to, so not a result worth showing again",
  );
  check(
    "without taking the rest with it",
    afterDismiss.includes("rc-old-kept"),
    JSON.stringify(afterDismiss),
  );
  check(
    "an unknown run id shows nothing rather than everything",
    (await lastSearch("no-such-run")).length === 0,
    "a profile with no run yet must land on an empty section, not the whole feed",
  );

  console.log("\nthe window list");
  check(
    "the default window exists in the list",
    WINDOWS.some((w) => w.value === DEFAULT_WINDOW),
    `${DEFAULT_WINDOW} missing from ${JSON.stringify(WINDOWS.map((w) => w.value))}`,
  );

  await db.delete(users).where(eq(users.email, email));
  await db.delete(jobs).where(inArray(jobs.id, ids));

  console.log(`\n${failures.length === 0 ? "all checks passed" : `${failures.length} FAILED`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
