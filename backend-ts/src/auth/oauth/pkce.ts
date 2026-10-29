/**
 * PKCE (RFC 7636), S256 only. MCP 2026-07-28: clients "MUST use the `S256`" method, and an authorization
 * request without an explicit `code_challenge_method` would mean `plain`, which is refused.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/** A code verifier: 43–128 characters from the unreserved set (RFC 7636 §4.1). */
export const isCodeVerifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9\-._~]{43,128}$/.test(value);

/** An S256 code challenge: the base64url SHA-256 of a verifier, 43 characters. */
export const isS256Challenge = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9\-_]{43}$/.test(value);

export const s256 = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

/** Constant-time: does `verifier` hash to `challenge`? */
export function verifierMatches(verifier: string, challenge: string): boolean {
  if (!isCodeVerifier(verifier) || !isS256Challenge(challenge)) return false;
  const a = Buffer.from(s256(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}
