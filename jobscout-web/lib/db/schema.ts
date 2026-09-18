import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Everything a user owns hangs off users.id with `onDelete: "cascade"`, so
 * "delete my account" is one DELETE and genuinely leaves nothing behind.
 * Jobs are the exception -- they are public postings, shared between users,
 * and belong to nobody.
 */

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  /**
   * scrypt, salted, parameters embedded -- see lib/auth/password.ts. Null for
   * an account that only ever signs in by emailed link, which is every
   * account created before passwords existed and any created since that
   * chose the link. Null means "cannot sign in with a password", never
   * "any password will do".
   */
  passwordHash: text("password_hash"),
  /**
   * When this address was proven to belong to whoever is using it.
   *
   * Null blocks password sign-in: anyone can type someone else's address
   * into a sign-up form, and without this an account could be created, and
   * signed into, in the name of a person who never asked for one. Clicking
   * either a verification link or a sign-in link sets it, since both require
   * reading mail sent to that address.
   */
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  /**
   * Consecutive failed password attempts, and the lockout they earn. Reset
   * on any successful sign-in. This is what stops the form being a place to
   * try a million passwords at leisure.
   */
  failedLogins: integer("failed_logins").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
});

/**
 * Magic-link tokens. Only the hash is stored: a leaked database backup should
 * not hand someone a working set of sign-in links.
 */
export const TOKEN_PURPOSES = ["signin", "verify", "reset"] as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

