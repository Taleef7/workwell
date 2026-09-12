/**
 * Panels, through the REAL worker (MM-2 PR 2, ADR-080).
 *
 * `panels.test.ts` calls the handler directly, which is the right place to test the behaviour. This
 * file tests the two things that test cannot see, because calling a handler skips both: that the route
 * is actually REACHED by the worker's dispatch chain, and that the auth gate in front of it fires.
 *
 * The worker answers an unrouted path with 501 `not_implemented`, so a handler nobody dispatches to
 * would pass every handler test and 501 in production — the failure this file exists to refuse.
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

const dbPath = join(tmpdir(), `ww-panels-worker-${crypto.randomUUID()}.sqlite`);
let env: Env;
const ctx = {} as never;

before(async () => {
  // A real floor database, so the worker resolves its stores the way it does in the app. The DDL is
  // self-creating, which is what lets the route be exercised end to end without a fixture.
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

const call = (path: string, init: RequestInit = {}, token?: string) =>
  worker.fetch(
    new Request(`http://x${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }),
    env,
    ctx,
  );

test("GET /api/panels is dispatched by the worker and readable by any signed-in role", async () => {
  const res = await call("/api/panels", {}, await login("viewer@workwell.dev"));
  assert.notEqual(res.status, 501, "a handler the worker never dispatches to is a route that does not exist");
  assert.equal(res.status, 200);
  const rows = (await res.json()) as { providerId: string; assignee: string | null }[];
  assert.ok(Array.isArray(rows) && rows.length > 0, "every provider is listed, mapped or not");
});

test("the panels route refuses an anonymous caller, and a VIEWER who tries to write", async () => {
  assert.equal((await call("/api/panels")).status, 401, "reading who works a panel needs a session");

  // A read-only role may see who owns a panel and must not be able to re-route a provider's patients.
  const viewer = await login("viewer@workwell.dev");
  const write = await call(
    "/api/panels/prov-001",
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ assignee: "cm@workwell.dev" }) },
    viewer,
  );
  assert.equal(write.status, 403);
  assert.equal((await call("/api/panels/prov-001", { method: "DELETE" }, viewer)).status, 403);
});

test("a CASE_MANAGER can map and un-map a panel through the worker", async () => {
  const cm = await login("cm@workwell.dev");
  const put = await call(
    "/api/panels/prov-001",
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ assignee: "cm@workwell.dev" }) },
    cm,
  );
  assert.equal(put.status, 200);
  assert.equal(((await put.json()) as { assignee: string }).assignee, "cm@workwell.dev");

  const listed = (await (await call("/api/panels", {}, cm)).json()) as { providerId: string; assignee: string | null }[];
  assert.equal(listed.find((r) => r.providerId === "prov-001")?.assignee, "cm@workwell.dev");

  assert.equal((await call("/api/panels/prov-001", { method: "DELETE" }, cm)).status, 200);
  assert.equal((await call("/api/panels/prov-001", { method: "DELETE" }, cm)).status, 404);
});
