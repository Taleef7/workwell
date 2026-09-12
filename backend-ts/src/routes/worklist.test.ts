/**
 * The patient work list and bulk assign (MM-2).
 *
 * The assertions that matter are about COUNTS DESCRIBING THE LIST BESIDE THEM: the total is patients
 * not gaps, an assignee filter returns a patient's OTHER gaps too (marked), and a bulk call reports
 * exactly what moved rather than what was asked for.
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
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { handleWorklist, BULK_ASSIGN_MAX } from "./worklist.ts";
import { SqlitePanelStore } from "../stores/sqlite/panel-store-sqlite.ts";
import type { CloudDatabase } from "@mieweb/cloud";
import { bucketPeriodForMeasure } from "../run/compliance-period.ts";
import type { WorklistPatientRow } from "../case/worklist-patients.ts";

const TODAY = new Date().toISOString().slice(0, 10);
const CYCLE = bucketPeriodForMeasure("audiogram", TODAY);
const HAZ_CYCLE = bucketPeriodForMeasure("hazwoper", TODAY);

const dbPath = join(tmpdir(), `workwell-worklist-route-${crypto.randomUUID()}.sqlite`);
const bucketDir = join(tmpdir(), `workwell-worklist-bucket-${crypto.randomUUID()}`);
let env: { DB: unknown; BUCKET: unknown };
let cases: SqliteCaseStore;
let events: SqliteCaseEventStore;
let runId: string;
let omarAudiogram: string;
let omarHazwoper: string;

const CM = "cm@workwell.dev";
const get = (qs = "", actor = CM) =>
  handleWorklist(new Request(`http://x/api/worklist/patients${qs}`), env as never, actor);
const bulk = (body: unknown, actor = CM) =>
  handleWorklist(
    new Request("http://x/api/cases/bulk-assign", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }),
    env as never,
    actor,
  );

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db, BUCKET: createFsBucket(bucketDir) };
  cases = new SqliteCaseStore(db);
  events = new SqliteCaseEventStore(db);
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z", measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
  });
  runId = run.id;
  // emp-006 (Omar Siddiq) has TWO gaps — the patient this list exists for. emp-001 has one.
  omarAudiogram = (await cases.upsertFromOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: CYCLE, outcomeStatus: "OVERDUE" }))!.id;
  omarHazwoper = (await cases.upsertFromOutcome({ runId: run.id, subjectId: "emp-006", measureId: "hazwoper", evaluationPeriod: HAZ_CYCLE, outcomeStatus: "DUE_SOON" }))!.id;
  await cases.upsertFromOutcome({ runId: run.id, subjectId: "emp-001", measureId: "hazwoper", evaluationPeriod: HAZ_CYCLE, outcomeStatus: "MISSING_DATA" });
});

after(() => {
  try { rmSync(dbPath, { force: true }); rmSync(bucketDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const rowsOf = async (res: Response) => (await res.json()) as WorklistPatientRow[];

test("one row per PATIENT, every open gap on it, and X-Total-Count counts patients not gaps", async () => {
  const res = (await get())!;
  assert.equal(res.status, 200);
  const rows = await rowsOf(res);
  const omar = rows.find((r) => r.employeeId === "emp-006")!;
  assert.ok(omar, "the two-gap patient is present");
  assert.equal(omar.gapCount, 2);
  assert.deepEqual(omar.openGaps.map((g) => g.measureId).sort(), ["audiogram", "hazwoper"]);
  // Three CASES exist but only two PATIENTS. A client paging on a gap count would page past the end.
  assert.equal(res.headers.get("X-Total-Count"), String(rows.length));
  assert.equal(rows.length, 2);
  // HIGH before MEDIUM: Omar's OVERDUE outranks emp-001's MISSING_DATA.
  assert.equal(rows[0]!.employeeId, "emp-006");
  assert.equal(rows[0]!.highestPriority, "HIGH");
  // The gaps within a row are ordered too, worst first.
  assert.equal(omar.openGaps[0]!.outcomeStatus, "OVERDUE");
});

test("owner is the single assignee, null when unassigned, and 'mixed' when the gaps disagree", async () => {
  assert.equal((await rowsOf((await get())!)).find((r) => r.employeeId === "emp-006")!.owner, null);

  await bulk({ assignee: CM, caseIds: [omarAudiogram] });
  const partly = (await rowsOf((await get())!)).find((r) => r.employeeId === "emp-006")!;
  // One of two gaps assigned ⇒ the patient has no single owner. Showing CM here would tell a caller
  // someone is handling the rest when nobody is.
  assert.equal(partly.owner, "mixed");
  assert.deepEqual(partly.assignees, [CM]);

  await bulk({ assignee: CM, caseIds: [omarHazwoper] });
  const fully = (await rowsOf((await get())!)).find((r) => r.employeeId === "emp-006")!;
  assert.equal(fully.owner, CM);

  await bulk({ assignee: null, caseIds: [omarAudiogram, omarHazwoper] });
  assert.equal((await rowsOf((await get())!)).find((r) => r.employeeId === "emp-006")!.owner, null);
});

test("?assignee=X keeps the patient and returns ALL their gaps, marking the ones that are not X's", async () => {
  await bulk({ assignee: CM, caseIds: [omarAudiogram] });
  try {
    const rows = await rowsOf((await get("?assignee=" + encodeURIComponent(CM)))!);
    assert.deepEqual(rows.map((r) => r.employeeId), ["emp-006"], "only the patient with a matching gap");
    const omar = rows[0]!;
    // BOTH gaps come back: the point of a patient list is that one phone call closes what one call can.
    assert.equal(omar.gapCount, 2);
    assert.equal(omar.openGaps.find((g) => g.caseId === omarAudiogram)!.otherAssignee, undefined);
    assert.equal(omar.openGaps.find((g) => g.caseId === omarHazwoper)!.otherAssignee, true, "the unmatched gap is marked");

    // `me` resolves against the CALLER, so the same URL means different lists for different people.
    assert.deepEqual((await rowsOf((await get("?assignee=me", CM))!)).map((r) => r.employeeId), ["emp-006"]);
    assert.deepEqual(await rowsOf((await get("?assignee=me", "someone.else@workwell.dev"))!), []);
    // `unassigned` is ≥1 UNASSIGNED gap, so a patient with one assigned gap and one without matches
    // it as well as `?assignee=CM` does. Both are true statements about them, and both lists have
    // work on them — which is why the gap-level `otherAssignee` marking exists.
    const unassigned = await rowsOf((await get("?assignee=unassigned"))!);
    assert.deepEqual(unassigned.map((r) => r.employeeId).sort(), ["emp-001", "emp-006"]);
    assert.equal(unassigned.find((r) => r.employeeId === "emp-006")!.openGaps.find((g) => g.caseId === omarAudiogram)!.otherAssignee, true);
  } finally {
    await bulk({ assignee: null, caseIds: [omarAudiogram] });
  }
});

test("an unauthenticated-looking caller asking for 'me' gets an EMPTY list, never everyone's", async () => {
  // `me` with no signed-in email must resolve to "nobody" rather than to "no filter". The opposite is
  // the whole practice's work list served to a caller who asked only for their own.
  assert.deepEqual(await rowsOf((await get("?assignee=me", ""))!), []);
});

test("the panel filters apply, and a bad token is a 400 that names the accepted values", async () => {
  const bad = (await get("?ageBand=old"))!;
  assert.equal(bad.status, 400);
  const body = (await bad.json()) as { error: string; parameter: string; message: string };
  assert.equal(body.error, "invalid_request");
  assert.equal(body.parameter, "ageBand");
  assert.match(body.message, /0-17, 18-44, 45-64, 65\+/);
  // Payer terminology is open, so an unknown code is accepted and simply matches nobody.
  assert.deepEqual(await rowsOf((await get("?payer=9999"))!), []);
});

test("the route declines anything that is not one of its two paths", async () => {
  assert.equal(await handleWorklist(new Request("http://x/api/worklist/patients", { method: "DELETE" }), env as never), null);
  assert.equal(await handleWorklist(new Request("http://x/api/cases"), env as never), null);
  assert.equal(await handleWorklist(new Request("http://x/api/cases/bulk-assign"), env as never), null, "GET on the bulk path is not ours");
});

test("bulk assign reports exactly what MOVED, and writes one audit event per moved case", async () => {
  const before = (await events.caseTimeline(omarAudiogram)).filter((e) => e.eventType === "CASE_ASSIGNED").length;
  const res = (await bulk({ assignee: CM, caseIds: [omarAudiogram, omarHazwoper] }))!;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { assigned: 2, unchanged: 0, conflicted: 0, missing: [], closed: [] });
  assert.equal((await cases.getCase(omarAudiogram))?.assignee, CM);
  assert.equal((await events.caseTimeline(omarAudiogram)).filter((e) => e.eventType === "CASE_ASSIGNED").length, before + 1);

  // Re-assigning to the SAME person moves nothing and writes NOTHING. A ledger full of no-ops makes
  // the entries that matter harder to find, and the count would claim work that did not happen.
  const again = (await bulk({ assignee: CM, caseIds: [omarAudiogram, omarHazwoper] }))!;
  assert.deepEqual(await again.json(), { assigned: 0, unchanged: 2, conflicted: 0, missing: [], closed: [] });
  assert.equal((await events.caseTimeline(omarAudiogram)).filter((e) => e.eventType === "CASE_ASSIGNED").length, before + 1);

  await bulk({ assignee: null, caseIds: [omarAudiogram, omarHazwoper] });
  assert.equal((await cases.getCase(omarAudiogram))?.assignee, null);
});

/** ASSIGNED rows in `case_actions` for a case. No store reader exposes them, so this asks the table. */
async function assignedActions(caseId: string): Promise<{ performed_by: string; payload_json: string }[]> {
  const db = (env as { DB: { prepare: (sql: string) => { bind: (...a: unknown[]) => { all: <T>() => Promise<{ results?: T[] }> } } } }).DB;
  const { results } = await db
    .prepare("SELECT performed_by, payload_json FROM case_actions WHERE case_id = ? AND action_type = 'ASSIGNED' ORDER BY id")
    .bind(caseId)
    .all<{ performed_by: string; payload_json: string }>();
  return results ?? [];
}

