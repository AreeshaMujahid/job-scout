import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";

import * as schema from "./schema";

/**
 * One database, two drivers.
 *
 * With DATABASE_URL set we talk to a real Postgres over the wire -- that is
 * the deployed path. Without it we run PGlite, which is Postgres itself
 * compiled to WASM and kept in ./.pglite, so a clone needs no Docker, no
 * daemon and no connection string to boot. The schema and every query below
 * are identical either way; only the driver changes.
 */

/**
 * One type, not a union of the two drivers.
 *
 * A `A | B` database type looks harmless and is not: TypeScript resolves a
 * method call on a union by intersecting the overloads, which quietly reduces
 * `.returning({...})` to a zero-argument signature and fails to compile. Both
 * drivers extend the same PgDatabase and expose the same query builder, so
 * one of them stands in for both.
 */
type Database = ReturnType<typeof drizzlePg<typeof schema>>;

// Next's dev server re-evaluates modules on edit. Without this the app opens
// a new PGlite instance (and a new lock on the data directory) per reload.
const globalForDb = globalThis as unknown as {
  __jobscoutDb?: Promise<Database>;
};

export const usingRemotePostgres = Boolean(process.env.DATABASE_URL);

async function connect(): Promise<Database> {
  if (process.env.DATABASE_URL) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Managed Postgres (Neon, Supabase, RDS) terminates non-TLS connections.
      ssl: process.env.DATABASE_SSL === "false" ? undefined : { rejectUnauthorized: false },
      max: 10,
    });
    const db = drizzlePg(pool, { schema });
    await migrate(db);
    return db;
  }

  const client = new PGlite(process.env.PGLITE_DIR ?? "./.pglite");
  const db = drizzlePglite(client, { schema }) as unknown as Database;
  await migrate(db);
  return db;
}

export function getDb(): Promise<Database> {
  globalForDb.__jobscoutDb ??= connect();
  return globalForDb.__jobscoutDb;
}

/**
 * Schema as idempotent DDL rather than a migration folder.
 *
 * It runs on every boot and is safe to run again. For an app this size that
 * beats generated migrations: the same statements apply to PGlite locally and
 * to managed Postgres in production, with nothing to remember to run on
 * deploy. Once more than one person is changing this schema, swap it for
 * drizzle-kit migrations -- IF NOT EXISTS cannot express a column change.
 */
