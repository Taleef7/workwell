/**
 * The work list and the cases CSV answer the same question about the CYCLE (#603).
 *
 * #602 made the export take every filter the list sends, and a frontend test compares the two query
 * strings so they cannot drift. One width difference was left, and it is the one that test cannot see:
 * the period scope was a SERVER-SIDE default, present in neither query string. `?status=open` showed
 * "0 cases loaded" on screen while the Export button under it downloaded a file with a prior-cycle row
 * in it; the staff-closed tab exported every past year's closures beside three header counts
 * describing one cycle.
 *
 * So this compares RESULT SETS over one fixture rather than parameters — the way ADR-084 pins its two
 * work-list loaders against each other. Both defaults are asserted, because they legitimately differ:
 * the list's blank means `current`, the export's means all history (§6.3, and something downstream may
 * depend on it).
 *
 * node --import tsx --test src/export/cases-csv-period-parity.test.ts
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
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { bucketPeriodForMeasure } from "../run/compliance-period.ts";
import { loadWorklistCases, wantsCurrentCycle, siteMatches, type WorklistDeps } from "../case/worklist-read-model.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { casesCsv } from "./export-csv.ts";

const TODAY = new Date().toISOString().slice(0, 10);
const CYCLE = bucketPeriodForMeasure("audiogram", TODAY);
/** A period that is NOT the current cycle whatever today is — the row the screen hides. */
const PRIOR = "2019-01-01";

const dbPath = join(tmpdir(), `workwell-periodparity-${crypto.randomUUID()}.sqlite`);
let cases: SqliteCaseStore;
let events: SqliteCaseEventStore;

/**
 * Subject ids from the REAL static directory, and their real sites.
 *
 * The work list takes its roster injected; `casesCsv` does not — it resolves the directory itself
 * (`directoryForProfileRows`). So a synthetic subject id makes the export's `site` filter match
 * nobody for a reason that has nothing to do with the comparison under test, which is how the first
 * cut of this file passed three assertions and failed the one that mattered.
 */
const ROSTER: EmployeeProfile[] = [
  { externalId: "emp-006", name: "Ann Akana", role: "Welder", site: "Plant A", providerId: "prov-a", tenantId: "twh", payer: "1" },
  { externalId: "emp-007", name: "Ben Bright", role: "Welder", site: "Plant A", providerId: "prov-a", tenantId: "twh", payer: "1" },
];
const NOW = "emp-006";
const THEN = "emp-007";
const SITE = "Plant A";
const lookup = (id: string): EmployeeProfile | null => ROSTER.find((e) => e.externalId === id) ?? null;
const deps = (): WorklistDeps =>
  ({ cases, events, employeeLookup: lookup, roster: () => ROSTER, today: () => TODAY }) as unknown as WorklistDeps;

/** The CSV's subject-id column, which is the only identity the two surfaces share. */
const csvSubjects = (csv: string): string[] =>
  csv
    .split("\n")
    .slice(1)
    .filter((line) => line.trim() !== "")
    .map((line) => line.split(",")[1]!.replace(/"/g, ""))
    .sort();

const exportSubjects = async (over: Parameters<typeof casesCsv>[2]): Promise<string[]> =>
  csvSubjects(await casesCsv(cases, events, over));

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  cases = new SqliteCaseStore(db);
  events = new SqliteCaseEventStore(db);
  const runId = (await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z", measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
  })).id;
  // Two OPEN cases for one measure: one in the current cycle, one in a cycle long past. That second
  // row is the whole fixture — it is what the screen hides and the file used to carry.
  await cases.upsertFromOutcome({ runId, subjectId: NOW, measureId: "audiogram", evaluationPeriod: CYCLE, outcomeStatus: "OVERDUE" });
  await cases.upsertFromOutcome({ runId, subjectId: THEN, measureId: "audiogram", evaluationPeriod: PRIOR, outcomeStatus: "OVERDUE" });
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("the open list shows ONE row and the export's default still carries both", async () => {
  const listed = (await loadWorklistCases(deps(), { status: "open" })).map((c) => c.employeeId);
  assert.deepEqual(listed, [NOW], "the list is scoped to the current cycle by default (#569)");

  // The endpoint's documented default is all history (§6.3), unchanged — byte for byte, this is what
  // it returned before #603. Asserted, not assumed: a consumer may depend on it.
  assert.deepEqual(
    await exportSubjects({ statuses: ["OPEN", "IN_PROGRESS"] }),
    [NOW, THEN].sort(),
    "the export with no period scope is all history",
  );
});

test("?period=current makes the export the same set as the list", async () => {
  const listed = (await loadWorklistCases(deps(), { status: "open", period: "current" })).map((c) => c.employeeId).sort();
  const exported = await exportSubjects({ statuses: ["OPEN", "IN_PROGRESS"], currentCycleOnly: true });
  assert.deepEqual(exported, listed);
  assert.deepEqual(exported, [NOW], "and not vacuously — the prior-cycle row is the one dropped");
});

test("the rule that decides it is ONE function, and the two surfaces differ only in what BLANK means", async () => {
  // A blank token is what a cleared control sends, and it is the case the old code got wrong on one
  // surface and had no opinion about on the other.
  for (const status of ["open", "staff_closed", ""]) {
    assert.equal(wantsCurrentCycle(status, undefined, "current"), true, `${status || "(blank)"} list default`);
    assert.equal(wantsCurrentCycle(status, "", "current"), true, `${status || "(blank)"} blank period`);
    assert.equal(wantsCurrentCycle(status, undefined, "all"), false, `${status || "(blank)"} export default`);
    assert.equal(wantsCurrentCycle(status, "current", "all"), true, `${status || "(blank)"} export asked`);
  }
  // A tab with no cycle scope never has one, whatever is asked for — on either surface. `?period=` on
  // such a tab reaches the store as a literal period, so answering true here would silently filter on
  // the word "current".
  for (const status of ["closed", "excluded", "all"]) {
    assert.equal(wantsCurrentCycle(status, "current", "current"), false, `${status} has no cycle scope`);
    assert.equal(wantsCurrentCycle(status, undefined, "current"), false, `${status} default`);
  }
});

test("site is compared the same way on both surfaces, and it is EXACT", async () => {
  const listed = (await loadWorklistCases(deps(), { status: "open", site: SITE })).map((c) => c.employeeId);
  assert.deepEqual(listed, [NOW]);
  assert.deepEqual(await exportSubjects({ statuses: ["OPEN", "IN_PROGRESS"], currentCycleOnly: true, site: SITE }), [NOW]);

  // The export lower-cased both sides and the list did not, so this case answered differently on the
  // two surfaces. Exact is the side standardised on: the control's options come from the directory's
  // own strings, and folding case would merge two real sites into a file headed with one of them.
  assert.deepEqual(await exportSubjects({ statuses: ["OPEN", "IN_PROGRESS"], site: SITE.toLowerCase() }), [], "no match, on both");
  assert.deepEqual((await loadWorklistCases(deps(), { status: "open", site: SITE.toLowerCase() })).map((c) => c.employeeId), []);
  assert.equal(siteMatches(SITE, SITE), true);
  assert.equal(siteMatches(SITE, SITE.toLowerCase()), false);
  assert.equal(siteMatches(null, SITE), false, "a roster that records no site matches nobody, not everybody");
});
