/**
 * The panels route (MM-2 PR 2, ADR-080).
 *
 * What matters here: every provider is listed whether mapped or not (an unowned panel is the row the
 * screen exists to show), an unknown provider is a 404 before any body validation, a mistyped
 * assignee is refused by name, and mapping a panel actually moves that provider's open work.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { handlePanels } from "./panels.ts";

const dbPath = join(tmpdir(), `workwell-panels-route-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
let cases: SqliteCaseStore;
let events: SqliteCaseEventStore;

const LEAD = "quality-lead@workwell.dev";
const CM = "cm@workwell.dev";

const list = () => handlePanels(new Request("http://x/api/panels"), env as never, LEAD);
const put = (providerId: string, body: unknown, actor = LEAD) =>
  handlePanels(
    new Request(`http://x/api/panels/${providerId}`, {
      method: "PUT",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env as never,
    actor,
  );
const del = (providerId: string, actor = LEAD) =>
  handlePanels(new Request(`http://x/api/panels/${providerId}`, { method: "DELETE" }), env as never, actor);

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  cases = new SqliteCaseStore(db);
  events = new SqliteCaseEventStore(db);
});

after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("GET /api/panels lists EVERY provider, with the unmapped ones first", async () => {
  const res = (await list())!;
  assert.equal(res.status, 200);
  const rows = (await res.json()) as { providerId: string; assignee: string | null; patients: number }[];
  assert.ok(rows.length >= 6, "every provider in the directory, not only the mapped ones");
  assert.ok(rows.every((r) => r.assignee === null), "nothing is mapped yet");
  // The patient count is the size of the panel being handed over — a supervisor deciding who takes
  // prov-003 is deciding about twenty people, and the row should say so.
  assert.ok(rows.some((r) => r.patients > 0), "the directory's attribution is reported");
});

test("PUT maps the panel, moves that provider's open cases, and reports what moved", async () => {
  // Two of prov-001's patients have open gaps; one of prov-002's does. Only the first two may move.
  const mine = await cases.upsertFromOutcome({
    runId: crypto.randomUUID(), subjectId: "emp-005", measureId: "audiogram",
    evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE",
  });
  const alsoMine = await cases.upsertFromOutcome({
    runId: crypto.randomUUID(), subjectId: "emp-007", measureId: "audiogram",
    evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE",
  });
  const theirs = await cases.upsertFromOutcome({
    runId: crypto.randomUUID(), subjectId: "emp-006", measureId: "audiogram",
    evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE",
  });

  const res = (await put("prov-001", { assignee: CM }))!;
  assert.equal(res.status, 200);
  const body = (await res.json()) as { changed: boolean; backfilled: number; previousAssignee: string | null; providerName: string };
  assert.equal(body.changed, true);
  assert.equal(body.previousAssignee, null);
  assert.equal(body.backfilled, 2, "both of this provider's open cases moved");
  assert.ok(body.providerName, "the response names the provider, so the toast can too");

  assert.equal((await cases.getCase(mine!.id))?.assignee, CM);
  assert.equal((await cases.getCase(alsoMine!.id))?.assignmentSource, "PANEL");
  assert.equal((await cases.getCase(theirs!.id))?.assignee, null, "another provider's patient is untouched");

  const listed = (await (await list())!.json()) as { providerId: string; assignee: string | null }[];
  assert.equal(listed.find((r) => r.providerId === "prov-001")?.assignee, CM);
  // The mapped row sorts after the unmapped ones: the actionable rows stay at the top.
  assert.equal(listed[0]?.assignee, null);
});

test("re-saving the same account leaves the mapping alone and writes nothing", async () => {
  const before = (await events.listAuditEvents(500, 0)).length;
  const res = (await put("prov-001", { assignee: CM }))!;
  const body = (await res.json()) as { changed: boolean; backfilled: number };
  assert.equal(body.changed, false, "`changed` describes the MAPPING");
  assert.equal(body.backfilled, 0, "and `backfilled` the cases — here, neither moved");
  assert.equal((await events.listAuditEvents(500, 0)).length, before, "a change that did not happen is not audited");
});

test("an unknown provider is 404 — before the body is even looked at", async () => {
  // Resource first, so a bad assignee can never turn "that provider does not exist" into a 400 about
  // the assignee, which would send someone hunting for the wrong problem.
  const res = (await put("prov-does-not-exist", { assignee: "nobody@workwell.dev" }))!;
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { error: string }).error, "not_found");
});

test("an assignee nobody can sign in as is refused, and the message names the accepted accounts", async () => {
  const res = (await put("prov-002", { assignee: "Bobbi" }))!;
  assert.equal(res.status, 400);
  const body = (await res.json()) as { parameter: string; message: string };
  assert.equal(body.parameter, "assignee");
  assert.match(body.message, /must be one of:/, "the offer and the check come from one list");
});

test("a blank assignee is refused, and says which verb un-maps a panel", async () => {
  // Blank is not "un-map": DELETE is. Accepting blank here would give one action two spellings, one of
  // which reads like a mistake.
  const res = (await put("prov-002", { assignee: "  " }))!;
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { message: string }).message, /DELETE/);
});

test("a non-JSON body is a 400, not a crash", async () => {
  const res = (await put("prov-002", "not json"))!;
  assert.equal(res.status, 400);
});

test("DELETE un-maps the panel and names whose it was; the open cases keep their assignee", async () => {
  const stillMine = await cases.upsertFromOutcome({
    runId: crypto.randomUUID(), subjectId: "emp-009", measureId: "hazwoper",
    evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE",
  });
  // prov-001 is still mapped to CM from the earlier test, so this re-save moves the mapping not at
  // all and the newly-opened case exactly once — the sweep that recovers stranded work.
  const resave = (await put("prov-001", { assignee: CM }))!;
  const resaveBody = (await resave.json()) as { changed: boolean; backfilled: number };
  assert.equal(resaveBody.changed, false);
  assert.equal(resaveBody.backfilled, 1);

  const res = (await del("prov-001"))!;
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { previousAssignee: string }).previousAssignee, CM);

  const listed = (await (await list())!.json()) as { providerId: string; assignee: string | null }[];
  assert.equal(listed.find((r) => r.providerId === "prov-001")?.assignee, null);
  // ADR-080 d4 — un-mapping says who owns FUTURE work. Dropping in-flight cases would lose real work.
  assert.equal((await cases.getCase(stillMine!.id))?.assignee, CM, "work in flight keeps its owner");

  assert.equal((await del("prov-001"))!.status, 404, "un-mapping an unmapped panel is a 404");
});

test("the route ignores paths and methods that are not its own", async () => {
  assert.equal(await handlePanels(new Request("http://x/api/providers"), env as never, LEAD), null);
  assert.equal(
    await handlePanels(new Request("http://x/api/panels/prov-001", { method: "POST" }), env as never, LEAD),
    null,
    "POST is not a panel verb — it falls through rather than being answered wrongly",
  );
});
