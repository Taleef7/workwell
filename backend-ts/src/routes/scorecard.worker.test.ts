/**
 * The scorecard through the REAL worker, on the pilot profile (#870).
 *
 *   node --import tsx --test src/routes/scorecard.worker.test.ts
 *
 * `scorecard.maui.test.ts` calls the handler with a role it chooses, which is the right place for the
 * counting. This file tests what that cannot see: that the worker hands the route the signed-in seat's own
 * role and the fact that sign-in is enforced, so a clinician's token reads only its own row, and that the
 * authorize gate in front keeps anonymous callers and the scorecard's sub-paths out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const script = `
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { createSqliteD1 } from "@mieweb/cloud-local";
  // The worker logs its boot to stdout, which is where this child answers: send the log to stderr.
  for (const level of ["log", "info", "debug"]) console[level] = (...a) => process.stderr.write(a.join(" ") + "\\n");
  const { default: worker } = await import("./src/worker.ts");

  const env = { DB: await createSqliteD1(join(tmpdir(), "ww-scorecard-worker-" + crypto.randomUUID() + ".sqlite")), WORKWELL_AUTH_JWT_SECRET: "x".repeat(40) };
  const call = (path, token) =>
    worker.fetch(new Request("http://x" + path, { headers: token ? { authorization: "Bearer " + token } : {} }), env, {});
  const login = async (email) => {
    const res = await worker.fetch(new Request("http://x/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Workwell123!" }),
    }), env, {});
    return (await res.json()).token;
  };
  const read = async (path, token) => {
    const res = await call(path, token);
    return { status: res.status, body: await res.json() };
  };

  const clinician = await login("clinician@maui.workwell.dev");
  const staff = await login("quality-staff@maui.workwell.dev");
  process.stdout.write(JSON.stringify({
    mine: await read("/api/providers/mine", clinician),
    clinician: await read("/api/scorecard", clinician),
    clinicianSub: (await call("/api/scorecard/export", clinician)).status,
    staff: await read("/api/scorecard", staff),
    anonymous: (await call("/api/scorecard")).status,
  }));
`;

test("a clinician's token reads its own row through the worker, and the gate keeps anonymous callers and sub-paths out", () => {
  const out = runProfileChild("maui", script, {
    WORKWELL_MAUI_CORPUS_SIZE: "100",
    WORKWELL_OFFICIAL_MEASURES: "cms122",
    WORKWELL_VSAC_API_KEY: undefined,
  });
  type Card = { locations: unknown[]; other: unknown; scope?: { providerId: string } };
  const mine = out.mine as { status: number; body: { provider: { id: string } | null } };
  assert.equal(mine.status, 200);
  assert.equal(mine.body.provider?.id, "maui-prov-011");

  const clinician = out.clinician as { status: number; body: Card };
  assert.equal(clinician.status, 200, "a handler the worker never dispatches to would answer 501");
  assert.equal(clinician.body.scope?.providerId, "maui-prov-011");
  assert.deepEqual(clinician.body.locations, []);
  assert.equal(clinician.body.other, null);
  assert.equal(out.clinicianSub, 403, "the scorecard's sub-paths stay CM/ADMIN");

  const staff = out.staff as { status: number; body: Card };
  assert.equal(staff.status, 200);
  assert.equal("scope" in staff.body, false, "a case manager reads the practice card");
  assert.equal(out.anonymous, 401);
});
