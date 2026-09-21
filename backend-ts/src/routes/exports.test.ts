/**
 * Exports route test (#108): seed a run + outcomes + case + audit, then assert the CSV
 * exports carry the right headers/rows and the format gate. node --import tsx --test src/routes/exports.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { handleExports } from "./exports.ts";

const dbPath = join(tmpdir(), `workwell-exports-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
let runId: string;
let latestRunId: string;
let caseId: string;

const get = (path: string) => handleExports(new Request(`http://x${path}`, { method: "GET" }), env as never);
const text = async (path: string) => (await get(path).then((r) => r!.text())).split("\r\n");

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  runId = run.id;
  const oc = new SqliteOutcomeStore(db);
  await oc.recordOutcome({
    runId,
    subjectId: "emp-006",
    measureId: "audiogram",
    evaluationPeriod: "2026-06-13",
    status: "OVERDUE",
    evidence: { expressionResults: [{ define: "Most Recent Audiogram Date", result: "2025-04-19" }, { define: "Days Since Last Audiogram", result: 420 }] },
  });
  const caseRec = await new SqliteCaseStore(db).upsertFromOutcome({ runId, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
  caseId = caseRec!.id;
  const events = new SqliteCaseEventStore(db);
  // A case-action audit WITHOUT subjectId in the payload — employeeId must come from the case.
  await events.appendAudit({
    eventType: "CASE_ESCALATED",
    entityType: "case",
    entityId: caseId,
    actor: "cm@workwell.dev",
    refRunId: runId,
    refCaseId: caseId,
    refMeasureVersionId: "audiogram-v1.0",
    payload: { priority: "HIGH", reason: "Manual escalation requested" },
  });

  // A later run (no outcomes) so the default outcomes export must resolve the LATEST run.
  await new Promise((r) => setTimeout(r, 8));
  const later = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "hazwoper",
    triggeredBy: "test",
    requestedScope: { measureId: "hazwoper" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  latestRunId = later.id;
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("GET /api/exports/runs?format=csv → run summary CSV", async () => {
  const res = await get("/api/exports/runs?format=csv");
  assert.equal(res?.status, 200);
  assert.equal(res!.headers.get("content-type"), "text/csv");
  assert.match(res!.headers.get("content-disposition") ?? "", /attachment; filename="runs\.csv"/);
  const lines = (await res!.text()).split("\r\n");
  // `notInPopulation` is APPENDED (ADR-079), so the documented prefix through `dataFreshAsOf` is
  // byte-identical and a consumer reading by position keeps every column it had.
  assert.match(lines[0]!, /^runId,measureName,measureVersion,.*passRate,dataFreshAsOf,notInPopulation$/);
  assert.ok(lines.some((l) => l.startsWith(runId)), "the run is a row");
  assert.ok(lines.some((l) => l.includes("Audiogram")));
});

test("GET /api/exports/outcomes?runId carries derived why_flagged columns", async () => {
  const lines = await text(`/api/exports/outcomes?format=csv&runId=${runId}`);
  // The WHOLE header, exactly, rather than a regex with `.*` in the middle: DATA_MODEL_CONTRACTS §6.2
  // is a positional contract, so a column INSERTED mid-row would have satisfied the old pattern while
  // silently shifting every consumer reading by index. `providerId,payer` are APPENDED (MM-2).
  assert.equal(
    lines[0],
    "outcomeId,runId,employeeExternalId,employeeName,role,site,measureName,measureVersion,evaluationPeriod," +
      "status,lastExamDate,complianceWindowDays,daysOverdue,roleEligible,siteEligible,waiverStatus,evaluatedAt," +
      "providerId,payer",
  );
  const row = lines.find((l) => l.includes("emp-006"))!;
  assert.ok(row, "the outcome row is present");
  // OVERDUE audiogram: lastExamDate 2025-04-19, window 365, daysOverdue 420-365=55, waiver none
  assert.ok(row.includes("2025-04-19"));
  assert.ok(row.includes("55"));
  assert.ok(row.includes("Omar Siddiq"));
});

test("GET /api/exports/cases carries the case + latestOutreachDeliveryStatus column", async () => {
  const lines = await text("/api/exports/cases?format=csv&status=open");
  // Exact, for the same reason as §6.2 above.
  assert.equal(
    lines[0],
    "caseId,employeeExternalId,employeeName,role,site,measureName,measureVersion,evaluationPeriod,status," +
      "priority,assignee,currentOutcomeStatus,nextAction,lastRunId,createdAt,updatedAt,closedAt," +
      "latestOutreachDeliveryStatus,providerId,payer," +
      // APPENDED (#569, ADR-083), never inserted — every column a consumer reads by position keeps
      // its index. The two `live*` cells are filled only for rows a PERSON closed, whose
      // `currentOutcomeStatus` froze at closure.
      "closedReason,closedBy,liveState,liveOutcomeStatus,liveOutcomeRunId",
  );
  assert.ok(lines.some((l) => l.includes("Omar Siddiq") && l.includes("OVERDUE")));
});

test("?status=open exports the ACTIVE set, so a case someone started is not missing from the CSV", async () => {
  // The export is reached from the work list's own button with the status that list is showing. While
  // this mapped "open" to ["OPEN"] and the list showed OPEN + IN_PROGRESS, scheduling an appointment
  // moved a case to IN_PROGRESS and it stayed on screen but vanished from the CSV taken off that
  // screen — and a row missing from an export is missing without anyone being told.
  const store = new SqliteCaseStore((env as { DB: never }).DB);
  const before = await text("/api/exports/cases?format=csv&status=open");
  assert.ok(before.some((l) => l.includes(caseId)), "the case is on the open export to begin with");

  await store.patchCase(caseId, { status: "IN_PROGRESS" });
  try {
    const after = await text("/api/exports/cases?format=csv&status=open");
    assert.ok(after.some((l) => l.includes(caseId)), "an IN_PROGRESS case dropped out of the open export");
    assert.ok(after.some((l) => l.includes(caseId) && l.includes("IN_PROGRESS")), "and it says so");
    // `closed` is unaffected — this widened "open", it did not blur the tabs.
    const closed = await text("/api/exports/cases?format=csv&status=closed");
    assert.ok(!closed.some((l) => l.includes(caseId)));
  } finally {
    await store.patchCase(caseId, { status: "OPEN" });
  }
});

test("GET /api/audit-events/export lists the ledger; employeeId derived from the referenced case", async () => {
  const lines = await text("/api/audit-events/export?format=csv");
  assert.equal(lines[0], "timestamp,eventType,caseId,runId,measureName,employeeId,actor,detail");
  const row = lines.find((l) => l.includes("CASE_ESCALATED"))!;
  assert.ok(row, "the escalation audit row is present");
  // The payload has no subjectId — employeeId column must come from the case's employee (emp-006).
  const cols = row.split(",");
  assert.equal(cols[5], "emp-006", "employeeId resolved via ref_case_id → case.employee_id");
  assert.equal(cols[6], "cm@workwell.dev", "actor");
});

test("default outcomes export (no runId) resolves the LATEST run", async () => {
  // The latest run (hazwoper) has no outcomes → just the header row (not the older audiogram run's rows).
  const lines = (await text("/api/exports/outcomes?format=csv")).filter((l) => l.length > 0);
  assert.equal(lines.length, 1, "only the header — the latest run has no outcomes");
  assert.ok(!lines.some((l) => l.includes("emp-006")), "older run's outcomes are NOT mixed in");
  // explicit older runId still works
  assert.ok((await text(`/api/exports/outcomes?format=csv&runId=${runId}`)).some((l) => l.includes("emp-006")));
});

test("cases export honors caseIds (selected set) and the site filter", async () => {
  // caseIds → exactly the selected case(s); a non-matching id → header only.
  const sel = (await text(`/api/exports/cases?format=csv&caseIds=${caseId}`)).filter((l) => l.length > 0);
  assert.equal(sel.length, 2, "header + the one selected case");
  assert.ok(sel.some((l) => l.startsWith(caseId)));
  const none = (await text(`/api/exports/cases?format=csv&caseIds=${crypto.randomUUID()}`)).filter((l) => l.length > 0);
  assert.equal(none.length, 1, "no case matched → header only");
  // site filter: Plant A keeps emp-006; HQ drops it
  assert.ok((await text("/api/exports/cases?format=csv&site=Plant%20A")).some((l) => l.includes("Omar Siddiq")));
  assert.ok(!(await text("/api/exports/cases?format=csv&site=HQ")).some((l) => l.includes("Omar Siddiq")));
});

test("non-csv format → 400 with the Java parity message", async () => {
  const res = await get("/api/exports/runs?format=json");
  assert.equal(res?.status, 400);
  assert.match(await res!.text(), /Unsupported format\. Use format=csv\./);
});

/**
 * The export is reached from the work list's own button, so it must understand every filter that
 * list is showing. Until 2026-09-20 it understood three of the nine — a CSV taken from a list
 * narrowed by a date window, an outcome or a search was a WIDER file than the screen it came from,
 * under a heading that said otherwise, and nothing failed.
 *
 * Each case below asserts BOTH directions: the matching value keeps the row and a non-matching one
 * drops it. A one-directional assertion passes just as well against a filter that is ignored.
 */
