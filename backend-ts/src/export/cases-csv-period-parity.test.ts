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
import { handleCases } from "../routes/cases.ts";
import { handleExports } from "../routes/exports.ts";

const TODAY = new Date().toISOString().slice(0, 10);

/**
 * `diabetes_hba1c`, not `audiogram` — and the choice is what makes the test able to fail.
 *
 * `bucketPeriodForMeasure`'s unknown-measure fallback is 365 days → ANNUAL, and `audiogram`'s binding
 * is ALSO 365 days, so with that measure the correct anchor and the fallback's anchor are the same
 * string: passing a wrong identifier — `c.id`, a stale `measureVersionId`, the literal "nonsense" —
 * left every assertion green. `diabetes_hba1c` is 180 days → BIANNUAL, so its anchor differs from the
 * fallback's for most of the year, and the measure half of the parity is actually pinned (review of
 * #611).
 */
const MEASURE = "diabetes_hba1c";
const CYCLE = bucketPeriodForMeasure(MEASURE, TODAY);
/** What a WRONG identifier would bucket to. Asserted different, or this file proves less than it says. */
const FALLBACK_CYCLE = bucketPeriodForMeasure("no-such-measure", TODAY);
/** A period that is NOT the current cycle whatever today is — the row the screen hides. */
const PRIOR = "2019-01-01";