test("a bulk assignment leaves the SAME rows a one-at-a-time assignment does", async () => {
  // The divergence this closes: bulk wrote only `audit_events`, so the same user action left a
  // different ledger depending on how many rows the operator ticked — and `case_actions` is canonical
  // operational state (DATA_MODEL_CONTRACTS §6), not a duplicate of the audit table.
  const before = (await assignedActions(omarAudiogram)).length;
  const auditsBefore = (await events.caseTimeline(omarAudiogram)).filter((e) => e.eventType === "CASE_ASSIGNED").length;

  await bulk({ assignee: CM, caseIds: [omarAudiogram] });

  const actions = await assignedActions(omarAudiogram);
  assert.equal(actions.length, before + 1, "the bulk path writes a case_action, not only an audit event");
  assert.equal(actions.at(-1)!.performed_by, CM);
  const payload = JSON.parse(actions.at(-1)!.payload_json) as Record<string, unknown>;
  // The same payload shape the single-case path writes, so one timeline renders both.
  assert.equal(payload.assignee, CM);
  assert.equal(payload.previousAssignee, "unassigned");

  // Its audit twin is written too — the two halves go together or not at all.
  const auditsAfter = (await events.caseTimeline(omarAudiogram)).filter((e) => e.eventType === "CASE_ASSIGNED").length;
  assert.equal(auditsAfter, auditsBefore + 1);

  // And a no-op writes NEITHER, so the ledger does not fill with "assigned to whoever already had it".
  await bulk({ assignee: CM, caseIds: [omarAudiogram] });
  assert.equal((await assignedActions(omarAudiogram)).length, before + 1);
  assert.equal((await events.caseTimeline(omarAudiogram)).filter((e) => e.eventType === "CASE_ASSIGNED").length, auditsBefore + 1);

  await bulk({ assignee: null, caseIds: [omarAudiogram] });
});

