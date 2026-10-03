/**
 * Demo-user directory tests (#105): the four hardcoded roles, case-insensitive
 * lookup, and PBKDF2 credential check — mirrors the Java demo_users seed (V003).
 *   node --import tsx --test src/auth/demo-users.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_USERS, findDemoUser, authenticate, pilotPasswordHash } from "./demo-users.ts";
import { hashPassword } from "./password.ts";
import { runProfileChild } from "../test-support/run-profile-child.ts";

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
  `, { WORKWELL_PILOT_PASSWORD_HASH: undefined });
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

test("pilotPasswordHash: unset keeps the demo hash, a PBKDF2 string is used, anything else disables sign-in", async () => {
  const demo = pilotPasswordHash({});
  assert.match(demo, /^pbkdf2\$/);
  assert.equal(pilotPasswordHash({ WORKWELL_PILOT_PASSWORD_HASH: "   " }), demo, "blank counts as unset");
  const own = await hashPassword("pilot-only-test-password");
  assert.equal(pilotPasswordHash({ WORKWELL_PILOT_PASSWORD_HASH: ` ${own} ` }), own);
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(pilotPasswordHash({ WORKWELL_PILOT_PASSWORD_HASH: "Workwell123!" }), "disabled", "a plaintext value is never used");
    assert.equal(pilotPasswordHash({ WORKWELL_PILOT_PASSWORD_HASH: ` ${demo} ` }), "disabled", "the demo hash pasted as the secret is refused");
    assert.equal(pilotPasswordHash({ WORKWELL_PILOT_PASSWORD_HASH: "pbkdf2$0$a$b" }), "disabled", "a hash verifyPassword would reject is not accepted");
    assert.equal(pilotPasswordHash({ WORKWELL_PILOT_PASSWORD_HASH: `${own}x$extra` }), "disabled", "trailing junk is not accepted");
    assert.equal(pilotPasswordHash({ WORKWELL_INSTANCE: "maui", WORKWELL_ENVIRONMENT: "production" }), "disabled", "unset on a production pilot stack");
    // Every spelling the profile resolver accepts as the pilot stack fails closed too.
    for (const spelling of ["Maui", " maui ", "MAUI"]) {
      assert.equal(
        pilotPasswordHash({ WORKWELL_INSTANCE: spelling, WORKWELL_ENVIRONMENT: "production" }),
        "disabled",
        `WORKWELL_INSTANCE=${JSON.stringify(spelling)} selects the pilot profile, so it must not fall back to the public password`,
      );
    }
  } finally {
    console.error = original;
  }
  assert.equal(pilotPasswordHash({ WORKWELL_INSTANCE: "maui" }), demo, "unset on a local pilot run keeps the demo password");
});

test("on the deployed pilot stack every pilot account takes the stack's password and refuses the public one", async () => {
  const own = await hashPassword("pilot-only-test-password");
  const script = `
    import { DEMO_USERS, authenticate } from "./src/auth/demo-users.ts";
    const out = {};
    for (const u of DEMO_USERS.filter((u) => u.email.endsWith("@maui.workwell.dev"))) {
      out[u.email] = {
        own: (await authenticate(u.email, "pilot-only-test-password"))?.role ?? null,
        demo: (await authenticate(u.email, "Workwell123!"))?.role ?? null,
      };
    }
    console.log(JSON.stringify({ out }));
  `;
  const pilots = DEMO_USERS.filter((u) => u.email.endsWith("@maui.workwell.dev"));
  assert.equal(pilots.length, 4);
  const results = (env: Record<string, string>) => runProfileChild("maui", script, env) as { out: Record<string, { own: string | null; demo: string | null }>; stderr: string };

  const withHash = results({ WORKWELL_PILOT_PASSWORD_HASH: own });
  for (const u of pilots) {
    assert.equal(withHash.out[u.email]?.own, u.role, `${u.email} signs in with the stack's password`);
    assert.equal(withHash.out[u.email]?.demo, null, `${u.email} refuses the password printed in this repo`);
  }

  const malformed = results({ WORKWELL_PILOT_PASSWORD_HASH: "not-a-hash" });
  for (const u of pilots) assert.deepEqual(malformed.out[u.email], { own: null, demo: null }, `${u.email} with a malformed secret`);
  assert.match(malformed.stderr, /pilot sign-in is disabled/);
  assert.ok(!malformed.stderr.includes("not-a-hash"), "the configured value is never logged");

  // A production pilot stack whose secret went missing (a self-heal that dropped it) fails closed.
  const unsetInProduction = results({ WORKWELL_PILOT_PASSWORD_HASH: "", WORKWELL_ENVIRONMENT: "production" });
  for (const u of pilots) assert.deepEqual(unsetInProduction.out[u.email], { own: null, demo: null }, `${u.email} with no secret in production`);
  assert.match(unsetInProduction.stderr, /unset on a production pilot stack/);
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