async function migrate(db: Database): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
       id            text PRIMARY KEY,
       email         text NOT NULL UNIQUE,
       created_at    timestamptz NOT NULL DEFAULT now(),
       onboarded_at  timestamptz
     )`,
    `CREATE TABLE IF NOT EXISTS login_tokens (
       token_hash  text PRIMARY KEY,
       email       text NOT NULL,
       expires_at  timestamptz NOT NULL,
       used_at     timestamptz,
       created_at  timestamptz NOT NULL DEFAULT now()
     )`,
    `CREATE INDEX IF NOT EXISTS login_tokens_email_idx ON login_tokens (email)`,
    `CREATE TABLE IF NOT EXISTS sessions (
       id          text PRIMARY KEY,
       user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       expires_at  timestamptz NOT NULL,
       created_at  timestamptz NOT NULL DEFAULT now()
     )`,
    `CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id)`,
    `CREATE TABLE IF NOT EXISTS profiles (
       user_id           text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
       cv_filename       text,
       cv_text           text,
       name              text,
       headline          text,
       seniority         text,
       years_experience  real,
       core_skills       jsonb NOT NULL DEFAULT '[]'::jsonb,
       tools             jsonb NOT NULL DEFAULT '[]'::jsonb,
       domains           jsonb NOT NULL DEFAULT '[]'::jsonb,
       strengths         jsonb NOT NULL DEFAULT '[]'::jsonb,
       gaps              jsonb NOT NULL DEFAULT '[]'::jsonb,
       suggested_roles   jsonb NOT NULL DEFAULT '[]'::jsonb,
       target_roles      jsonb NOT NULL DEFAULT '[]'::jsonb,
       cities            jsonb NOT NULL DEFAULT '[]'::jsonb,
       remote_only       boolean NOT NULL DEFAULT false,
       visa_status       text,
       visa_note         text,
       updated_at        timestamptz NOT NULL DEFAULT now()
     )`,
    `CREATE TABLE IF NOT EXISTS jobs (
       id           text PRIMARY KEY,
       source       text NOT NULL,
       title        text NOT NULL,
       company      text NOT NULL,
       location     text NOT NULL DEFAULT '',
       url          text NOT NULL,
       description  text NOT NULL DEFAULT '',
       salary       text NOT NULL DEFAULT '',
       posted_at    text NOT NULL DEFAULT '',
       company_url  text NOT NULL DEFAULT '',
       remote       boolean NOT NULL DEFAULT false,
       tags         jsonb NOT NULL DEFAULT '[]'::jsonb,
       first_seen   timestamptz NOT NULL DEFAULT now()
     )`,
    `CREATE TABLE IF NOT EXISTS ratings (
       user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       job_id           text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
       score            integer NOT NULL,
       verdict          text NOT NULL,
       skills_match     integer NOT NULL DEFAULT 0,
       experience_match integer NOT NULL DEFAULT 0,
       domain_match     integer NOT NULL DEFAULT 0,
       why_pick         jsonb NOT NULL DEFAULT '[]'::jsonb,
       concerns         jsonb NOT NULL DEFAULT '[]'::jsonb,
       matched_skills   jsonb NOT NULL DEFAULT '[]'::jsonb,
       missing_skills   jsonb NOT NULL DEFAULT '[]'::jsonb,
       pitch            text NOT NULL DEFAULT '',
       cover_letter     text NOT NULL DEFAULT '',
       cv_suggestions   jsonb NOT NULL DEFAULT '[]'::jsonb,
       cover_letter_at  timestamptz,
       referral_contacts jsonb NOT NULL DEFAULT '[]'::jsonb,
       referrals_at      timestamptz,
       rated_at         timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (user_id, job_id)
     )`,
    `CREATE INDEX IF NOT EXISTS ratings_user_score_idx ON ratings (user_id, score)`,
    `CREATE TABLE IF NOT EXISTS job_status (
       user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       job_id      text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
       status      text NOT NULL,
       note        text NOT NULL DEFAULT '',
       follow_up_subject text NOT NULL DEFAULT '',
       follow_up_body    text NOT NULL DEFAULT '',
       follow_up_at      timestamptz,
       updated_at  timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (user_id, job_id)
     )`,
    `CREATE INDEX IF NOT EXISTS job_status_user_idx ON job_status (user_id, status)`,
    `CREATE TABLE IF NOT EXISTS mailboxes (
       user_id         text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
       provider        text NOT NULL,
       alias           text NOT NULL UNIQUE,
       refresh_token   text,
       connected_email text NOT NULL DEFAULT '',
       history_id      text NOT NULL DEFAULT '',
       enabled         boolean NOT NULL DEFAULT true,
       last_error      text NOT NULL DEFAULT '',
       last_sync_at    timestamptz,
       created_at      timestamptz NOT NULL DEFAULT now()
     )`,
    `CREATE INDEX IF NOT EXISTS mailboxes_alias_idx ON mailboxes (alias)`,
    `CREATE TABLE IF NOT EXISTS inbound_messages (
       id           text PRIMARY KEY,
       user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       external_id  text NOT NULL,
       sender       text NOT NULL DEFAULT '',
       subject      text NOT NULL DEFAULT '',
       body         text NOT NULL DEFAULT '',
       received_at  timestamptz NOT NULL DEFAULT now(),
       processed_at timestamptz,
       created_at   timestamptz NOT NULL DEFAULT now()
     )`,
    // Redelivery is normal, not exceptional: webhooks retry and Gmail polls
    // overlap. This index is what lets the ingest path shrug both off with
    // ON CONFLICT DO NOTHING rather than classifying a message twice.
    `CREATE UNIQUE INDEX IF NOT EXISTS inbound_user_external_key
       ON inbound_messages (user_id, external_id)`,
    `CREATE INDEX IF NOT EXISTS inbound_user_unprocessed_idx
       ON inbound_messages (user_id, processed_at)`,
    `CREATE TABLE IF NOT EXISTS status_updates (
       id              text PRIMARY KEY,
       user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       job_id          text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
       message_id      text,
       previous_status text NOT NULL DEFAULT '',
       status          text NOT NULL,
       confidence      text NOT NULL DEFAULT 'medium',
       evidence        text NOT NULL DEFAULT '',
       state           text NOT NULL DEFAULT 'pending',
       auto            boolean NOT NULL DEFAULT false,
       detected_at     timestamptz NOT NULL DEFAULT now(),
       resolved_at     timestamptz
     )`,
    `CREATE INDEX IF NOT EXISTS status_updates_user_state_idx
       ON status_updates (user_id, state)`,
    `CREATE INDEX IF NOT EXISTS status_updates_job_idx ON status_updates (user_id, job_id)`,

    // Password sign-in, added after the magic-link-only release. Existing
    // rows get NULL for both, which is correct: an account that has never
    // set a password cannot sign in with one, and an address only ever used
    // for a sign-in link is verified the next time a link is clicked.
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_logins integer NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until timestamptz`,
    // Existing rows are all sign-in links, which is what the default says.
    `ALTER TABLE login_tokens ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'signin'`,

    // The admin panel's audit trail. No foreign key to users on purpose: the
    // record that an account was deleted must outlive the account.
    `CREATE TABLE IF NOT EXISTS admin_actions (
       id            text PRIMARY KEY,
       actor_email   text NOT NULL,
       action        text NOT NULL,
       subject_email text NOT NULL DEFAULT '',
       detail        text NOT NULL DEFAULT '',
       created_at    timestamptz NOT NULL DEFAULT now()
     )`,
    `CREATE INDEX IF NOT EXISTS admin_actions_created_idx ON admin_actions (created_at)`,
    `CREATE TABLE IF NOT EXISTS chat_messages (
       id          text PRIMARY KEY,
       user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       job_id      text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
       role        text NOT NULL,
       content     text NOT NULL,
       unsupported jsonb NOT NULL DEFAULT '[]'::jsonb,
       created_at  timestamptz NOT NULL DEFAULT now()
     )`,
    `CREATE INDEX IF NOT EXISTS chat_messages_thread_idx
       ON chat_messages (user_id, job_id, created_at)`,

    // Search runs. Ratings made before runs existed get NULL, which the feed
    // reads as "not from the current run" -- they stay reachable through the
    // wider windows rather than disappearing.
    `ALTER TABLE ratings ADD COLUMN IF NOT EXISTS run_id text`,
    `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_run_id text`,
    `CREATE INDEX IF NOT EXISTS ratings_run_idx ON ratings (user_id, run_id)`,

    // Columns added after the first release. CREATE TABLE IF NOT EXISTS does
    // nothing to a table that already exists, so new columns need saying out
    // loud. ADD COLUMN IF NOT EXISTS is idempotent, like everything above.
    `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS search_board text NOT NULL DEFAULT 'StepStone'`,
    // Databases created before this default changed keep the old one, and a
    // new account there would start on a source it may not use.
    `ALTER TABLE profiles ALTER COLUMN search_board SET DEFAULT 'StepStone'`,
    `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS search_pages integer NOT NULL DEFAULT 3`,
    `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS search_hours integer NOT NULL DEFAULT 24`,
    `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS search_levels jsonb NOT NULL
       DEFAULT '["Entry level","Associate"]'::jsonb`,
    `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS search_max_years integer`,
    // A run can span sources, and says how many postings it will score.
    // search_board is left in place: it is the fallback for every profile
    // saved before search_boards existed.
    `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS search_boards jsonb NOT NULL
       DEFAULT '[]'::jsonb`,
    `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS search_limit integer NOT NULL DEFAULT 30`,

    // A run is a row so it can outlive the request that started it.
    `CREATE TABLE IF NOT EXISTS runs (
       id            text PRIMARY KEY,
       user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       status        text NOT NULL DEFAULT 'running',
       message       text NOT NULL DEFAULT '',
       hint          text NOT NULL DEFAULT '',
       stats         jsonb NOT NULL DEFAULT '[]'::jsonb,
       target        integer NOT NULL DEFAULT 0,
       scored        integer NOT NULL DEFAULT 0,
       rediscovered  integer NOT NULL DEFAULT 0,
       started_at    timestamptz NOT NULL DEFAULT now(),
       finished_at   timestamptz
     )`,
    `CREATE INDEX IF NOT EXISTS runs_user_idx ON runs (user_id, started_at)`,
    // Added after the jobs table shipped, so existing databases need the
    // column added rather than the table recreated -- the CREATE above only
    // covers a fresh install.
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS company_url text NOT NULL DEFAULT ''`,
    `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS logo_url text NOT NULL DEFAULT ''`,
    `ALTER TABLE ratings ADD COLUMN IF NOT EXISTS cover_letter text NOT NULL DEFAULT ''`,
    `ALTER TABLE ratings ADD COLUMN IF NOT EXISTS cv_suggestions jsonb NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE ratings ADD COLUMN IF NOT EXISTS cover_letter_at timestamptz`,
    `ALTER TABLE job_status ADD COLUMN IF NOT EXISTS follow_up_subject text NOT NULL DEFAULT ''`,
    `ALTER TABLE job_status ADD COLUMN IF NOT EXISTS follow_up_body text NOT NULL DEFAULT ''`,
    `ALTER TABLE job_status ADD COLUMN IF NOT EXISTS follow_up_at timestamptz`,
    `ALTER TABLE ratings ADD COLUMN IF NOT EXISTS referral_contacts jsonb NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE ratings ADD COLUMN IF NOT EXISTS referrals_at timestamptz`,
    `ALTER TABLE profiles ADD COLUMN IF NOT EXISTS cv_file text`,
    `ALTER TABLE ratings ADD COLUMN IF NOT EXISTS tailored_cv_edits jsonb NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE ratings ADD COLUMN IF NOT EXISTS tailored_cv_missing jsonb NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE ratings ADD COLUMN IF NOT EXISTS tailored_cv_required jsonb NOT NULL DEFAULT '[]'::jsonb`,
    // Was free-prose "notes"; now a list of skill names the user ticks.
    `ALTER TABLE ratings DROP COLUMN IF EXISTS tailored_cv_notes`,
    `ALTER TABLE ratings ADD COLUMN IF NOT EXISTS tailored_cv_at timestamptz`,
    // The first cut of CV tailoring rebuilt the document from its text and
    // cached the rebuilt sections here. That approach is gone (it could not
    // preserve a real CV's photo or layout), and so is the shape it stored.
    `ALTER TABLE ratings DROP COLUMN IF EXISTS tailored_cv_header`,
    `ALTER TABLE ratings DROP COLUMN IF EXISTS tailored_cv_sections`,
    `ALTER TABLE ratings DROP COLUMN IF EXISTS tailored_cv_additions`,
  ];

  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

export { schema };
