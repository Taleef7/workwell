/**
 * The attributed list's authorization boundary, through the REAL worker (MM-2 PR 3, ADR-082).
 *
 * `subject-lists.test.ts` calls the handler directly, which is the right place for the route's
 * behaviour. This file tests the two things that cannot see: that the worker dispatches to it at all,
 * and that the auth gate in front of it fires.
 *
 * **The `?listId=` gate is the reason this file exists.** Every method on `/api/subject-lists/**` is
 * CM/ADMIN, and that gate was a control that could not fire for the widest read: five of the six
 * surfaces that accept `?listId=` are AUTHENTICATED, so a VIEWER holding a list id could take the
 * whole membership — names, provider, payer, per-measure status — out of `/api/exports/cases` as a
 * CSV. The id is not a secret by construction: it sits in the query string of every filtered screen,
 * so it reaches shareable URLs, browser history and access logs.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import worker from "../worker.ts";
import type { Env } from "../worker.ts";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";

const dbPath = join(tmpdir(), `ww-subject-lists-worker-${crypto.randomUUID()}.sqlite`);
let env: Env;
const ctx = {} as never;

/** A syntactically valid UUID no import can have produced — so these tests assert only about the gate. */
const ABSENT_LIST = "9f1c2b3a-0000-4000-8000-0000000000ff";

before(async () => {
  env = { DB: await createSqliteD1(dbPath), WORKWELL_AUTH_JWT_SECRET: "x".repeat(40) } as unknown as Env;
});

after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

const tokens: Record<string, string> = {};
async function login(email: string): Promise<string> {
  if (tokens[email]) return tokens[email]!;
  const res = await worker.fetch(
    new Request("http://x/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Workwell123!" }),
    }),
    env,
    ctx,
  );
  assert.equal(res.status, 200, `login for ${email}`);
  const { token } = (await res.json()) as { token: string };
  tokens[email] = token;
  return token;
}

const call = (path: string, token?: string) =>
  worker.fetch(
    new Request(`http://x${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }),
    env,
    ctx,
  );

test("the worker dispatches /api/subject-lists, and a CASE_MANAGER may read it", async () => {
  const res = await call("/api/subject-lists", await login("cm@workwell.dev"));
  assert.notEqual(res.status, 501, "a handler the worker never dispatches to is a route that does not exist");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test("a VIEWER is refused the list metadata, not only the members", async () => {
  // Deliberately stricter than panels, whose reads are AUTHENTICATED: the list's mere existence says
  // which patients an ACO claims, and the public /sandbox signs in as a VIEWER.
  const viewer = await login("viewer@workwell.dev");
  for (const path of [
    "/api/subject-lists",
    `/api/subject-lists/${ABSENT_LIST}`,
    `/api/subject-lists/${ABSENT_LIST}/members`,
    `/api/subject-lists/${ABSENT_LIST}/report?measurementYear=2027`,
  ]) {
    assert.equal((await call(path, viewer)).status, 403, path);
    assert.equal((await call(path)).status, 401, `${path} anonymous`);
  }
});

test("a VIEWER cannot narrow ANY surface to a list — the gate the membership actually leaks through", async () => {
  // Without this the CM/ADMIN gate above reads as present and cannot fire for the widest read. The
  // CSV export is the worst case: it returns names, provider, payer and per-measure status for exactly
  // the list's members, which is strictly MORE than the members endpoint that was gated.
  const viewer = await login("viewer@workwell.dev");
  for (const path of [
    `/api/exports/cases?format=csv&listId=${ABSENT_LIST}`,
    `/api/exports/outcomes?format=csv&listId=${ABSENT_LIST}`,
    `/api/worklist/patients?listId=${ABSENT_LIST}`,
    `/api/cases?listId=${ABSENT_LIST}&limit=1`,
    `/api/compliance/roster?listId=${ABSENT_LIST}`,
  ]) {
    const res = await call(path, viewer);
    assert.equal(res.status, 403, `${path} must refuse a viewer`);
    const body = (await res.json()) as { error: string; parameter?: string };
    assert.equal(body.parameter, "listId", `${path} says WHY`);
  }
});

test("the same surfaces stay open to a VIEWER when no list is named", async () => {
  // The gate is about `?listId=`, not about the surfaces. Refusing them outright would be a different
  // product decision, and a control that over-fires is as wrong as one that cannot.
  const viewer = await login("viewer@workwell.dev");
  for (const path of ["/api/worklist/patients?limit=1", "/api/cases?limit=1"]) {
    const res = await call(path, viewer);
    assert.equal(res.status, 200, `${path} is unchanged for a viewer`);
  }
});

test("a CASE_MANAGER may narrow to a list, and gets the ordinary 404 for one that does not exist", async () => {
  const cm = await login("cm@workwell.dev");
  const res = await call(`/api/worklist/patients?listId=${ABSENT_LIST}`, cm);
  assert.equal(res.status, 404, "authorized, then refused for the real reason");
  assert.equal(((await res.json()) as { parameter: string }).parameter, "listId");
});
