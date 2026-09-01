/**
 * Demo-user directory tests (#105): the four hardcoded roles, case-insensitive
 * lookup, and PBKDF2 credential check — mirrors the Java demo_users seed (V003).
 *   node --import tsx --test src/auth/demo-users.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_USERS, findDemoUser, authenticate } from "./demo-users.ts";

test("seeds the four Java demo roles plus the read-only viewer (public sandbox)", () => {
  assert.deepEqual(
    DEMO_USERS.map((u) => `${u.email}:${u.role}`).sort(),
    [
      "admin@maui.workwell.dev:ROLE_ADMIN",
      "admin@workwell.dev:ROLE_ADMIN",
      "approver@workwell.dev:ROLE_APPROVER",
      "author@workwell.dev:ROLE_AUTHOR",
      "clinician@maui.workwell.dev:ROLE_VIEWER",
      "cm@workwell.dev:ROLE_CASE_MANAGER",
      "quality-lead@maui.workwell.dev:ROLE_CASE_MANAGER",
      "quality-staff@maui.workwell.dev:ROLE_CASE_MANAGER",
      "viewer@workwell.dev:ROLE_VIEWER",
    ],
  );
});

test("Maui sandbox accounts resolve case-insensitively with their expected roles", () => {
  const accounts = [
    ["quality-lead@maui.workwell.dev", "ROLE_CASE_MANAGER"],
    ["quality-staff@maui.workwell.dev", "ROLE_CASE_MANAGER"],
    ["clinician@maui.workwell.dev", "ROLE_VIEWER"],
    ["admin@maui.workwell.dev", "ROLE_ADMIN"],
  ] as const;

  for (const [email, role] of accounts) {
    assert.equal(findDemoUser(email.toUpperCase())?.role, role);
  }
});

test("Maui sandbox accounts authenticate with the documented demo password", async () => {
  const accounts = [
    ["quality-lead@maui.workwell.dev", "ROLE_CASE_MANAGER"],
    ["quality-staff@maui.workwell.dev", "ROLE_CASE_MANAGER"],
    ["clinician@maui.workwell.dev", "ROLE_VIEWER"],
    ["admin@maui.workwell.dev", "ROLE_ADMIN"],
  ] as const;

  for (const [email, role] of accounts) {
    assert.equal((await authenticate(email, "Workwell123!"))?.role, role);
  }
});

test("findDemoUser is case-insensitive and trims", () => {
  assert.equal(findDemoUser("  ADMIN@workwell.dev ")?.role, "ROLE_ADMIN");
  assert.equal(findDemoUser("nobody@workwell.dev"), null);
});

test("authenticate accepts the demo password and rejects a wrong one / unknown user", async () => {
  assert.equal((await authenticate("admin@workwell.dev", "Workwell123!"))?.role, "ROLE_ADMIN");
  assert.equal(await authenticate("admin@workwell.dev", "wrong"), null);
  assert.equal(await authenticate("ghost@workwell.dev", "Workwell123!"), null);
});