export const loginTokens = pgTable(
  "login_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    email: text("email").notNull(),
    /**
     * What this token is for. One table because all three are the same
     * object -- a hashed, single-use, expiring secret sent to an address --
     * and because they must invalidate each other: a password reset while a
     * sign-in link is outstanding should not leave the older link working.
     */
    purpose: text("purpose").$type<TokenPurpose>().notNull().default("signin"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("login_tokens_email_idx").on(table.email)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

/**
 * One row per user: what the CV said, plus what they told us during
 * onboarding that a CV cannot know (which cities, what visa status).
 */
export const profiles = pgTable("profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),

  // From the CV.
  cvFilename: text("cv_filename"),
  cvText: text("cv_text"),
  // The uploaded PDF itself, base64. Kept because tailoring a CV to a posting
  // edits the real file in place -- that is what preserves the photo, fonts
  // and layout that rebuilding from cvText threw away. Null for a .docx/.txt
  // upload, which has no in-place edit to make. Base64 in a text column
  // rather than bytea: it is a few hundred KB, and it stays portable across
  // the PGlite and node-postgres drivers this app runs on.
  cvFile: text("cv_file"),
  name: text("name"),
  headline: text("headline"),
  seniority: text("seniority"),
  yearsExperience: real("years_experience"),
  coreSkills: jsonb("core_skills").$type<string[]>().notNull().default([]),
  tools: jsonb("tools").$type<string[]>().notNull().default([]),
  domains: jsonb("domains").$type<string[]>().notNull().default([]),
  strengths: jsonb("strengths").$type<string[]>().notNull().default([]),
  gaps: jsonb("gaps").$type<string[]>().notNull().default([]),

  // From onboarding. suggestedRoles is what the CV proposed, kept so the
  // onboarding screen can offer them back if the user clears the field.
  suggestedRoles: jsonb("suggested_roles").$type<string[]>().notNull().default([]),
  targetRoles: jsonb("target_roles").$type<string[]>().notNull().default([]),
  cities: jsonb("cities").$type<string[]>().notNull().default([]),
  remoteOnly: boolean("remote_only").notNull().default(false),
  visaStatus: text("visa_status"),
  visaNote: text("visa_note"),

  // Last used search settings, so Find jobs opens where you left it.
  // searchMaxYears null means "do not cap" -- the toggle in the UI.
  searchBoard: text("search_board").notNull().default("LinkedIn"),
  searchPages: integer("search_pages").notNull().default(3),
  searchHours: integer("search_hours").notNull().default(24),
  searchLevels: jsonb("search_levels").$type<string[]>().notNull().default(["Entry level", "Associate"]),
  searchMaxYears: integer("search_max_years"),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A posting, as fetched from a board. Shared across users and owned by none,
 * so deleting an account never deletes a job. `id` is job_scout's own key
 * (company + squashed title), which is what makes the same posting from three
 * boards a single row.
 */
export const jobs = pgTable("jobs", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  title: text("title").notNull(),
  company: text("company").notNull(),
  location: text("location").notNull().default(""),
  url: text("url").notNull(),
  description: text("description").notNull().default(""),
  salary: text("salary").notNull().default(""),
  postedAt: text("posted_at").notNull().default(""),
  /** The employer's own page on the board, when the listing links to one. */
  companyUrl: text("company_url").notNull().default(""),
  remote: boolean("remote").notNull().default(false),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
});

/** One user's verdict on one job. */
export const ratings = pgTable(
  "ratings",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    score: integer("score").notNull(),
    verdict: text("verdict").notNull(),
    skillsMatch: integer("skills_match").notNull().default(0),
    experienceMatch: integer("experience_match").notNull().default(0),
    domainMatch: integer("domain_match").notNull().default(0),
    whyPick: jsonb("why_pick").$type<string[]>().notNull().default([]),
    concerns: jsonb("concerns").$type<string[]>().notNull().default([]),
    matchedSkills: jsonb("matched_skills").$type<string[]>().notNull().default([]),
    missingSkills: jsonb("missing_skills").$type<string[]>().notNull().default([]),
    pitch: text("pitch").notNull().default(""),
    // Generated on request, not with the rating -- writing a letter for
    // every job that gets scored would be paying for prose nobody reads.
    // Empty string means "not generated yet", same convention as the other
    // optional text columns above.
    coverLetter: text("cover_letter").notNull().default(""),
    cvSuggestions: jsonb("cv_suggestions").$type<string[]>().notNull().default([]),
    coverLetterAt: timestamp("cover_letter_at", { withTimezone: true }),
    // The word swaps proposed for this posting -- same convention as
    // coverLetter: generated on request, an empty array means "not yet".
    // Only the edits are stored, never a tailored copy of the CV: the file is
    // produced by applying these to the user's original PDF on download, so
    // re-uploading a CV cannot leave a stale document behind.
    tailoredCvEdits: jsonb("tailored_cv_edits")
      .$type<{ find: string; replace: string; reason: string }[]>()
      .notNull()
      .default([]),
    // Skills the posting wants that the CV does not show -- offered back to
    // the user to confirm, since only they know whether one is absent because
    // they lack it or because they never wrote it down.
    tailoredCvMissing: jsonb("tailored_cv_missing").$type<string[]>().notNull().default([]),
    // What the posting asks for, read from the advert once. Kept so the gaps
    // put to the user are the same list getting shorter as they confirm --
    // re-deriving it each round produced a new set of skills every time.
    tailoredCvRequired: jsonb("tailored_cv_required").$type<string[]>().notNull().default([]),
    tailoredCvAt: timestamp("tailored_cv_at", { withTimezone: true }),
    // People LinkedIn showed THIS user for THIS posting. Cached so the
    // lookup runs once rather than on every page view -- each one drives a
    // signed-in browser at LinkedIn, and repeating that per visit is both
    // slow and the kind of pattern that gets an account flagged. Hangs off
    // the user's own rating row, so deleting the account deletes it too.
    referralContacts: jsonb("referral_contacts")
      .$type<{ name: string; profile_url: string; headline: string; degree: string }[]>()
      .notNull()
      .default([]),
    referralsAt: timestamp("referrals_at", { withTimezone: true }),
    ratedAt: timestamp("rated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.jobId] }),
    index("ratings_user_score_idx").on(table.userId, table.score),
  ],
);

export const JOB_STATUSES = ["saved", "applied", "interviewing", "offer", "rejected", "dismissed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** The tracker: what the user did about a job, and when. */
export const jobStatus = pgTable(
  "job_status",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    status: text("status").$type<JobStatus>().notNull(),
    note: text("note").notNull().default(""),
    // Drafted on request once an application has gone quiet. Empty string
    // means "not drafted yet", the same convention the other optional text
    // columns use.
    followUpSubject: text("follow_up_subject").notNull().default(""),
    followUpBody: text("follow_up_body").notNull().default(""),
    followUpAt: timestamp("follow_up_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.jobId] }),
    index("job_status_user_idx").on(table.userId, table.status),
  ],
);

export type User = typeof users.$inferSelect;
export type Profile = typeof profiles.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Rating = typeof ratings.$inferSelect;

/**
 * How one user's application e-mail reaches us.
 *
 * Two providers, because the obvious one is not available to everybody.
 * "forward" gives the user a unique address here and asks them to point a
 * filter at it -- it needs no permission from Google, works with Outlook or
 * a company mailbox, and only ever sees mail the user chose to send. "gmail"
 * is the one-click connector, gated behind GMAIL_CONNECTOR_ENABLED because
 * gmail.readonly is a restricted scope: until the OAuth app clears Google's
 * verification and CASA assessment it may only be offered to test users.
 *
 * refreshToken is sealed with seal() before it lands here, so the column
 * holds ciphertext and a database backup is not a set of live grants.
 */
export const MAILBOX_PROVIDERS = ["forward", "gmail"] as const;
export type MailboxProvider = (typeof MAILBOX_PROVIDERS)[number];

export const mailboxes = pgTable(
  "mailboxes",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<MailboxProvider>().notNull(),
    /** The local part of this user's forwarding address, unique across users. */
    alias: text("alias").notNull().unique(),
    /** Sealed OAuth refresh token. Null for the forwarding provider. */
    refreshToken: text("refresh_token"),
    /** Which mailbox the grant is for, so the UI can show what is connected. */
    connectedEmail: text("connected_email").notNull().default(""),
    /** Gmail's incremental sync cursor; avoids re-reading the whole mailbox. */
    historyId: text("history_id").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Why syncing stopped, when it did. A revoked grant or a dead token is a
     * setup problem with a cure, and the user is the only one who can apply
     * it -- so it is stored to be shown, not just logged.
     */
    lastError: text("last_error").notNull().default(""),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("mailboxes_alias_idx").on(table.alias)],
);

/**
 * One received message, reduced to what a status decision needs.
 *
 * Deliberately not a mail mirror: the body is truncated on the way in and
 * rows are deleted once they are old, because the product is a tracker and
 * keeping somebody's correspondence indefinitely is not part of it.
 *
 * externalId is the provider's own message id, and the unique index on
 * (user, externalId) is what makes redelivery -- a webhook retry, an
 * overlapping Gmail poll -- cost nothing.
 */
export const inboundMessages = pgTable(
  "inbound_messages",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    sender: text("sender").notNull().default(""),
    subject: text("subject").notNull().default(""),
    body: text("body").notNull().default(""),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** Null until the worker has classified it. */
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("inbound_user_unprocessed_idx").on(table.userId, table.processedAt),
    index("inbound_external_idx").on(table.userId, table.externalId),
  ],
);

/**
 * A detected change to a tracked application, and what became of it.
 *
 * Every update is written here before anything moves, including the ones
 * applied automatically. That is what makes the tracker explicable -- the
 * user can always see which sentence in which e-mail moved a row, and undo
 * it -- and it is why a high-confidence auto-apply is safe to offer at all.
 *
 * state: "pending" awaits the user, "applied" has moved the tracker,
 * "dismissed" was rejected by the user, "superseded" was overtaken by a
 * later update to the same job before anyone acted on it.
 */
export const UPDATE_STATES = ["pending", "applied", "dismissed", "superseded"] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];

