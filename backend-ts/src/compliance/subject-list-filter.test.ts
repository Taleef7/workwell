/**
 * `?listId=` across every surface that takes it (MM-2 PR 3, ADR-082).
 *
 *   node --import tsx --test src/compliance/subject-list-filter.test.ts
 *
 * **The point of testing all six together is that the wiring is where one gets forgotten.** The
 * predicate lives in one place and is already covered; what is not covered by a unit test is whether
 * the roster, the cases route, the work list, the two CSV exports and the MCP tool each actually
 * resolve the parameter. A surface that silently ignored it would serve the whole practice under a
 * heading naming the ACO's population — the failure `subject-filters.ts` calls the invisible wrong
 * answer, and the one DATA_MODEL_CONTRACTS §4 records this project shipping across four readers once
 * already.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1, createFsBucket } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteSubjectListStore } from "../stores/sqlite/subject-list-store-sqlite.ts";
import { bucketPeriodForMeasure } from "../run/compliance-period.ts";
import { handleWorklist } from "../routes/worklist.ts";
import { handleCases } from "../routes/cases.ts";
import { handleExports } from "../routes/exports.ts";
import { handleCompliance } from "../routes/compliance.ts";
import { MCP_TOOLS_BY_NAME } from "../mcp/tools.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteMeasureStore } from "../stores/sqlite/measure-store-sqlite.ts";
import { SubjectListMemo, resolveListFilter, withListFilter } from "./subject-list-filter.ts";
import type { SubjectListStore } from "../stores/subject-list-store.ts";
import type { SubjectFilters } from "./subject-filters.ts";

const TODAY = new Date().toISOString().slice(0, 10);
const CYCLE = bucketPeriodForMeasure("audiogram", TODAY);
const dbPath = join(tmpdir(), `workwell-list-filter-${crypto.randomUUID()}.sqlite`);
const bucketDir = join(tmpdir(), `workwell-list-filter-bucket-${crypto.randomUUID()}`);

let env: Record<string, unknown>;
let lists: SqliteSubjectListStore;
let onlyOmar = "";
let matchedNobody = "";
let mcpDeps: Parameters<(typeof MCP_TOOLS_BY_NAME)["list_noncompliant"]["handler"]>[1];

const CM = "cm@workwell.dev";
const UNKNOWN = "9f1c2b3a-0000-4000-8000-0000000000ff";

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db, BUCKET: createFsBucket(bucketDir) };
  const cases = new SqliteCaseStore(db);
  const runs = new SqliteRunStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  lists = new SqliteSubjectListStore(db);

  const run = await runs.createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z",
    measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
  });
  // Two subjects with open work; the list will hold exactly one of them.
  await cases.upsertFromOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: CYCLE, outcomeStatus: "OVERDUE" });
  await cases.upsertFromOutcome({ runId: run.id, subjectId: "emp-007", measureId: "audiogram", evaluationPeriod: CYCLE, outcomeStatus: "OVERDUE" });
  await outcomes.recordOutcomes([
    { runId: run.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: CYCLE, status: "OVERDUE", evidence: {} },
    { runId: run.id, subjectId: "emp-007", measureId: "audiogram", evaluationPeriod: CYCLE, status: "OVERDUE", evidence: {} },
  ]);

  onlyOmar = (await lists.createList({
    id: crypto.randomUUID(),
    name: "only emp-006",
    source: null,
    note: null,
    createdBy: CM,
    now: new Date().toISOString(),
    members: [{ rawIdentifier: "emp-006", subjectId: "emp-006", resolution: "MATCHED" }],
  })).id;
  // A list whose identifiers ALL failed to resolve. It is a real list and an ACTIVE filter matching
  // nobody — the case a `.size > 0` guard would read as "no filter" and answer with everybody.
  matchedNobody = (await lists.createList({
    id: crypto.randomUUID(),
    name: "matched nobody",
    source: null,
    note: null,
    createdBy: CM,
    now: new Date().toISOString(),
    members: [{ rawIdentifier: "emp-99998", subjectId: null, resolution: "NOT_FOUND" }],
  })).id;

  mcpDeps = {
    caseStore: cases,
    outcomeStore: outcomes,
    runStore: runs,
    measureStore: new SqliteMeasureStore(db),
    subjectListStore: lists,
    webChartEnv: {},
  };
});

after(() => {
  try {
    rmSync(dbPath, { force: true });
    rmSync(bucketDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const worklist = (qs: string) => handleWorklist(new Request(`http://x/api/worklist/patients${qs}`), env as never, CM);
const casesRoute = (qs: string) => handleCases(new Request(`http://x/api/cases${qs}`), env as never, CM);
const casesCsv = (qs: string) => handleExports(new Request(`http://x/api/exports/cases?format=csv${qs}`), env as never);
const outcomesCsv = (qs: string) => handleExports(new Request(`http://x/api/exports/outcomes?format=csv${qs}`), env as never);
const roster = (qs: string) => handleCompliance(new Request(`http://x/api/compliance/roster${qs}`), env as never);
const mcp = (args: Record<string, unknown>) => MCP_TOOLS_BY_NAME.list_noncompliant!.handler(args, mcpDeps);

test("every HTTP surface 404s an unknown listId — none of them serves an unfiltered answer", async () => {
  // The check that actually catches a forgotten surface. A route that never resolved the parameter
  // would answer 200 here, with every patient in it, under a heading naming the ACO's list.
  for (const [label, res] of [
    ["worklist", (await worklist(`?listId=${UNKNOWN}`))!],
    ["cases", (await casesRoute(`?listId=${UNKNOWN}`))!],
    ["cases.csv", (await casesCsv(`&listId=${UNKNOWN}`))!],
    ["outcomes.csv", (await outcomesCsv(`&listId=${UNKNOWN}`))!],
    ["roster", (await roster(`?listId=${UNKNOWN}`))!],
  ] as const) {
    assert.equal(res.status, 404, `${label} must refuse an unknown list`);
    const body = (await res.json()) as { error: string; parameter: string };
    assert.equal(body.error, "not_found", label);
    assert.equal(body.parameter, "listId", label);
  }
  const tool = (await mcp({ listId: UNKNOWN })) as { error?: boolean; code?: string; results?: unknown[] };
  assert.equal(tool.code, "LIST_NOT_FOUND", "the MCP tool errors rather than listing everyone");
  assert.equal(tool.results, undefined, "and returns no rows at all");
});

test("a list narrows every surface to its MATCHED members", async () => {
  const wl = (await worklist(`?listId=${onlyOmar}`))!;
  const rows = (await wl.json()) as { employeeId: string }[];
  assert.deepEqual(rows.map((r) => r.employeeId), ["emp-006"]);

  const cs = (await casesRoute(`?listId=${onlyOmar}`))!;
  const caseRows = (await cs.json()) as { employeeId: string }[];
  assert.deepEqual([...new Set(caseRows.map((r) => r.employeeId))], ["emp-006"]);

  const csv = await (await casesCsv(`&listId=${onlyOmar}`))!.text();
  assert.match(csv, /emp-006/);
  assert.doesNotMatch(csv, /emp-007/, "the CSV is filtered, not just the screen");

  const ocsv = await (await outcomesCsv(`&listId=${onlyOmar}`))!.text();
  assert.match(ocsv, /emp-006/);
  assert.doesNotMatch(ocsv, /emp-007/);

  const tool = (await mcp({ listId: onlyOmar })) as { results: { employeeExternalId: string }[] };
  assert.deepEqual(tool.results.map((r) => r.employeeExternalId), ["emp-006"]);
});

test("a list that matched NOBODY filters to nobody — never to everybody", async () => {
  // The vacuous-guard case. `hasActiveSubjectFilters` tests `!= null`, not `.size > 0`: an empty
  // matched set is a legitimate answer (an attribution file for patients this practice has never
  // seen) and reading it as "no filter" would hand back the whole practice.
  const rows = (await (await worklist(`?listId=${matchedNobody}`))!.json()) as unknown[];
  assert.deepEqual(rows, []);
  const caseRows = (await (await casesRoute(`?listId=${matchedNobody}`))!.json()) as unknown[];
  assert.deepEqual(caseRows, []);
  const csv = await (await casesCsv(`&listId=${matchedNobody}`))!.text();
  assert.doesNotMatch(csv, /emp-006/);
  assert.doesNotMatch(csv, /emp-007/);
  const tool = (await mcp({ listId: matchedNobody })) as { results: unknown[] };
  assert.deepEqual(tool.results, []);
});

test("no listId leaves every surface exactly as it was", async () => {
  const rows = (await (await worklist(""))!.json()) as { employeeId: string }[];
  assert.deepEqual([...new Set(rows.map((r) => r.employeeId))].sort(), ["emp-006", "emp-007"]);
  const tool = (await mcp({})) as { results: { employeeExternalId: string }[] };
  assert.equal(tool.results.length, 2);
});

test("the memo serves the second read without touching the store, and evicts the oldest past capacity", async () => {
  // A 50,000-id Set rebuilt on every /worklist page load is the pool-pressure shape #560 removed from
  // the case export. Safe to cache only because a list is immutable — no UPDATE and no DELETE exists.
  let matchedReads = 0;
  const counting: SubjectListStore = {
    ...lists,
    getList: (id) => lists.getList(id),
    matchedSubjectIds: async (id) => {
      matchedReads += 1;
      return lists.matchedSubjectIds(id);
    },
  } as SubjectListStore;
  const memo = new SubjectListMemo();
  const first = await resolveListFilter(counting, onlyOmar, memo);
  const second = await resolveListFilter(counting, onlyOmar, memo);
  assert.equal(matchedReads, 1, "the second resolution is served from the memo");
  assert.equal(first.found && second.found, true);

  // Capacity is 8; a ninth distinct key evicts the least recently used one.
  for (let i = 0; i < 9; i += 1) memo.set(`key-${i}`, new Set([String(i)]));
  assert.equal(memo.size, 8);
  assert.equal(memo.get("key-0"), undefined, "the oldest entry was evicted");
  assert.notEqual(memo.get("key-8"), undefined);
});

test("withListFilter leaves filters untouched when no listId is present", async () => {
  const memo = new SubjectListMemo();
  const base: SubjectFilters = { providerId: "maui-prov-001" };
  const result = await withListFilter(lists, new URLSearchParams(""), base, memo);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.filters, base);
  assert.equal(memo.size, 0, "an absent parameter costs no store read");

  const withList = await withListFilter(lists, new URLSearchParams(`listId=${onlyOmar}`), base, memo);
  assert.equal(withList.ok && withList.filters.providerId, "maui-prov-001", "the other filters survive");
  assert.equal(withList.ok && withList.filters.listSubjectIds?.has("emp-006"), true);
});
