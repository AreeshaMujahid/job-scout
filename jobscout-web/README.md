# Job Scout — web

The product version: accounts, a feed, and a tracker. Next.js and Postgres in
front, the Python `job_scout` pipeline behind.

This is the third project in this repository. It borrows the auto-apply bot's
three scrapers (see **Where jobs come from**) and nothing else: the bot's own
code, database and Streamlit app are untouched and never run by it.

```
  browser ──► Next.js (App Router)  ──►  Postgres      users, CVs, scores,
                     │                                 the tracker
                     └────────────────►  job_scout     sources + scoring
                        HTTP                           (Python, port 8000)
```

## Where jobs come from

Four choices on **Find jobs**, and they behave differently:

| Source | What it is |
|---|---|
| **LinkedIn** | The deepest pool and the only one with real on-site German roles. The one source where the experience-level and years-of-experience filters actually apply. Scrapes guest pages, so it breaks when the markup changes and returns nothing when rate limited. |
| **Xing** | German-speaking market. No seniority facet, so those filters are ignored. |
| **Arbeitnow** | Public JSON board, small pool, nothing scraped. |
| **Job boards** | Remotive, RemoteOK, Arbeitnow, Jobicy, The Muse and Himalayas at once — ~700 postings a run, mostly remote. |

The three scrapers are the auto-apply bot's, imported from `linkedin.py` and
driven one level lower — at `source.fetch()`, which only yields postings. The
bot's `jobs.db` is never opened, read, or written.

**Nothing is hardcoded.** Job titles come from your uploaded CV; locations from
your onboarding answers. Edit either on Find jobs and the change is saved.
A run costs one HTTP round trip per title × location × page, so the form shows
the search count and a time estimate before you commit to it.

**A posting does not have to say your title exactly.** "Android Developer"
also finds "Senior Android Engineer"; "Machine Learning Engineer" finds "ML
Engineer"; "Frontend Developer" finds "Front-End Developer". Seniority and
`(m/w/d)` are ignored, hyphens and slashes are separators, and
developer/engineer/dev count as the same word. It stops short of matching on
any shared word -- "Data Scientist" still rejects "Data Engineer", which is a
different job. The rule lives in `job_scout/sources/titles.py`; the bot's own
stricter version is untouched and still used by the bot.

**Countries work the same way for all of them.** `job_scout/sources/places.py`
knows local spellings (`Deutschland`, `Espana`), cities that stand in for a
country (`Koln`), US and Canadian state codes (`Cary, NC`), regions
(`Europe`, `LATAM`) and city spelling variants (`Munich` == `Muenchen`). Live
gains on identical postings: Accountant in Ireland 7 -> 10, Software Developer
in Poland 1 -> 7.

**A typo does not cost you the search.** "marketting manager" in "uae" returned
nothing at all -- LinkedIn coped with the misspelling and sent back ten
Marketing Manager jobs in Dubai, and the title filter then dropped every one.
One edit is now forgiven in both the title and the typed country, with a swap
of two neighbouring letters counting as one.

**Different titles return very different counts, and that is real.** LinkedIn
applies the recency window (`f_TPR`) and experience-level filter (`f_E`)
server-side before any results come back -- a niche title at Entry/Associate
level posted in the last 24 hours can genuinely have almost nothing to show,
while a common one has dozens. Search several titles in one run and the result
panel breaks the count down per title x location, so a lopsided total has an
answer instead of looking like a bug.

## The screens

| Route | What it is |
|---|---|
| `/` | Landing page |
| `/signup` | Create an account with an email and password |
| `/signin` | Email and password, or a sign-in link instead |
| `/forgot-password` | Ask for a link to set a new password |
| `/reset-password` | Choose the new password (needs the emailed token) |
| `/auth/confirm` | The other end of the confirmation email (not a page) |
| `/onboarding` | Step 1: upload a CV (PDF, DOCX, TXT, MD) |
| `/onboarding/preferences` | Step 2: roles, cities, remote, work authorisation |
| `/find` | Job titles, locations, source and filters — fetch, score, and see the results in place |
| `/feed` | Every scored job, best match first, filterable |
| `/jobs/[id]` | The full argument: sub-scores, why it fits, what you are missing, an opening line |
| `/tracker` | Saved → applied → interviewing → offer → rejected, with notes |
| `/settings` | Account, application e-mail, search preferences, and delete-my-account |
| `/api/inbound` | Where forwarded application e-mail is delivered (not a page) |

## Application e-mail

The tracker keeps itself up to date by reading the mail employers send.

Each user gets a forwarding address (`u7f3a@inbox.example.com`) and points one
filter in their own mail client at it. What arrives is matched against the
applications they are tracking, and each detected change is shown with the
sentence from the e-mail that produced it, to confirm or ignore.

