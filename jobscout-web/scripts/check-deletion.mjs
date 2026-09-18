/**
 * Proof that "delete my account" leaves nothing behind.
 *
 *   node scripts/check-deletion.mjs
 *
 * Opens the development database directly (stop `npm run dev` first -- PGlite
 * allows one writer), plants a user with a row in every table that holds
 * personal data, deletes just that user, and checks what survived.
 *
 * Raw SQL on purpose: this is testing what the database does on its own, not
 * what the application remembers to clean up.
 */
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite(process.env.PGLITE_DIR ?? "./.pglite");
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  pass  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const count = async (sql, params = []) => Number((await one(sql, params)).n);

// A real job to hang the personal rows off, so the "jobs survive" check means
// something. Reuse one already in the table if there is one.
const existingJob = await one(`SELECT id FROM jobs LIMIT 1`);
const jobId = existingJob?.id ?? "test-job-row";
if (!existingJob) {
  await db.query(
    `INSERT INTO jobs (id, source, title, company, url) VALUES ($1,'Test','Test Job','Test Co','https://example.com')`,
    [jobId],
  );
}

const userId = "cascade-test-user";
const email = "cascade-test@example.com";

await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
await db.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, email]);
await db.query(`INSERT INTO profiles (user_id, cv_text, headline) VALUES ($1, $2, $3)`, [
  userId,
  "the full text of a private CV",
  "Test person",
]);
await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1,$2,now()+interval '1 day')`, [
  "cascade-test-session",
  userId,
]);
await db.query(`INSERT INTO login_tokens (token_hash, email, expires_at) VALUES ($1,$2,now()+interval '1 hour')`, [
  "cascade-test-token",
  email,
]);
await db.query(`INSERT INTO ratings (user_id, job_id, score, verdict) VALUES ($1,$2,90,'strong')`, [
  userId,
  jobId,
]);
await db.query(`INSERT INTO job_status (user_id, job_id, status, note) VALUES ($1,$2,'saved','private note')`, [
  userId,
  jobId,
]);
await db.query(
  `INSERT INTO mailboxes (user_id, provider, alias, refresh_token, connected_email)
   VALUES ($1,'gmail','cascade-test-alias','sealed-refresh-token','private@example.com')`,
  [userId],
);
await db.query(
  `INSERT INTO inbound_messages (id, user_id, external_id, sender, subject, body)
   VALUES ('cascade-test-message',$1,'ext-1','recruiter@example.com','Your application',
           'the private contents of a recruiter e-mail')`,
  [userId],
);
await db.query(
  `INSERT INTO status_updates (id, user_id, job_id, status, evidence)
   VALUES ('cascade-test-update',$1,$2,'rejected','a sentence quoted from private mail')`,
  [userId, jobId],
);

console.log("\nplanted a user with a row in every personal table\n");

const jobsBefore = await count(`SELECT count(*) AS n FROM jobs`);
const otherRatingsBefore = await count(`SELECT count(*) AS n FROM ratings WHERE user_id <> $1`, [userId]);

// Exactly what app/actions/account.ts runs.
await db.query(`DELETE FROM login_tokens WHERE email = $1`, [email]);
await db.query(`DELETE FROM users WHERE id = $1`, [userId]);

console.log("deleted the user, and nothing else\n");

check("the user row is gone", (await count(`SELECT count(*) AS n FROM users WHERE id=$1`, [userId])) === 0);
check("the CV text is gone", (await count(`SELECT count(*) AS n FROM profiles WHERE user_id=$1`, [userId])) === 0);
check("sessions are gone", (await count(`SELECT count(*) AS n FROM sessions WHERE user_id=$1`, [userId])) === 0);
check("outstanding sign-in links are gone", (await count(`SELECT count(*) AS n FROM login_tokens WHERE email=$1`, [email])) === 0);
check("scores are gone", (await count(`SELECT count(*) AS n FROM ratings WHERE user_id=$1`, [userId])) === 0);
check("the tracker, and its notes, are gone", (await count(`SELECT count(*) AS n FROM job_status WHERE user_id=$1`, [userId])) === 0);

check(
  "the forwarding address and its stored token are gone",
  (await count(`SELECT count(*) AS n FROM mailboxes WHERE user_id=$1`, [userId])) === 0,
  "mailboxes holds an encrypted OAuth refresh token",
);
check(
  "received e-mail is gone",
  (await count(`SELECT count(*) AS n FROM inbound_messages WHERE user_id=$1`, [userId])) === 0,
);
check(
  "detected updates, and the sentences quoted in them, are gone",
  (await count(`SELECT count(*) AS n FROM status_updates WHERE user_id=$1`, [userId])) === 0,
);

check(
  "public job postings survive",
  (await count(`SELECT count(*) AS n FROM jobs`)) === jobsBefore,
  "deleting an account must not delete jobs other people can see",
);
check(
  "other users' scores are untouched",
  (await count(`SELECT count(*) AS n FROM ratings WHERE user_id <> $1`, [userId])) === otherRatingsBefore,
);

const survivors = await one(
  `SELECT
     (SELECT count(*) FROM users)      AS users,
     (SELECT count(*) FROM profiles)   AS profiles,
     (SELECT count(*) FROM ratings)    AS ratings,
     (SELECT count(*) FROM job_status) AS tracked,
     (SELECT count(*) FROM inbound_messages) AS messages,
     (SELECT count(*) FROM status_updates)   AS updates,
     (SELECT count(*) FROM jobs)       AS jobs`,
);
console.log("\nremaining rows:", survivors);

await db.close();

console.log(`\n${failures.length === 0 ? "all checks passed" : `${failures.length} FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
