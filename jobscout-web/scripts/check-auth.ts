/**
 * Checks on the properties that make password sign-in safe to deploy.
 *
 *   PGLITE_DIR=./.pglite-authcheck npx tsx scripts/check-auth.ts
 *
 * The account layer, not the server actions: those reach for cookies() and
 * only exist inside a request. Everything that decides whether someone gets
 * in lives below that line and is tested here.
 */
import { eq } from "drizzle-orm";

process.env.PGLITE_DIR ??= "./.pglite-authcheck";

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
  const { sessions, users } = await import("@/lib/db/schema");
  const {
    checkPassword,
    createAccount,
    findByEmail,
    markVerified,
    setPassword,
    upsertVerifiedUser,
  } = await import("@/lib/auth/accounts");
  const { hashPassword, needsRehash, passwordProblem, verifyPassword } = await import(
    "@/lib/auth/password"
  );
  const { consumeLoginToken, createLoginToken } = await import("@/lib/auth/tokens");

  const db = await getDb();
  const PASSWORD = "a decent long passphrase";
  const email = "auth-check@example.com";

  async function fresh(): Promise<string> {
    await db.delete(users).where(eq(users.email, email));
    const user = await createAccount(email, PASSWORD);
    return user.id;
  }

  console.log("\nhashing");
  const hash = await hashPassword(PASSWORD);
  check("a password verifies against its own hash", await verifyPassword(PASSWORD, hash));
  check("a wrong password does not", !(await verifyPassword("something else", hash)));
  check("the hash does not contain the password", !hash.includes(PASSWORD));
  check(
    "the same password hashes differently twice",
    (await hashPassword(PASSWORD)) !== (await hashPassword(PASSWORD)),
    "each hash must carry its own salt",
  );
  check("a corrupt hash is a failed check, not a crash", !(await verifyPassword("x", "garbage")));
  check("current parameters do not ask for a rehash", !needsRehash(hash));
  check("an older scheme does", needsRehash("pbkdf2$1000$salt$key"));

  console.log("\nwhat counts as a password");
  check("too short is refused", passwordProblem("short1") !== null);
  check("a common one is refused", passwordProblem("password123") !== null);
  check("one repeated character is refused", passwordProblem("aaaaaaaaaaaaaa") !== null);
  check(
    "your own address is refused",
    passwordProblem("areesha-is-great", "areesha@example.com") !== null,
  );
  check("a long passphrase is fine", passwordProblem(PASSWORD) === null);

  console.log("\nsigning in");
  await fresh();
  let outcome = await checkPassword(email, PASSWORD);
  check(
    "a new account cannot sign in before confirming",
    !outcome.ok && outcome.reason === "unverified",
    "anyone can type a stranger's address into a sign-up form",
  );

  const created = await findByEmail(email);
  await markVerified(created!.id);
  outcome = await checkPassword(email, PASSWORD);
  check("once confirmed, the right password works", outcome.ok);

  outcome = await checkPassword(email, "not the password");
  check("the wrong password does not", !outcome.ok && outcome.reason === "bad-credentials");

  outcome = await checkPassword("nobody@example.com", PASSWORD);
  check(
    "an address with no account gives the same answer",
    !outcome.ok && outcome.reason === "bad-credentials",
    "a distinguishable answer reports who is registered here",
  );

  console.log("\nnot saying who has an account");
  const t0 = Date.now();
  await checkPassword("definitely-no-such-user@example.com", PASSWORD);
  const missing = Date.now() - t0;
  const t1 = Date.now();
  await checkPassword(email, "wrong password entirely");
  const wrong = Date.now() - t1;
  const ratio = Math.max(missing, wrong) / Math.max(1, Math.min(missing, wrong));
  check(
    "a missing account costs the same time as a wrong password",
    ratio < 2,
    `${missing}ms vs ${wrong}ms -- a fast 'no such user' is itself the answer`,
  );

  console.log("\nlocking out a guessing attack");
  await fresh();
  const user = await findByEmail(email);
  await markVerified(user!.id);
  let locked = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await checkPassword(email, `guess-number-${attempt}`);
    if (!result.ok && result.reason === "locked") locked = true;
  }
  check("repeated failures lock the account", locked);
  const afterLock = await checkPassword(email, PASSWORD);
  check(
    "and the right password is refused while locked",
    !afterLock.ok && afterLock.reason === "locked",
    "otherwise the lockout is not a lockout",
  );

  // The counter must clear, or one bad week leaves someone permanently near
  // a lockout.
  await db.update(users).set({ lockedUntil: null }).where(eq(users.email, email));
  const recovered = await checkPassword(email, PASSWORD);
  check("once the lock lapses the right password works", recovered.ok);
  const row = await findByEmail(email);
  check("and the failure counter is back to zero", row!.failedLogins === 0);

  console.log("\ntokens");
  const signinToken = await createLoginToken(email, "signin");
  check(
    "a sign-in token cannot be spent as a password reset",
    (await consumeLoginToken(signinToken, "reset")) === null,
    "they are the same shape and travel the same way; only the purpose separates them",
  );
  check(
    "and is still good for what it was issued for",
    (await consumeLoginToken(signinToken, "signin")) === email,
  );
  check(
    "but only once",
    (await consumeLoginToken(signinToken, "signin")) === null,
  );

  const first = await createLoginToken(email, "reset");
  const second = await createLoginToken(email, "reset");
  check(
    "asking again invalidates the earlier link",
    (await consumeLoginToken(first, "reset")) === null &&
      (await consumeLoginToken(second, "reset")) === email,
    "a forwarded or shoulder-surfed older mail must stop working",
  );

  console.log("\nsetting a new password");
  await fresh();
  const target = await findByEmail(email);
  await markVerified(target!.id);
  await db.insert(sessions).values({
    id: "auth-check-session",
    userId: target!.id,
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  await setPassword(target!.id, "an entirely different passphrase");
  const survivors = await db.select().from(sessions).where(eq(sessions.userId, target!.id));
  check(
    "a reset signs out everything that was already in",
    survivors.length === 0,
    "the usual reason to reset is that somebody else got in",
  );
  check("the old password stops working", !(await checkPassword(email, PASSWORD)).ok);
  check(
    "the new one works",
    (await checkPassword(email, "an entirely different passphrase")).ok,
  );

  console.log("\naccounts with no password");
  await db.delete(users).where(eq(users.email, "linkonly@example.com"));
  const linkOnly = await upsertVerifiedUser("linkonly@example.com");
  check("a link sign-in creates a verified account", Boolean(linkOnly.emailVerifiedAt));
  check("with no password", linkOnly.passwordHash === null);
  const noPassword = await checkPassword("linkonly@example.com", "anything at all");
  check(
    "and no password signs into it",
    !noPassword.ok && noPassword.reason === "bad-credentials",
    "null must mean 'cannot sign in with a password', never 'any password will do'",
  );

  await db.delete(users).where(eq(users.email, email));
  await db.delete(users).where(eq(users.email, "linkonly@example.com"));

  console.log(`\n${failures.length === 0 ? "all checks passed" : `${failures.length} FAILED`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