test("bulk assign separates MISSING from CLOSED from unchanged, so the caller knows which is which", async () => {
  const ghost = crypto.randomUUID();
  const closedCase = (await cases.upsertFromOutcome({
    runId, subjectId: "emp-008", measureId: "audiogram", evaluationPeriod: CYCLE, outcomeStatus: "OVERDUE",
  }))!;
  await cases.patchCase(closedCase.id, { status: "RESOLVED" });

  const res = (await bulk({ assignee: CM, caseIds: [omarAudiogram, closedCase.id, ghost] }))!;
  const body = (await res.json()) as { assigned: number; unchanged: number; conflicted: number; missing: string[]; closed: string[] };
  assert.equal(body.assigned, 1);
  assert.deepEqual(body.missing, [ghost]);
  assert.deepEqual(body.closed, [closedCase.id]);
  // The numbers PARTITION the input rather than overlapping: one assigned, one closed, one missing,
  // and nothing genuinely unchanged. The old arithmetic reported 2 unchanged and summed to 5 from an
  // input of 3; it also reported a row LOST to a concurrent write as "already yours", which is the
  // opposite of what happened — hence `conflicted` as its own number.
  assert.equal(body.unchanged, 0, "neither the closed nor the missing case is ALSO 'unchanged'");
  assert.equal(body.conflicted, 0);
  assert.equal(body.assigned + body.unchanged + body.conflicted + body.closed.length + body.missing.length, 3);
  assert.equal((await cases.getCase(closedCase.id))?.assignee, null, "a closed case is not silently reassigned");
  await bulk({ assignee: null, caseIds: [omarAudiogram] });
});