```
mail client filter  ->  inbound provider  ->  POST /api/inbound  ->  inbound_messages
                                                                          |
   tracker  <-  you confirm  <-  status_updates  <-  scout /inbox/classify
```

**Why forwarding rather than "Connect Gmail".** `gmail.readonly` is a Google
*restricted* scope. Shipping it to the public needs OAuth verification plus an
annual third-party CASA security assessment; until that clears, the consent
screen only admits test users added by hand. Forwarding needs no permission
from anyone, works with Outlook and company mailboxes, and only ever exposes
mail the user chose to send. The Gmail connector is written and tested
(`lib/inbox/gmail.ts`) but stays behind `GMAIL_CONNECTOR_ENABLED=false` until
that assessment is done.

**What it will not do.** The cost of a wrong `rejected` is someone giving up on
a live application, so every rule resolves towards leaving the tracker alone:

- Nothing moves without confirmation unless `INBOX_AUTO_APPLY=true`, and even
  then only high-confidence, forward-only changes.
- **A rejection is never applied automatically**, at any confidence.
- An application never moves backwards. A late "we have received your CV"
  cannot drag a row back from `interviewing` to `applied`.
- A verdict with no quoted sentence behind it is discarded, as is one for a
  job the user is not tracking.
- Anything applied automatically records what the row said before, so the
  user can undo it.

**Setting up the domain.** Point the MX records of a *subdomain* at an inbound
provider (Postmark, SendGrid, Mailgun, Cloudflare Email Workers) and have it
POST to `https://<APP_URL>/api/inbound` with `INBOUND_SECRET` as an
`X-Inbound-Secret` header or `?secret=`. Use a subdomain: its MX records
belong to the provider, and pointing your main domain at them would divert
your own mail.

Messages are truncated to the first 1200 characters on the way in and deleted
`INBOX_RETENTION_DAYS` after they are classified. This is a tracker, not a
mail archive.

## Signing in

Two ways in, on purpose.

**Password.** Sign up with an email and a password, confirm the address, and
sign in. The password is hashed with **scrypt** from Node's own crypto module
(N=2^17, r=8, p=1, per-password salt, parameters stored alongside the hash so
they can be raised later without invalidating anything). Argon2id would be the
current first choice; it is a native dependency that has to compile on every
machine and in every image, and scrypt is on OWASP's list of acceptable
choices, so that trade is made deliberately. A hash costs about 280ms, which
is the point.

**A sign-in link**, exactly as before. It is not a lesser option hidden in a
corner: it is what gets somebody in when they have forgotten the password,
when their account predates passwords entirely, or when they are locked out.
Every one of those messages points at it, so it is one click from the form.

**An address must be confirmed before its password works.** Anybody can type a
stranger's address into a sign-up form; without this, an account could be
created and used in the name of someone who never asked for one. Clicking
either a confirmation link or a sign-in link proves the address and sets it.

### What the forms will not tell you

None of `/signup`, `/signin` or `/forgot-password` reveals whether an address
has an account. A form that says "no account with that email" is a form anyone
can use to test a list of addresses against your user table.

- Signing up with an address that is already registered gives exactly the
  message a new address gives. The account's actual owner is told by mail,
  and offered a reset in case they are the one who forgot.
- Forgot-password says "if that address has an account" and means it.
- Sign-in gives one message for a wrong password, an unknown address, and an
  account with no password set.
- An unknown address still costs a full scrypt hash, so the timing does not
  answer the question the wording refused to. There is a test for this.

### The rest of it

- Eight consecutive failures lock an account for 15 minutes. While locked,
  even the correct password is refused -- otherwise it is not a lockout.
- Setting a new password **drops every existing session**. The usual reason
  to reset is that somebody else got in.
- Reset and confirmation links are single-use, hashed in the database, and
  invalidate each other: asking for a reset kills an outstanding sign-in link.
  A token issued to confirm an address cannot be spent to change its password.
- Reset links last 15 minutes; confirmation links last 24 hours, because a
  confirmation mail is often opened the next morning on a different device.
- Passwords are judged on length, not on composition rules. "One capital and
  one symbol" reliably produces `Password1!`.

## Running it

Two processes. The Python service first, because the app calls it:

```bash
.venv/Scripts/python.exe -m job_scout.service
```

```bash
npm run dev --prefix jobscout-web
```

The inbox worker is a third process, and optional in development:

```bash
npm run worker --prefix jobscout-web
```

Then open http://localhost:3000. With no SMTP configured, sign-in links are
printed to the Next terminal **and shown on the sign-in page**, so you can get
in without a mail server. That fallback is disabled when `NODE_ENV=production`.