const dbPath = join(tmpdir(), `workwell-periodparity-${crypto.randomUUID()}.sqlite`);
let cases: SqliteCaseStore;
let events: SqliteCaseEventStore;
/** Kept so the route tests can build an env over the SAME fixture the direct calls use. */
let db: unknown;

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
  { externalId: "emp-008", name: "Cara Chun", role: "Welder", site: "Plant A", providerId: "prov-a", tenantId: "twh", payer: "1" },
  { externalId: "emp-009", name: "Dan Diaz", role: "Welder", site: "Plant A", providerId: "prov-a", tenantId: "twh", payer: "1" },
];
const NOW = "emp-006";
const THEN = "emp-007";
const CLOSED_NOW = "emp-008";
const CLOSED_THEN = "emp-009";
const SITE = "Plant A";
/** A subject the REAL static directory does not hold — so both surfaces must call its site "—". */
const STRANGER = "cypress-mrn-unknown-9999";
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
  db = await createSqliteD1(dbPath);
  await (db as { exec: (s: string) => Promise<unknown> }).exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  cases = new SqliteCaseStore(db as never);
  events = new SqliteCaseEventStore(db as never);
  const runId = (await new SqliteRunStore(db as never).createRun({
    scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test",
    requestedScope: { measureId: MEASURE },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z", measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
  })).id;
  // Two OPEN cases for one measure: one in the current cycle, one in a cycle long past. That second
  // row is the whole fixture — it is what the screen hides and the file used to carry.
  await cases.upsertFromOutcome({ runId, subjectId: NOW, measureId: MEASURE, evaluationPeriod: CYCLE, outcomeStatus: "OVERDUE" });
  await cases.upsertFromOutcome({ runId, subjectId: THEN, measureId: MEASURE, evaluationPeriod: PRIOR, outcomeStatus: "OVERDUE" });
  // A staff closure in the current cycle and one in a prior year — the half §6.3 promises is fixed,
  // and the path where the cycle filter decides which rows get a live answer at all.
  for (const [subject, period] of [[CLOSED_NOW, CYCLE], [CLOSED_THEN, PRIOR]] as const) {
    await cases.upsertFromOutcome({ runId, subjectId: subject, measureId: MEASURE, evaluationPeriod: period, outcomeStatus: "OVERDUE" });
    const row = (await cases.listCases({ employeeIds: [subject], limit: 1 }))[0]!;
    await cases.patchCase(row.id, { status: "CLOSED", closedAt: "2026-06-14T00:00:00Z", closedReason: "MANUAL_RESOLVE", closedBy: "nurse@example.org" });
  }
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
  // A tab with no cycle scope has none BY DEFAULT — but an explicit `current` is honoured on every
  // status (Codex on #611). Gating both made the export answer two different things to two spellings
  // of one question: on this endpoint a blank status and `all` are the SAME query, so
  // `?period=current` narrowed while `?period=current&status=all` returned all history.
  for (const status of ["closed", "excluded", "all"]) {
    assert.equal(wantsCurrentCycle(status, undefined, "current"), false, `${status} default`);
    assert.equal(wantsCurrentCycle(status, "", "current"), false, `${status} blank period`);
    assert.equal(wantsCurrentCycle(status, "current", "all"), true, `${status} asked explicitly`);
  }
  // The two spellings of "every status" must agree, which is the defect itself.
  assert.equal(
    wantsCurrentCycle("all", "current", "all"),
    wantsCurrentCycle("", "current", "all"),
    "`status=all` and a blank status are one query on the export, so they cannot scope differently",
  );
  // And a LITERAL period is never the cycle rule, on any status.
  for (const status of ["open", "closed", "", "all"]) {
    assert.equal(wantsCurrentCycle(status, "2026-01-01", "current"), false, `${status} + a literal period`);
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


test("the fixture can tell the RIGHT measure identifier from a wrong one", async () => {
  // Not a behaviour assertion — a guard on this file. `bucketPeriodForMeasure` falls back to 365 days
  // for an unknown measure, so a fixture whose measure is also 365 days cannot fail when the wrong
  // identifier is passed. If these two ever coincide (a cadence change, a different TODAY), the three
  // cycle assertions above go quiet and this one says so.
  assert.notEqual(CYCLE, FALLBACK_CYCLE, `${MEASURE} must not bucket to the unknown-measure fallback`);
});

test("the ROUTE wires it: ?period=current on /api/exports/cases narrows the file (#603)", async () => {
  // The gap the direct-call tests above cannot see. They pass `currentCycleOnly` by hand and the
  // frontend test only inspects a query string, so deleting the parameter from `routes/exports.ts`
  // left every test green — the string the screen sends and the filter the file applies were never
  // connected (review of #611). This drives the real handlers over the real fixture.
  const env = { DB: db } as never;
  const casesRoute = (qs: string) => handleCases(new Request(`http://x/api/cases${qs}`), env, "admin@example.org");
  const exportRoute = (qs: string) => handleExports(new Request(`http://x/api/exports/cases?format=csv${qs}`), env);

  const listed = await casesRoute("?status=open");
  assert.equal(listed?.status, 200);
  const listedRows = (await listed!.json()) as Array<{ employeeId: string }>;
  assert.deepEqual(listedRows.map((r) => r.employeeId), [NOW], "the list defaults to the current cycle");

  const wide = await exportRoute("&status=open");
  assert.equal(wide?.status, 200);
  assert.deepEqual(csvSubjects(await wide!.text()), [NOW, THEN].sort(), "the endpoint's default is all history");

  const narrow = await exportRoute("&status=open&period=current");
  assert.equal(narrow?.status, 200);
  assert.deepEqual(csvSubjects(await narrow!.text()), [NOW], "and ?period=current matches the list");

  // A LITERAL period still reaches the store as one, so the token is not swallowed wholesale.
  const literal = await exportRoute(`&status=open&period=${PRIOR}`);
  assert.deepEqual(csvSubjects(await literal!.text()), [THEN]);
});

test("the ROUTE narrows the staff-closed export too — the half that accumulates across years", async () => {
  // §6.3 promises this one specifically: the tab shows one cycle and its three header counts describe
  // that cycle, while the CSV carried every prior year's closures beside them. Nothing exercised it.
  const env = { DB: db } as never;
  const exportRoute = (qs: string) => handleExports(new Request(`http://x/api/exports/cases?format=csv${qs}`), env);

  assert.deepEqual(
    csvSubjects(await (await exportRoute("&status=staff_closed"))!.text()),
    [CLOSED_NOW, CLOSED_THEN].sort(),
    "all history by default, as documented",
  );
  assert.deepEqual(
    csvSubjects(await (await exportRoute("&status=staff_closed&period=current"))!.text()),
    [CLOSED_NOW],
    "and the prior year's closure is dropped when the screen's scope is sent",
  );
});

// LAST in the file on purpose: it INSERTS a row, and the assertions above are whole-set
// comparisons over this one fixture. Placed earlier, it broke the route test by being correct.
test("a subject the directory does not hold is filterable as '—' on BOTH surfaces", async () => {
  // The residual hole the shared predicate did NOT close (review of #611): the list compares
  // `CaseSummary.site`, which is `emp?.site ?? "—"`, while the export compared the raw directory value
  // — `""`. And `—` is a SELECTABLE option, because the control's options are the loaded rows' own
  // site strings. So an operator picking Site = — saw rows on screen and took away a header-only file.
  const runId = (await new SqliteRunStore(db as never).createRun({
    scopeType: "MEASURE", scopeId: MEASURE, triggeredBy: "test",
    requestedScope: { measureId: MEASURE },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z", measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
  })).id;
  await cases.upsertFromOutcome({ runId, subjectId: STRANGER, measureId: MEASURE, evaluationPeriod: CYCLE, outcomeStatus: "OVERDUE" });

  const listed = (await loadWorklistCases(deps(), { status: "open", site: "—" })).map((c) => c.employeeId);
  assert.deepEqual(listed, [STRANGER], "the screen shows it under —");
  assert.deepEqual(
    await exportSubjects({ statuses: ["OPEN", "IN_PROGRESS"], currentCycleOnly: true, site: "—" }),
    [STRANGER],
    "and so does the file taken off that screen",
  );
});