export const statusUpdates = pgTable(
  "status_updates",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    messageId: text("message_id"),
    /** What the tracker said before this update, so applying is reversible. */
    previousStatus: text("previous_status").notNull().default(""),
    status: text("status").$type<JobStatus>().notNull(),
    confidence: text("confidence").notNull().default("medium"),
    /** The sentence from the e-mail that decided it. Never paraphrased. */
    evidence: text("evidence").notNull().default(""),
    state: text("state").$type<UpdateState>().notNull().default("pending"),
    /** True when the worker moved the tracker without asking. */
    auto: boolean("auto").notNull().default(false),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("status_updates_user_state_idx").on(table.userId, table.state),
    index("status_updates_job_idx").on(table.userId, table.jobId),
  ],
);

export type Mailbox = typeof mailboxes.$inferSelect;
export type InboundMessage = typeof inboundMessages.$inferSelect;
export type StatusUpdate = typeof statusUpdates.$inferSelect;

/**
 * The application-question conversation for one job.
 *
 * Kept rather than held in the browser: these answers take several rounds to
 * get right, and losing them to a refresh -- mid-application, with the form
 * open in another tab -- is the one failure that would stop anyone using it.
 *
 * Scoped to (user, job) because the answers are about a specific posting.
 * The same question asked for a different job deserves a different answer.
 */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    /** Things the question asked for that the CV could not back up. */
    unsupported: jsonb("unsupported").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("chat_messages_thread_idx").on(table.userId, table.jobId, table.createdAt)],
);

export type ChatMessage = typeof chatMessages.$inferSelect;

/**
 * What an administrator did, and to whom.
 *
 * This panel can read a CV and reset somebody's password, so every action
 * taken through it leaves a row here. Not bureaucracy: if a user ever asks
 * "who looked at my account", the answer has to come from somewhere, and
 * knowing the log exists is what stops idle browsing becoming a habit.
 *
 * Deliberately NOT cascade-deleted with the target user. A record that an
 * account was deleted is exactly the record most worth keeping, and it would
 * erase itself the moment it mattered. subjectEmail is stored rather than
 * joined for the same reason -- the user row may be gone.
 */
export const adminActions = pgTable(
  "admin_actions",
  {
    id: text("id").primaryKey(),
    /** The admin's email, as allowlisted. Not a foreign key: see above. */
    actorEmail: text("actor_email").notNull(),
    action: text("action").notNull(),
    subjectEmail: text("subject_email").notNull().default(""),
    /** Anything worth knowing later -- which job's CV, why a reset was sent. */
    detail: text("detail").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("admin_actions_created_idx").on(table.createdAt)],
);

export type AdminAction = typeof adminActions.$inferSelect;
