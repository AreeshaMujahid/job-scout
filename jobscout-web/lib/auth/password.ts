import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * scrypt as a promise, keeping the options argument.
 *
 * Hand-wrapped rather than promisify()d: scrypt is overloaded, promisify
 * resolves to the three-argument form, and the options carrying N/r/p --
 * the entire cost of the hash -- are then a type error to pass.
 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/**
 * Storing passwords.
 *
 * scrypt, from Node's own crypto module. Argon2id would be the current first
 * choice, but it is a native dependency that has to compile on every machine
 * and in every image; scrypt is memory-hard, on OWASP's list of acceptable
 * choices, and already here. For an app this size that trade is worth making
 * -- and the stored format below carries its own parameters, so moving to
 * Argon2 later does not invalidate a single existing password.
 *
 * Nothing in this file is reversible. A database dump yields salted hashes at
 * roughly 64 MB of memory per guess, not passwords.
 */

// OWASP's floor for scrypt is N=2^17, r=8, p=1. Raising N costs memory and
// time per attempt, which is the entire point: it is what makes a stolen
// database expensive to attack rather than a weekend's work.
const N = 1 << 17; // 131072
const R = 8;
const P = 1;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

// scrypt needs to be told it may use this much memory, and the default cap is
// well below what N=2^17 requires. Without it the call fails outright.
const MAX_MEMORY = 256 * 1024 * 1024;

/**
 * How weak a password may be.
 *
 * Length over composition rules. "At least one capital and one symbol"
 * reliably produces `Password1!` -- it is a rule people satisfy rather than a
 * property that makes a password hard to guess -- while length is the thing
 * that actually costs an attacker.
 */
export const MIN_PASSWORD_LENGTH = 10;
// bcrypt's 72-byte limit is not scrypt's, but an unbounded password is an
// unbounded amount of hashing work handed to anyone with a form.
export const MAX_PASSWORD_LENGTH = 200;

/**
 * Passwords common enough that length does not save them. Not a substitute
 * for a breach-corpus check (Have I Been Pwned's range API is the real
 * answer, and is a network call this deliberately avoids on the sign-up
 * path) -- it is the shortlist that a length rule alone lets straight
 * through.
 */
const OBVIOUS = new Set([
  "password", "password1", "password12", "password123", "password1234",
  "123456789", "1234567890", "12345678901", "qwertyuiop", "qwerty123",
  "letmein123", "welcome123", "iloveyou123", "admin12345", "administrator",
  "jobscout123", "changeme123", "passw0rd123", "1q2w3e4r5t", "abc123456",
]);

/** Why a password was rejected, in the user's terms, or null if it is fine. */
export function passwordProblem(password: string, email = ""): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters. Length is what makes a password hard to guess.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `That is longer than ${MAX_PASSWORD_LENGTH} characters.`;
  }

  const flat = password.toLowerCase();
  if (OBVIOUS.has(flat)) {
    return "That is one of the most commonly used passwords. Pick something else.";
  }
  // A single repeated character clears any length rule and nothing else.
  if (new Set(password).size < 5) {
    return "That uses too few different characters.";
  }
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (local.length >= 4 && flat.includes(local)) {
    return "Do not use your email address in your password.";
  }
  return null;
}

/**
 * Hash a password for storage.
 *
 * The parameters are stored alongside the hash rather than assumed, so
 * raising N later leaves existing passwords verifiable -- they are rehashed
 * on their owner's next sign-in, when the plaintext is briefly in hand.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password.normalize("NFKC"), salt, KEY_BYTES, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEMORY,
  });

  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/**
 * Check a password against a stored hash. Never throws on malformed input --
 * a corrupt or unrecognised row is a failed sign-in, not a server error.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, n, r, p, salt, expected] = stored.split("$");
    if (scheme !== "scrypt") return false;

    const saltBytes = Buffer.from(salt, "base64url");
    const expectedBytes = Buffer.from(expected, "base64url");
    const key = await scryptAsync(password.normalize("NFKC"), saltBytes, expectedBytes.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: MAX_MEMORY,
    });

    return key.length === expectedBytes.length && timingSafeEqual(key, expectedBytes);
  } catch {
    return false;
  }
}

/** True when this hash was made with weaker parameters than we now use. */
export function needsRehash(stored: string): boolean {
  const [scheme, n, r, p] = stored.split("$");
  return scheme !== "scrypt" || Number(n) !== N || Number(r) !== R || Number(p) !== P;
}

/**
 * Burn roughly the time a real verification takes, for an address that has no
 * account or no password set.
 *
 * Without this, "no such user" returns immediately while a real user costs a
 * scrypt hash, and the difference is measurable from outside -- which turns
 * the sign-in form into a way to find out who has an account here.
 */
export async function fakeVerify(): Promise<void> {
  await scryptAsync("decoy-password-for-constant-time", randomBytes(SALT_BYTES), KEY_BYTES, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEMORY,
  });
}
