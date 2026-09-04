/**
 * Assignable-users route under the Maui deployment profile (profile-child, matching
 * authorize.maui.test.ts). The list must follow the deployment profile, not the hardcoded
 * workwell.dev suggestions the case page used to ship.
 *
 *   node --import tsx --test src/routes/assignable-users.maui.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const assignableScriptFor = (tokenEmail: string) => `
  // runProfileChild parses the whole stdout, so swallow the worker boot log (not the JSON result).
  const workerLog = console.log;
  console.log = () => {};
  const worker = (await import("./src/worker.ts")).default;
  console.log = workerLog;

  import { createJwt } from "./src/auth/jwt.ts";
  import { createSqliteD1 } from "@mieweb/cloud-local";

  const secret = "x".repeat(40);
  const jwt = createJwt({ secret });
  const token = jwt.issueAccessToken(${JSON.stringify(tokenEmail)}, "ROLE_CASE_MANAGER");
  const db = await createSqliteD1(":memory:");
  const env = { DB: db, WORKWELL_AUTH_JWT_SECRET: secret };
  const originalLog = console.log;
  console.log = () => {};
  let res;
  try {
    res = await worker.fetch(
      new Request("http://x/api/users/assignable", { headers: { authorization: "Bearer " + token } }),
      env,
      {},
    );
  } finally {
    console.log = originalLog;
  }
  const users = res.status === 200 ? await res.json() : null;
  console.log(JSON.stringify({ status: res.status, users }));
`;

test("GET /api/users/assignable on default returns the non-Maui CM/ADMIN demo users, email-sorted", () => {
  const output = runProfileChild(undefined, assignableScriptFor("cm@workwell.dev"));
  assert.equal(output.status, 200);
  assert.deepEqual(output.users, [
    { email: "admin@workwell.dev", role: "ROLE_ADMIN" },
    { email: "cm@workwell.dev", role: "ROLE_CASE_MANAGER" },
  ]);
  for (const user of output.users) {
    assert.ok(!/ROLE_(AUTHOR|APPROVER|VIEWER)/.test(user.role), "only CM/ADMIN roles are assignable");
  }
});

test("GET /api/users/assignable on maui returns only maui CM/ADMIN users, email-sorted", () => {
  const output = runProfileChild("maui", assignableScriptFor("quality-lead@maui.workwell.dev"));
  assert.equal(output.status, 200);
  assert.deepEqual(output.users, [
    { email: "admin@maui.workwell.dev", role: "ROLE_ADMIN" },
    { email: "quality-lead@maui.workwell.dev", role: "ROLE_CASE_MANAGER" },
    { email: "quality-staff@maui.workwell.dev", role: "ROLE_CASE_MANAGER" },
  ]);
  for (const user of output.users) {
    assert.ok(!user.email.endsWith("@workwell.dev"), "a workwell.dev demo account must not appear on maui");
  }
});