test("bulk assign refuses a bad request rather than half-applying it", async () => {
  const cases400 = [
    [{ caseIds: [omarAudiogram], assignee: "nobody@example.com" }, "assignee"],
    [{ assignee: CM }, "caseIds"],
    [{ assignee: CM, caseIds: [] }, "caseIds"],
    [{ assignee: CM, caseIds: Array.from({ length: BULK_ASSIGN_MAX + 1 }, () => crypto.randomUUID()) }, "caseIds"],
  ] as const;
  for (const [body, parameter] of cases400) {
    const res = (await bulk(body))!;
    assert.equal(res.status, 400, `${JSON.stringify(body).slice(0, 60)} should be a 400`);
    const parsed = (await res.json()) as { error: string; parameter?: string; message: string };
    assert.equal(parsed.error, "invalid_request");
    assert.equal(parsed.parameter, parameter);
  }
  // An unknown assignee names the accepted set rather than saying only "invalid".
  const bad = (await bulk({ caseIds: [omarAudiogram], assignee: "nobody@example.com" }))!;
  assert.match(((await bad.json()) as { message: string }).message, /assignee must be one of: .+@/);
  // A malformed body is a 400, not a 500.
  assert.equal((await bulk("{not json"))!.status, 400);
  assert.equal((await cases.getCase(omarAudiogram))?.assignee, null, "nothing was applied by any refusal");
});

test("duplicate ids collapse — one case is never counted as two assignments", async () => {
  const res = (await bulk({ assignee: CM, caseIds: [omarAudiogram, omarAudiogram, omarAudiogram] }))!;
  assert.deepEqual(await res.json(), { assigned: 1, unchanged: 0, conflicted: 0, missing: [], closed: [] });
  await bulk({ assignee: null, caseIds: [omarAudiogram] });
});

