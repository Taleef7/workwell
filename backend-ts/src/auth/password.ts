/**
 * Password hashing for the TS demo-user store (#105) — PBKDF2-HMAC-SHA256 via WebCrypto
 * (`globalThis.crypto.subtle`), so it works unchanged on Node and the Cloudflare Worker
 * target with no new dependency. Replaces the Java side's bcrypt; demo accounts are
 * hardcoded (CLAUDE hard rule), so re-hashing the same passwords is fine.
 *
 * Stored format: `pbkdf2$<iterations>$<saltBase64Url>$<hashBase64Url>`.
 * Verification is constant-time on the derived bytes.
 */
const ITERATIONS = 210_000; // OWASP-recommended floor for PBKDF2-HMAC-SHA256
const KEY_LEN = 32; // bytes
const SALT_LEN = 16; // bytes

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const fromB64url = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
    key,
    KEY_LEN * 8,
  );
  return new Uint8Array(bits);
}

/** Hash a plaintext password into the portable `pbkdf2$…` storage string. */
export async function hashPassword(password: string, saltOverride?: Uint8Array): Promise<string> {
  const salt = saltOverride ?? crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

/** Constant-time verify of a plaintext password against a stored `pbkdf2$…` string. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromB64url(parts[2]!);
    expected = fromB64url(parts[3]!);
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await derive(password, salt, iterations);
  if (actual.length !== expected.length) return false;
  // constant-time compare
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}