const rows = async (query: string) => (await text(`/api/exports/cases?format=csv&${query}`)).filter((l) => l.length > 0);
const hasCase = async (query: string) => (await rows(query)).some((l) => l.startsWith(caseId));

test("cases export honors ?outcome, normalized exactly as /api/cases normalizes it", async () => {
  assert.ok(await hasCase("outcome=OVERDUE"), "the case's current outcome is OVERDUE");
  // `?outcome=over-due` is not a thing, but `due-soon` is how the UI spells DUE_SOON — the export
  // must fold the separator the same way the list route does, or the two disagree on one screen.
  assert.ok(await hasCase("outcome=overdue"), "case-insensitive");
  assert.ok(!(await hasCase("outcome=due-soon")), "a different outcome drops the row");
  assert.equal((await rows("outcome=due-soon")).length, 1, "header only");
});

test("cases export honors ?search over subject name, measure name and subject id", async () => {
  for (const needle of ["Omar", "omar siddiq", "Audiogram", "emp-006"]) {
    assert.ok(await hasCase(`search=${encodeURIComponent(needle)}`), `search=${needle} should match`);
  }
  assert.ok(!(await hasCase("search=nobody-by-this-name")), "a non-matching needle drops the row");
});

test("cases export honors the ?from/?to created-at window, inclusive at both ends", async () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(await hasCase(`from=${today}&to=${today}`), "a one-day window containing today is inclusive");
  assert.ok(!(await hasCase("from=2020-01-01&to=2020-01-02")), "a window before the case drops it");
  assert.ok(!(await hasCase("from=2099-01-01")), "a window after the case drops it");
});

