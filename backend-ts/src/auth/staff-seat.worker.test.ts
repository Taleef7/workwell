/**
 * The staff seat through the REAL worker, on the pilot profile (#880, LOCKED §4A.9).
 *
 *   node --import tsx --test src/auth/staff-seat.worker.test.ts
 *
 * `authorize.test.ts` holds the rule table with a role it chooses. This file signs in as the account the
 * pilot group was handed, so it also proves the account carries the staff role, that a refresh keeps it,
 * and that the worker's own gates (the `?listId=` one, the routes' role checks) refuse it too. Nothing
 * here can change a case: every write it sends is either refused or names a case that does not exist.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const script = `
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { createSqliteD1 } from "@mieweb/cloud-local";
  for (const level of ["log", "info", "debug"]) console[level] = (...a) => process.stderr.write(a.join(" ") + "\\n");
  const { default: worker } = await import("./src/worker.ts");

  const env = { DB: await createSqliteD1(join(tmpdir(), "ww-staff-seat-" + crypto.randomUUID() + ".sqlite")), WORKWELL_AUTH_JWT_SECRET: "x".repeat(40) };
  const send = (method, path, token, body, headers = {}) =>
    worker.fetch(new Request("http://x" + path, {
      method,
      headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    }), env, {});
  const login = async (email) => {
    const res = await send("POST", "/api/auth/login", null, { email, password: "Workwell123!" });
    return { ...(await res.json()), cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
  };
  const roleOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).role;

  const staff = await login("quality-staff@maui.workwell.dev");
  const lead = await login("quality-lead@maui.workwell.dev");
  const refreshed = await (await send("POST", "/api/auth/refresh", null, null, { cookie: staff.cookie })).json();
  const t = staff.token;
  const status = async (method, path, body) => (await send(method, path, t, body)).status;
  process.stdout.write(JSON.stringify({
    staffRole: staff.role,
    staffTokenRole: roleOf(t),
    refreshedRole: refreshed.role,
    refreshedTokenRole: roleOf(refreshed.token),
    bulkAssign: await status("POST", "/api/cases/bulk-assign", { assignee: "quality-staff@maui.workwell.dev", caseIds: [] }),
    leadBulkAssign: (await send("POST", "/api/cases/bulk-assign", lead.token, { assignee: "quality-staff@maui.workwell.dev", caseIds: [] })).status,
    singleAssign: await status("POST", "/api/cases/00000000-0000-0000-0000-000000000000/assign", { assignee: "quality-staff@maui.workwell.dev" }),
    subjectLists: await status("GET", "/api/subject-lists"),
    listFilter: await status("GET", "/api/cases?listId=00000000-0000-0000-0000-000000000000"),
    panelPut: await status("PUT", "/api/panels/maui-prov-011", { assignee: "quality-staff@maui.workwell.dev" }),
    identity: await status("GET", "/api/identity/people"),
    campaigns: await status("GET", "/api/campaigns"),
    runs: await status("POST", "/api/runs/manual", {}),
    scorecard: await status("GET", "/api/scorecard"),
    cases: await status("GET", "/api/cases"),
    assignable: await status("GET", "/api/users/assignable"),
    exportCases: await status("GET", "/api/exports/cases?format=csv"),
  }));
`;

test("the staff account is the staff role, keeps it on refresh, and every lead-only lever refuses it through the worker", () => {
  const out = runProfileChild("maui", script, {
    WORKWELL_MAUI_CORPUS_SIZE: "100",
    WORKWELL_OFFICIAL_MEASURES: "cms122",
    WORKWELL_VSAC_API_KEY: undefined,
  });
  assert.equal(out.staffRole, "ROLE_QUALITY_STAFF");
  assert.equal(out.staffTokenRole, "ROLE_QUALITY_STAFF");
  // The refresh token carries no role; the refresh re-reads the account, so a seat's role change reaches
  // an open session within one access token.
  assert.equal(out.refreshedRole, "ROLE_QUALITY_STAFF");
  assert.equal(out.refreshedTokenRole, "ROLE_QUALITY_STAFF");

  assert.equal(out.bulkAssign, 403, "bulk assign is the lead's");
  assert.notEqual(out.leadBulkAssign, 403, "the lead may bulk assign");
  assert.notEqual(out.singleAssign, 403, "single assign stays with staff");
  assert.notEqual(out.singleAssign, 401);
  for (const key of ["subjectLists", "listFilter", "panelPut", "identity", "campaigns", "runs"]) {
    assert.equal(out[key], 403, key);
  }
  for (const key of ["scorecard", "cases", "assignable", "exportCases"]) {
    assert.equal(out[key], 200, key);
  }
});
