/**
 * Checks on the rules that decide whether a tracker row moves.
 *
 *   PGLITE_DIR=./.pglite-verify npx tsx scripts/check-sync.ts
 *
 * Runs the real syncUser against a real database, with the classifier
 * replaced by a stub that returns whatever this file says it does. That is
 * the point: the model's judgement is not what is under test here, the
 * guardrails around it are -- and those are the part that decides whether a
 * wrong answer reaches somebody's tracker.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

process.env.ENCRYPTION_KEY ??= "test-only-key-that-is-at-least-32-characters";
process.env.INBOUND_DOMAIN ??= "inbox.example.com";
process.env.PGLITE_DIR ??= "./.pglite-verify";

const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  pass  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

/** What the stub classifier will answer on the next call. */
let canned: { job_id: string; status: string; confidence: string; evidence: string }[] = [];

async function main(): Promise<void> {
  // A stand-in for job_scout's /inbox/classify, so this runs with no Python
  // service and no model spend.
  const stub = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ updates: canned, errors: [] }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const port = (stub.address() as { port: number }).port;
  process.env.SCOUT_URL = `http://127.0.0.1:${port}`;

  // Imported after SCOUT_URL is set: lib/scout.ts reads it when the module loads.
  const { getDb } = await import("@/lib/db");
  const { inboundMessages, jobStatus, jobs, statusUpdates, users } = await import("@/lib/db/schema");
  const { syncUser } = await import("@/lib/inbox/sync");

  const db = await getDb();
  const userId = "sync-test-user";
  const jobId = "sync-test-job";

  async function reset(status: string): Promise<void> {
    await db.delete(users).where(eq(users.id, userId)); // cascades everything
    await db.insert(users).values({ id: userId, email: `${userId}@example.com` });
    await db
      .insert(jobs)
      .values({ id: jobId, source: "Test", title: "Data Analyst", company: "Acme", url: "https://example.com" })
      .onConflictDoNothing();
    await db.insert(jobStatus).values({
      userId,
      jobId,
      status: status as "applied",
      updatedAt: new Date(),
    });
  }

  async function deliver(body: string): Promise<void> {
    await db.insert(inboundMessages).values({
      id: randomUUID(),
      userId,
      externalId: randomUUID(),
      sender: "jobs@acme.example",
      subject: "Your application",
      body,
      receivedAt: new Date(),
    });
  }

  const currentStatus = async (): Promise<string> => {
    const [row] = await db
      .select({ status: jobStatus.status })
      .from(jobStatus)
      .where(and(eq(jobStatus.userId, userId), eq(jobStatus.jobId, jobId)));
    return row?.status ?? "";
  };

  const updateRows = async () =>
    db.select().from(statusUpdates).where(eq(statusUpdates.userId, userId));

  // --- the default: nothing moves without the user ----------------------
  console.log("\nwith auto-apply off (the default)");
  process.env.INBOX_AUTO_APPLY = "false";

  await reset("applied");
  await deliver("We would like to invite you to an interview.");
  canned = [
    { job_id: jobId, status: "interviewing", confidence: "high", evidence: "We would like to invite you to an interview." },
  ];
  let result = await syncUser(userId);

  check("the update is detected", result.updatesDetected === 1);
  check("it waits for the user", result.pending === 1 && result.autoApplied === 0);
  check("the tracker has NOT moved", (await currentStatus()) === "applied");
  check("the row records where it came from", (await updateRows())[0]?.previousStatus === "applied");
  check(
    "the deciding sentence is stored",
    (await updateRows())[0]?.evidence === "We would like to invite you to an interview.",
  );
  check(
    "the message it came from is identified",
    (await updateRows())[0]?.messageId !== null,
    "so the review screen can show the e-mail behind the verdict",
  );

  // --- a second pass must not re-read what it already read --------------
  canned = [];
  result = await syncUser(userId);
  check("processed mail is not read twice", result.messagesRead === 0, "it would be paid for twice");

  // --- the rank guard ---------------------------------------------------
  console.log("\nan application never moves backwards");
  await reset("interviewing");
  await deliver("We have received your application.");
  canned = [
    { job_id: jobId, status: "applied", confidence: "high", evidence: "We have received your application." },
  ];
  result = await syncUser(userId);
  check(
    "a late acknowledgement does not undo a phone screen",
    result.updatesDetected === 0 && (await currentStatus()) === "interviewing",
  );

  console.log("\na rejection is accepted from any stage");
  await reset("interviewing");
  await deliver("We have decided to move forward with other candidates.");
  canned = [
    { job_id: jobId, status: "rejected", confidence: "high", evidence: "We have decided to move forward with other candidates." },
  ];
  result = await syncUser(userId);
  check("it is detected", result.updatesDetected === 1);
  check(
    "but still never applied automatically",
    result.autoApplied === 0 && (await currentStatus()) === "interviewing",
    "the one verdict a human should read before the row closes",
  );

  // --- auto-apply, when it is switched on -------------------------------
  console.log("\nwith auto-apply switched on");
  process.env.INBOX_AUTO_APPLY = "true";

  await reset("applied");
  await deliver("We would like to invite you to an interview.");
  canned = [
    { job_id: jobId, status: "interviewing", confidence: "high", evidence: "We would like to invite you to an interview." },
  ];
  result = await syncUser(userId);
  check("a high-confidence move is applied", result.autoApplied === 1);
  check("the tracker has moved", (await currentStatus()) === "interviewing");
  check("and it is still reversible", (await updateRows())[0]?.previousStatus === "applied");

  await reset("applied");
  await deliver("We keep your CV on file.");
  canned = [
    { job_id: jobId, status: "interviewing", confidence: "medium", evidence: "We keep your CV on file." },
  ];
  result = await syncUser(userId);
  check(
    "a medium-confidence one still waits for the user",
    result.autoApplied === 0 && result.pending === 1 && (await currentStatus()) === "applied",
  );

  await reset("applied");
  await deliver("Unfortunately we are not proceeding.");
  canned = [
    { job_id: jobId, status: "rejected", confidence: "high", evidence: "Unfortunately we are not proceeding." },
  ];
  result = await syncUser(userId);
  check(
    "a rejection is never applied, even at high confidence",
    result.autoApplied === 0 && (await currentStatus()) === "applied",
  );

  // --- two verdicts for one application ---------------------------------
  console.log("\ntwo updates for the same application");
  process.env.INBOX_AUTO_APPLY = "false";
  await reset("applied");
  await deliver("We would like to invite you to an interview.");
  canned = [
    { job_id: jobId, status: "interviewing", confidence: "high", evidence: "We would like to invite you to an interview." },
  ];
  await syncUser(userId);

  await deliver("We are pleased to offer you the role.");
  canned = [
    { job_id: jobId, status: "offer", confidence: "high", evidence: "We are pleased to offer you the role." },
  ];
  await syncUser(userId);

  const rows = await updateRows();
  check(
    "only the newest is still awaiting an answer",
    rows.filter((r) => r.state === "pending").length === 1,
    "two pending rows would ask the user the same question twice",
  );
  check(
    "and it is the newer one",
    rows.find((r) => r.state === "pending")?.status === "offer",
  );
  check("the older one is marked superseded", rows.some((r) => r.state === "superseded"));

  // --- mail about an application that is not tracked --------------------
  console.log("\nmail that matches nothing");
  await reset("applied");
  await deliver("Newsletter: 12 new roles at Acme this week.");
  canned = [
    { job_id: "a-job-the-user-never-applied-to", status: "rejected", confidence: "high", evidence: "made up" },
  ];
  result = await syncUser(userId);
  check(
    "a verdict for an untracked job is ignored",
    result.updatesDetected === 0 && (await currentStatus()) === "applied",
  );

  await db.delete(users).where(eq(users.id, userId));
  stub.close();

  console.log(`\n${failures.length === 0 ? "all checks passed" : `${failures.length} FAILED`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
