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

test("Maui sandbox accounts resolve case-insensitively with their expected roles on the maui profile", () => {
  const accounts = [
    ["quality-lead@maui.workwell.dev", "ROLE_CASE_MANAGER"],
    ["quality-staff@maui.workwell.dev", "ROLE_CASE_MANAGER"],
    ["clinician@maui.workwell.dev", "ROLE_VIEWER"],
    ["admin@maui.workwell.dev", "ROLE_ADMIN"],
  ] as const;

  for (const [email, role] of accounts) {
    assert.equal(findDemoUser(email.toUpperCase(), "maui")?.role, role);
  }
});

test("Maui sandbox accounts authenticate with the documented demo password on the maui profile", () => {
  const output = runProfileChild("maui", `
    import { DEMO_USERS, authenticate } from "./src/auth/demo-users.ts";

    const results = {};
    for (const u of DEMO_USERS) {
      const res = await authenticate(u.email, "Workwell123!");
      results[u.email] = res?.role ?? null;
    }
    console.log(JSON.stringify(results));
  `);
  const mauiAccounts = DEMO_USERS.filter((u) => u.email.endsWith("@maui.workwell.dev"));
  for (const u of DEMO_USERS) {
    if (mauiAccounts.includes(u)) continue;
    assert.equal(output[u.email], null, `${u.email} returns null on maui`);
  }
  assert.equal(output["quality-lead@maui.workwell.dev"], "ROLE_CASE_MANAGER");
  assert.equal(output["quality-staff@maui.workwell.dev"], "ROLE_CASE_MANAGER");
  assert.equal(output["clinician@maui.workwell.dev"], "ROLE_VIEWER");
  assert.equal(output["admin@maui.workwell.dev"], "ROLE_ADMIN");
});

test("findDemoUser is case-insensitive and trims", () => {
  assert.equal(findDemoUser("  ADMIN@workwell.dev ")?.role, "ROLE_ADMIN");
  assert.equal(findDemoUser("nobody@workwell.dev"), null);
});

test("findDemoUser scopes by profileId in-process without child process", () => {
  assert.equal(findDemoUser("viewer@workwell.dev", "maui"), null);
  assert.equal(findDemoUser("admin@workwell.dev", "maui"), null);
  assert.equal(findDemoUser("quality-lead@maui.workwell.dev", "maui")?.role, "ROLE_CASE_MANAGER");
  assert.equal(findDemoUser("clinician@maui.workwell.dev", "maui")?.role, "ROLE_VIEWER");

  assert.equal(findDemoUser("viewer@workwell.dev", "default")?.role, "ROLE_VIEWER");
  assert.equal(findDemoUser("admin@workwell.dev", "default")?.role, "ROLE_ADMIN");
  assert.equal(findDemoUser("quality-lead@maui.workwell.dev", "default"), null);
});

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function runProfileChild(instance: string | undefined, source: string): Record<string, unknown> {
  const env = { ...process.env };
  if (instance === undefined) delete env.WORKWELL_INSTANCE;
  else env.WORKWELL_INSTANCE = instance;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    { cwd: backendRoot, env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

test("authenticate accepts the demo password and rejects a wrong one / unknown user", async () => {
  assert.equal((await authenticate("admin@workwell.dev", "Workwell123!"))?.role, "ROLE_ADMIN");
  assert.equal(await authenticate("admin@workwell.dev", "wrong"), null);
  assert.equal(await authenticate("ghost@workwell.dev", "Workwell123!"), null);
});

test("profile scoping: on Maui profile only @maui.workwell.dev accounts authenticate", () => {
  const output = runProfileChild("maui", `
    import { authenticate } from "./src/auth/demo-users.ts";

    const viewer = await authenticate("viewer@workwell.dev", "Workwell123!");
    const admin = await authenticate("admin@workwell.dev", "Workwell123!");
    const qualityLead = await authenticate("quality-lead@maui.workwell.dev", "Workwell123!");
    console.log(JSON.stringify({
      viewer: viewer?.email ?? null,
      admin: admin?.email ?? null,
      qualityLead: qualityLead?.email ?? null,
    }));
  `);
  assert.equal(output.viewer, null, "viewer@workwell.dev returns null on maui");
  assert.equal(output.admin, null, "admin@workwell.dev returns null on maui");
  assert.equal(output.qualityLead, "quality-lead@maui.workwell.dev", "quality-lead@maui.workwell.dev succeeds on maui");
});

test("profile scoping: on default profile the non-Maui demo accounts authenticate", () => {
  const output = runProfileChild(undefined, `
    import { authenticate, DEMO_USERS } from "./src/auth/demo-users.ts";

    const results = {};
    for (const u of DEMO_USERS) {
      const res = await authenticate(u.email, "Workwell123!");
      results[u.email] = res?.role ?? null;
    }
    console.log(JSON.stringify(results));
  `);
  for (const u of DEMO_USERS.filter((u) => !u.email.endsWith("@maui.workwell.dev"))) {
    assert.equal(output[u.email], u.role, `${u.email} authenticates on default`);
  }
  for (const u of DEMO_USERS.filter((u) => u.email.endsWith("@maui.workwell.dev"))) {
    assert.equal(output[u.email], null, `${u.email} returns null on default`);
  }
});

test("profile scoping: on default profiles @maui.workwell.dev accounts are refused", () => {
  for (const instance of [undefined, "default", "twh"] as const) {
    const output = runProfileChild(instance, `
      import { authenticate, DEMO_USERS } from "./src/auth/demo-users.ts";

      const results = {};
      for (const u of DEMO_USERS) {
        const res = await authenticate(u.email, "Workwell123!");
        results[u.email] = res?.role ?? null;
      }
      console.log(JSON.stringify(results));
    `);
    for (const u of DEMO_USERS) {
      const expected = u.email.endsWith("@maui.workwell.dev") ? null : u.role;
      assert.equal(output[u.email], expected, `${u.email} on ${instance ?? "unset"} profile`);
    }
  }
});
