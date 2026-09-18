import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Sealing secrets that have to be stored and used again.
 *
 * An OAuth refresh token is not a password: we cannot hash it, because we
 * have to send the original back to Google on every poll. So it is encrypted
 * at rest instead, and a leaked database dump yields ciphertext rather than a
 * set of live grants on other people's mailboxes.
 *
 * AES-256-GCM, so the ciphertext is authenticated -- a tampered row fails to
 * open rather than decrypting to something attacker-chosen.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the size GCM is specified for.

function key(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error(
      "ENCRYPTION_KEY must be set to at least 32 characters before secrets " +
        "can be stored. Generate one with: openssl rand -base64 48",
    );
  }
  // Hashed to exactly 32 bytes, so any sufficiently long passphrase works
  // and nobody has to produce a key of a precise byte length by hand.
  return createHash("sha256").update(secret).digest();
}

/** Encrypt a secret for storage. Output is `iv.tag.ciphertext`, base64url. */
export function seal(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, body].map((part) => part.toString("base64url")).join(".");
}

/** Reverse of seal(). Throws if the value was tampered with or the key changed. */
export function open(sealed: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 3) throw new Error("Malformed sealed value");

  const [iv, tag, body] = parts.map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Used for the inbound webhook's shared secret. Both sides are hashed first
 * so that a length mismatch -- which timingSafeEqual refuses outright -- does
 * not itself become the signal that tells an attacker how long the secret is.
 */
export function secretsMatch(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}