test("bulk assign CLAIMS a case the panel put on the same person, so a later panel edit leaves it", async () => {
  // ADR-080 d1 through the bulk surface. "Assign all of Garcia's patients to me" over a list where
  // half already are is one deliberate act; without this those rows stay PANEL-sourced and the next
  // panel edit takes back exactly the cases the operator just claimed.
  await cases.assignCases([{ id: omarAudiogram, expectedAssignee: null }], CM, "PANEL");
  assert.equal((await cases.getCase(omarAudiogram))?.assignmentSource, "PANEL");

  const res = (await bulk({ assignee: CM, caseIds: [omarAudiogram] }))!;
  const body = (await res.json()) as { assigned: number; unchanged: number };
  assert.equal(body.assigned, 1, "same assignee, different chooser — that IS a change");
  assert.equal((await cases.getCase(omarAudiogram))?.assignmentSource, "OPERATOR");

  // Now it is genuinely a no-op and is reported as one.
  const again = (await bulk({ assignee: CM, caseIds: [omarAudiogram] }))!;
  assert.equal(((await again.json()) as { unchanged: number }).unchanged, 1);
  await bulk({ assignee: null, caseIds: [omarAudiogram] });
});

test("?panel=me is resolved from the MAPPINGS and the caller's own identity", async () => {
  // ADR-080 d5. emp-006 is prov-002's patient and emp-001 is prov-005's, so mapping one provider
  // splits the list — and proves the filter is the panel rather than "everything".
  const panels = new SqlitePanelStore((env as { DB: CloudDatabase }).DB);
  await panels.upsertPanelAssignment({
    providerId: "prov-002",
    assignee: CM,
    actor: "lead@workwell.dev",
    now: new Date().toISOString(),
  });
  try {
    const res = (await get("?panel=me", CM))!;
    const rows = await rowsOf(res);
    assert.deepEqual(rows.map((r) => r.employeeId), ["emp-006"], "only the caller's panel");
    assert.equal(res.headers.get("X-Total-Count"), "1", "the count describes the filtered list");

    // A viewer who owns NO panel sees an empty list. Serving the whole practice here — under a heading
    // that says "My panel" — is the count-not-describing-the-list defect in its worst form: it tells
    // someone that several thousand other people's patients are their responsibility.
    const none = (await get("?panel=me", "quality-lead@workwell.dev"))!;
    assert.deepEqual(await rowsOf(none), []);
    assert.equal(none.headers.get("X-Total-Count"), "0", "and the count says so rather than reporting the practice");

    // The mapping is read case-insensitively, so an account whose stored spelling differs from the
    // JWT's does not silently lose their panel.
    assert.equal((await rowsOf((await get("?panel=me", "CM@WorkWell.dev"))!)).length, 1);

    // `panel=all` and an absent parameter are both "no panel constraint", and neither claims one.
    assert.equal((await rowsOf((await get("?panel=all", CM))!)).length, 2);
    assert.equal((await rowsOf((await get("", CM))!)).length, 2);
  } finally {
    await panels.removePanelAssignment("prov-002");
  }
});

test("?panel=me composes with the other filters rather than replacing them", async () => {
  const panels = new SqlitePanelStore((env as { DB: CloudDatabase }).DB);
  await panels.upsertPanelAssignment({
    providerId: "prov-002",
    assignee: CM,
    actor: "lead@workwell.dev",
    now: new Date().toISOString(),
  });
  try {
    // The practice's sentence is "filter for Garcia, for a specific measure, for specific insurance,
    // then assign that" — so the panel is one constraint among several, ANDed with the rest.
    assert.equal((await rowsOf((await get("?panel=me&measureId=audiogram", CM))!)).length, 1);
    assert.equal((await rowsOf((await get("?panel=me&measureId=does-not-exist", CM))!)).length, 0);
    // An explicit providerId for a DIFFERENT provider intersects to nothing rather than widening.
    assert.equal((await rowsOf((await get("?panel=me&providerId=prov-005", CM))!)).length, 0);
  } finally {
    await panels.removePanelAssignment("prov-002");
  }
});