Copy `.env.example` to `.env.local` if you want to change anything; the
defaults work as they are.

## The database

No setup. With `DATABASE_URL` unset the app runs **PGlite** — Postgres itself,
compiled to WASM — and keeps it in `./.pglite`. Same SQL, same schema, no
Docker and no connection string.

To point at a real Postgres, set `DATABASE_URL`. Nothing else changes: the
schema is applied on boot as idempotent `CREATE TABLE IF NOT EXISTS`
statements in `lib/db/index.ts`, so there is no migration step on deploy.
(Once more than one person is changing the schema, move to drizzle-kit
migrations — `IF NOT EXISTS` cannot express a column change.)

## Deploying

`docker compose up -d --build` from the repository root brings up four
containers -- Postgres, the rating service, the app and the inbox worker.
Copy `.env.docker.example` to `.env` first; compose refuses to start rather
than booting half-configured. Only the app is published to the host, so put a
TLS terminator in front of it -- `/api/inbound` receives real people's e-mail
and must not be plain HTTP.

Deploying by hand instead:

1. Set `DATABASE_URL` to a managed Postgres.
2. Set `APP_URL` to the public URL -- it is what magic links point at.
3. Set `SMTP_*` and `MAIL_FROM`. **Without these nobody can sign in**, by
   design: the on-screen link fallback would otherwise hand a working session
   to anyone who typed an address into the form.
4. Run `job_scout.service` somewhere the app can reach, set `SCOUT_URL` to it,
   and set the same random `SCOUT_TOKEN` on both sides so the rating service
   is not open to the world.
5. Set `ENCRYPTION_KEY`, and back it up with the database. It encrypts stored
   OAuth refresh tokens; losing it means every connected account must
   reconnect.
6. Run `npm run worker` as a second long-running process next to the app.

Gmail SMTP works for a handful of users and will start landing in spam beyond
that; a sending domain on a real provider is the fix.

## What has been checked

- `npm run build` — clean; every route correctly server-rendered on demand.
- `npx tsc --noEmit` and `npx eslint .` — clean.
- `node scripts/check-deletion.mjs` — plants a user with a row in every
  personal table, deletes only that user, and asserts what survived. Stop the
  dev server first; PGlite allows one writer. Covers the forwarding address,
  the stored OAuth token, received e-mail and the sentences quoted from it.
- `npx tsx scripts/check-inbox.ts` — 31 checks on address routing (including
  a lookalike domain), token sealing, forwarded-message unwrapping and the
  four inbound-provider payload shapes.
- `npx tsx scripts/check-auth.ts` — 32 checks on the account layer: hashing
  and salting, what counts as a password, that an unconfirmed address cannot
  sign in, that a missing account costs the same time as a wrong password,
  the lockout and its release, that a confirmation token cannot be spent as a
  reset, and that a reset drops every session.
- `npx tsx scripts/check-sync.ts` — 20 checks running the real sync against a
  stub classifier: that nothing moves without confirmation, that an
  application never moves backwards, that a rejection is never auto-applied,
  that a superseded update stops asking, and that processed mail is not read
  twice.
- The full flow, in a browser: sign in → **PDF** CV → preferences → 731
  postings read across six boards → 13 scored → save → tracker → delete
  account.
- A LinkedIn run through the UI: 8 postings scraped, 1 duplicate dropped,
  7 scored, landing in the feed alongside the API-board results.
- A second run for "developer": 2 scraped, 2 scored, rendered on Find jobs —
  including a C#/.NET backend role correctly scored 15 (weak) for a data
  scientist.

## Security notes

- Passwords are stored as salted scrypt hashes with their parameters attached,
  and re-hashed on sign-in when those parameters are raised.
- Sign-in, confirmation and reset tokens are stored **hashed**; a database dump contains no usable
  links. They are single-use, expire in 15 minutes, and requesting a new one
  invalidates the old. One link per address per minute.
- Sessions are opaque random ids in a table, not JWTs, so signing out and
  deleting an account revoke access immediately rather than at expiry.
- Every table holding personal data references `users.id` with
  `ON DELETE CASCADE`, which is what makes deletion one statement and total.
  Job postings are public listings, shared between users, and are not deleted.
- `/api/inbound` requires a shared secret, compared with a constant-time hash.
  An unknown or disabled forwarding address is accepted and silently dropped:
  a distinguishable response would let anyone enumerate live addresses.
- Forwarding aliases are random, not derived from the user id or e-mail — the
  address appears in mail headers and must not identify its owner.
- Stored OAuth refresh tokens are encrypted with AES-256-GCM
  (`lib/crypto.ts`), so a database dump yields ciphertext rather than live
  grants on other people's mailboxes.