test("a malformed ?from is a 400 naming the parameter, not a lexicographic filter on garbage", async () => {
  for (const [param, value] of [["from", "2026-02-30"], ["to", "not-a-date"], ["from", "2026-99-99"]] as const) {
    const res = await get(`/api/exports/cases?format=csv&${param}=${encodeURIComponent(value)}`);
    assert.equal(res?.status, 400, `${param}=${value} should be refused`);
    const body = JSON.parse(await res!.text()) as { parameter: string; message: string };
    assert.equal(body.parameter, param);
    assert.match(body.message, /YYYY-MM-DD/);
  }
});

/**
 * The run-history CSV carries the filters the screen is showing (#601).
 *
 * It took none, and `/api/exports/runs` accepted none — so narrowing the history to FAILED runs at
 * one site last week and pressing Export downloaded the most recent 200 runs of everything. Same
 * defect as the cases CSV one screen over, and the same shape of fix: one shared predicate
 * (`matchesRunFilters`), and the page builds one parameter set for the list and the export.
 *
 * Both directions again: a matching value keeps the row, a non-matching one drops it. The fixture
 * has runs of two scope types, so the assertions cannot pass against an ignored filter.
 */
const runLines = async (query: string) => (await text(`/api/exports/runs?format=csv&${query}`)).filter((l) => l.length > 0);

test("runs export honors ?scopeType, and drops what does not match", async () => {
  const all = await runLines("");
  assert.ok(all.length >= 3, "the fixture has at least two runs plus a header");
  assert.ok(all.some((l) => l.includes(runId)), "the audiogram MEASURE run is there");
  assert.ok(all.some((l) => l.includes(latestRunId)), "and the hazwoper one");

  // Both fixture runs are MEASURE-scoped, so a different scope must empty the file.
  const none = await runLines("scopeType=ALL_PROGRAMS");
  assert.equal(none.length, 1, "header only — no ALL_PROGRAMS run exists");
  const measured = await runLines("scopeType=MEASURE");
  assert.ok(measured.some((l) => l.includes(runId)));
});

test("runs export honors ?status and ?triggerType", async () => {
  // The fixture's runs are REQUESTED/QUEUED rather than COMPLETED, so this asserts the filter runs
  // at all rather than asserting a particular lifecycle.
  const completed = await runLines("status=COMPLETED");
  assert.ok(!completed.some((l) => l.includes(runId)), "a status no fixture run has drops every row");
  const nonsense = await runLines("triggerType=NOT_A_TRIGGER");
  assert.equal(nonsense.length, 1, "header only");
});

test("runs export honors the ?from/?to window and refuses a malformed one", async () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.ok((await runLines(`from=${today}`)).some((l) => l.includes(runId)), "a run started today is in a window starting today");
  assert.ok(!(await runLines("from=2099-01-01")).some((l) => l.includes(runId)), "and not in one starting in 2099");
  assert.ok(!(await runLines("to=2020-01-01")).some((l) => l.includes(runId)));

  const res = await get("/api/exports/runs?format=csv&from=2026-02-30");
  assert.equal(res?.status, 400, "a malformed day is refused, not filtered lexicographically");
  const body = JSON.parse(await res!.text()) as { parameter: string };
  assert.equal(body.parameter, "from");
});

test("the runs export cap applies AFTER filtering, not to the read", async () => {
  // The distinction the first version of this test could not see: with `limit` on the READ, the
  // export fetches the newest N rows and then has only those to filter — so a matching run outside
  // the newest N is unreachable under ANY filter, which is how a deployment with more than 200 runs
  // could not export an older one at all. Making the OLDER fixture run the only FAILED one, and
  // asking for one row, separates the two orderings: correct returns it, capped-read returns nothing.
  const runStore = new SqliteRunStore((env as { DB: never }).DB);
  await runStore.finalizeRun(runId, "FAILED");
  try {
    const one = await runLines("limit=1&status=FAILED");
    assert.ok(
      one.some((l) => l.includes(runId)),
      "a matching run that is not among the newest `limit` rows must still be exported",
    );
    assert.equal(one.length, 2, "header + exactly the one matching run");
  } finally {
    await runStore.finalizeRun(runId, "COMPLETED");
  }
  const raised = await runLines("limit=5000");
  assert.ok(raised.length >= 3, "a larger cap is honoured");
});
