/**
 * The attributed-list routes (MM-2 PR 3, ADR-082).
 *
 *   node --import tsx --test src/routes/subject-lists.test.ts
 *
 * Runs on the DEFAULT deployment profile, whose synthetic roster is `emp-NNN` — so the namespace gate
 * is exercised here with a corpus id (`pat-001`) as the OUTSIDER. The Maui-profile mirror of the same
 * gate lives in `subject-lists.maui.test.ts`; between them each profile's own namespace is the one
 * that is admitted, which a single-profile test cannot show.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { handleSubjectLists } from "./subject-lists.ts";

const dbPath = join(tmpdir(), `workwell-subject-lists-route-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
let events: SqliteCaseEventStore;

const LEAD = "quality-lead@workwell.dev";

const post = (body: unknown, actor = LEAD, init: RequestInit = {}) =>
  handleSubjectLists(
    new Request("http://x/api/subject-lists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...init,
    }),
    env as never,
    actor,
  );

const postText = (query: string, text: string, actor = LEAD) =>
  handleSubjectLists(
    new Request(`http://x/api/subject-lists?${query}`, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: text,
    }),
    env as never,
    actor,
  );

const get = (path: string) => handleSubjectLists(new Request(`http://x${path}`), env as never, LEAD);

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  events = new SqliteCaseEventStore(db);
});

after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("POST imports a list, resolves it against the ENUMERATED directory, and reports the counts", async () => {
  const res = (await post({
    name: "ACO attribution",
    source: "the quarterly attribution file",
    identifiers: ["emp-006", "emp-007", "emp-99999", " emp-006 "],
  }))!;
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    list: { id: string; name: string; revision: number; status: string; createdBy: string };
    counts: Record<string, number>;
  };
  assert.equal(body.list.revision, 1);
  assert.equal(body.list.status, "COMPLETE");
  assert.equal(body.list.createdBy, LEAD, "the importing account is recorded, not 'system'");
  // The duplicate is dropped and COUNTED: a file with duplicates is a fact about the ACO's export,
  // and silently collapsing it leaves the operator wondering where the rows went.
  assert.deepEqual(body.counts, { total: 3, matched: 2, notFound: 1, ambiguous: 0, duplicatesDropped: 1 });
});

test("the SUBJECT_LIST_IMPORTED audit payload carries counts and provenance and NO identifier", async () => {
  // The namespace gate exists so patient identifiers are not persisted. An audit payload is a table
  // that gets exported wholesale, so an identifier in it would defeat the gate by another route.
  const res = (await post({ name: "audited", identifiers: ["emp-006", "emp-99999"] }))!;
  assert.equal(res.status, 201);
  const rows = await events.recentAuditEventsByType("SUBJECT_LIST_IMPORTED", 10);
  const row = rows[0]!;
  assert.equal(row.actor, LEAD);
  const serialized = JSON.stringify(row.payload);
  assert.match(serialized, /"revision":1/);
  assert.match(serialized, /"matched":1/);
  assert.doesNotMatch(serialized, /emp-006/, "no identifier reaches the ledger");
  assert.doesNotMatch(serialized, /emp-99999/);
});

test("an identifier outside this deployment's namespace refuses the WHOLE upload, before persistence", async () => {
  // M-M authorises a SYNTHETIC sandbox. One real identifier in the file is a real attribution file,
  // and the failure mode of accepting it is that it reaches Neon, its backups and its exports.
  const before_ = ((await get("/api/subject-lists"))! .clone());
  const beforeCount = ((await before_.json()) as unknown[]).length;

  const res = (await post({ name: "real file", identifiers: ["emp-006", "pat-001", "MRN-40182"] }))!;
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string; outsideNamespace: number; total: number };
  assert.equal(body.error, "identifier_outside_sandbox_namespace");
  assert.equal(body.outsideNamespace, 2);
  assert.equal(body.total, 3);
  // The COUNT, never the values: an error body is logged and kept by the browser.
  assert.doesNotMatch(JSON.stringify(body), /MRN-40182/);

  const after_ = (await get("/api/subject-lists"))!;
  assert.equal(((await after_.json()) as unknown[]).length, beforeCount, "nothing was written");
});

test("text/plain takes one identifier per line; a comma is a 400 naming the line", async () => {
  const good = (await postText("name=from%20a%20file", "emp-008\r\nemp-009\r\n\r\n  emp-010  \r\n"))!;
  assert.equal(good.status, 201);
  assert.equal(((await good.json()) as { counts: { total: number } }).counts.total, 3);

  const bad = (await postText("name=csv", "emp-008\nemp-009,Sana Imtiaz\n"))!;
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { message: string }).message, /line 2/);
});

test("a nameless import is refused, and so is an empty one", async () => {
  assert.equal((await post({ identifiers: ["emp-006"] }))!.status, 400);
  assert.equal((await post({ name: "  ", identifiers: ["emp-006"] }))!.status, 400);
  assert.equal((await post({ name: "empty", identifiers: [] }))!.status, 400);
  assert.equal((await post({ name: "not an array", identifiers: "emp-006" }))!.status, 400);
});

test("re-importing a name takes the NEXT revision; the first list is untouched", async () => {
  const first = (await post({ name: "revisioned", identifiers: ["emp-006"] }))!;
  const second = (await post({ name: "revisioned", identifiers: ["emp-006", "emp-007"] }))!;
  const a = (await first.json()) as { list: { id: string; revision: number } };
  const b = (await second.json()) as { list: { id: string; revision: number } };
  assert.equal(a.list.revision, 1);
  assert.equal(b.list.revision, 2);

  const still = (await get(`/api/subject-lists/${a.list.id}`))!;
  assert.equal(((await still.json()) as { counts: { MATCHED: number } }).counts.MATCHED, 1);
});

test("GET /api/subject-lists carries each list's counts, from one grouped read", async () => {
  const res = (await get("/api/subject-lists"))!;
  assert.equal(res.status, 200);
  const rows = (await res.json()) as { name: string; counts: Record<string, number> }[];
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(row.counts, `${row.name} carries counts`);
    assert.equal(typeof row.counts.MATCHED, "number");
  }
});

test("members page, filter by resolution, and carry the directory facts resolved at READ time", async () => {
  const created = (await post({ name: "members", identifiers: ["emp-006", "emp-007", "emp-99999"] }))!;
  const { list } = (await created.json()) as { list: { id: string } };

  const all = (await get(`/api/subject-lists/${list.id}/members?limit=2&offset=0`))!;
  assert.equal(all.headers.get("x-total-count"), "3");
  const page = (await all.json()) as { rawIdentifier: string; subjectName: string | null }[];
  assert.equal(page.length, 2);
  // Names are resolved from the directory on read, never stored on the member row — a name is a
  // directory fact that changes, and a copy would be a second place it could be wrong.
  assert.equal(page[0]!.subjectName, "Omar Siddiq");

  const unresolved = (await get(`/api/subject-lists/${list.id}/members?resolution=NOT_FOUND`))!;
  assert.equal(unresolved.headers.get("x-total-count"), "1");
  const rows = (await unresolved.json()) as { rawIdentifier: string; subjectName: string | null }[];
  assert.equal(rows[0]!.rawIdentifier, "emp-99999");
  assert.equal(rows[0]!.subjectName, null, "a NOT_FOUND member names nobody");
});

test("an unknown resolution token is a 400, never a silently unfiltered page", async () => {
  const created = (await post({ name: "bad-filter", identifiers: ["emp-006"] }))!;
  const { list } = (await created.json()) as { list: { id: string } };
  const res = (await get(`/api/subject-lists/${list.id}/members?resolution=MAYBE`))!;
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { message: string }).message, /MATCHED, NOT_FOUND, AMBIGUOUS/);
});

test("an unknown list is a 404 on every read, and a malformed id is a 404 rather than a 500", async () => {
  assert.equal((await get(`/api/subject-lists/${crypto.randomUUID()}`))!.status, 404);
  assert.equal((await get(`/api/subject-lists/${crypto.randomUUID()}/members`))!.status, 404);
  assert.equal((await get("/api/subject-lists/not-a-uuid"))!.status, 404);
  // Resource before paging: a bad page size must not turn "no such list" into "an empty list".
  assert.equal((await get("/api/subject-lists/not-a-uuid/members?limit=999999"))!.status, 404);
});

test("a live-directory deployment cannot import at all, and the body is never read", async () => {
  // The live directory is a worker-local last-known registry that also fabricates profiles for
  // persisted `wc|` ids, so matching against it would be silently incomplete rather than merely
  // unavailable — every row MATCHED and every denominator wrong. Off until the PHI phase.
  const liveEnv = {
    ...(env as Record<string, unknown>),
    WORKWELL_WEBCHART_BASE_URL: "https://example.invalid/fhir",
    WORKWELL_WEBCHART_API_KEY: "k",
  };
  const res = (await handleSubjectLists(
    new Request("http://x/api/subject-lists", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "live", identifiers: ["emp-006"] }),
    }),
    liveEnv as never,
    LEAD,
  ))!;
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error: string }).error, "not_enabled_on_this_deployment");
});

test("the route declines paths it does not own, so the worker chain continues", async () => {
  assert.equal(await handleSubjectLists(new Request("http://x/api/panels"), env as never, LEAD), null);
  assert.equal(
    await handleSubjectLists(new Request("http://x/api/subject-lists", { method: "DELETE" }), env as never, LEAD),
    null,
    "there is no delete path — immutability is the absence of one, not a 405",
  );
});
