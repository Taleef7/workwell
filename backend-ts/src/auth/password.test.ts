/**
 * Tests for PBKDF2 password hashing (#105) — WebCrypto only (no new dep), portable
 * across Node and the Cloudflare Worker target. Replaces the Java side's bcrypt for
 * the TS demo-user store (hardcoded demo accounts; ADR/CLAUDE hard rule).
 *   node --import tsx --test src/auth/password.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "./password.ts";

test("a freshly hashed password verifies", async () => {
  const stored = await hashPassword("Workwell123!");
  assert.equal(await verifyPassword("Workwell123!", stored), true);
});

test("the stored format is pbkdf2$<iter>$<salt>$<hash> and salts are random per hash", async () => {
  const a = await hashPassword("Workwell123!");
  const b = await hashPassword("Workwell123!");
  assert.match(a, /^pbkdf2\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.notEqual(a, b, "random salt → different stored strings for the same password");
  assert.equal(await verifyPassword("Workwell123!", b), true);
});

test("a wrong password does not verify", async () => {
  const stored = await hashPassword("Workwell123!");
  assert.equal(await verifyPassword("wrong-password", stored), false);
});

test("malformed stored strings return false, never throw", async () => {
  assert.equal(await verifyPassword("x", "not-a-hash"), false);
  assert.equal(await verifyPassword("x", "pbkdf2$abc$def"), false);
  assert.equal(await verifyPassword("x", ""), false);
});
