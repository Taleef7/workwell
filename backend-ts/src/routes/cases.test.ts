/**
 * Cases worklist route test (#107): seed cases via the store, then assert
 * GET /api/cases returns CaseSummary[] honoring status/site/search + paging.
 *   node --import tsx --test src/routes/cases.test.ts
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
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { handleCases } from "./cases.ts";
import { bucketPeriodForMeasure } from "../run/compliance-period.ts";

// The open worklist is date-driven (today + the measure's cadence), so fixtures must sit on the
// CURRENT cycle anchor to appear there. Annual (audiogram/hazwoper) → Jan 1 of this year; flu is
// seasonal (Jul 1 of the current season).
const TODAY = new Date().toISOString().slice(0, 10);
const CYCLE = bucketPeriodForMeasure("audiogram", TODAY);
const FLU_CYCLE = bucketPeriodForMeasure("flu_vaccine", TODAY);
const FLU_PRIOR = bucketPeriodForMeasure("flu_vaccine", `${Number(TODAY.slice(0, 4)) - 2}-${TODAY.slice(5)}`);

const dbPath = join(tmpdir(), `workwell-cases-${crypto.randomUUID()}.sqlite`);
const bucketDir = join(tmpdir(), `workwell-cases-bucket-${crypto.randomUUID()}`);
let env: { DB: unknown; BUCKET: unknown };
let omarCaseId: string;

const get = (qs = "") => handleCases(new Request(`http://x/api/cases${qs}`, { method: "GET" }), env as never);
const getPath = (path: string) => handleCases(new Request(`http://x${path}`, { method: "GET" }), env as never);
const post = (path: string, actor = "cm@workwell.dev") =>
  handleCases(new Request(`http://x${path}`, { method: "POST" }), env as never, actor);

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db, BUCKET: createFsBucket(bucketDir) };
  const store = new SqliteCaseStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  // a real run row so the outcome FK is satisfied
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z",
    measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
  });
  const runId = run.id;
  // emp-006 = Omar Siddiq (Plant A): OVERDUE; emp-001 = Demo Author (HQ): MISSING_DATA; emp-008 EXCLUDED
  const omar = await store.upsertFromOutcome({ runId, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: CYCLE, outcomeStatus: "OVERDUE" });
  omarCaseId = omar!.id;
  await store.upsertFromOutcome({ runId, subjectId: "emp-001", measureId: "hazwoper", evaluationPeriod: CYCLE, outcomeStatus: "MISSING_DATA" });
  await store.upsertFromOutcome({ runId, subjectId: "emp-008", measureId: "audiogram", evaluationPeriod: CYCLE, outcomeStatus: "EXCLUDED" });
  // evidence for Omar's case (drives the detail's why_flagged): a real exam 420 days ago.
  await outcomes.recordOutcome({
    runId,
    subjectId: "emp-006",
    measureId: "audiogram",
    evaluationPeriod: "2026-01-01",
    status: "OVERDUE",
    evidence: {
      expressionResults: [
        { define: "Has Active Waiver", result: false },
        { define: "Most Recent Audiogram Date", result: "2025-04-19T00:00:00.000Z" },
        { define: "Days Since Last Audiogram", result: 420 },
        { define: "Outcome Status", result: "OVERDUE" },
      ],
    },
  });
  // MISSING_DATA evidence for emp-001: NO recency date; "Days Since" carries the @1900 fallback
  // distance. why_flagged must suppress last_exam_date/days_overdue (must not report 1900-era dates).
  await outcomes.recordOutcome({
    runId,
    subjectId: "emp-001",
    measureId: "hazwoper",
    evaluationPeriod: "2026-01-01",
    status: "MISSING_DATA",
    evidence: {
      expressionResults: [
        { define: "Has Medical Exemption", result: false },
        { define: "Most Recent Surveillance Exam Date", result: null },
        { define: "Days Since Last Exam", result: 46186 },
        { define: "Outcome Status", result: "MISSING_DATA" },
      ],
    },
  });
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
    rmSync(bucketDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test("GET /api/cases returns CaseSummary rows resolved to employee + measure", async () => {
  const res = await get("?status=open");
  assert.equal(res?.status, 200);
  const rows = (await res!.json()) as Array<{ caseId: string; employeeName: string; measureName: string; priority: string; site: string }>;
  assert.equal(rows.length, 2, "two OPEN cases (EXCLUDED is filtered out)");
  const omar = rows.find((r) => r.employeeName === "Omar Siddiq")!;
  assert.equal(omar.measureName, "Audiogram");
  assert.equal(omar.priority, "HIGH"); // OVERDUE
  assert.equal(omar.site, "Plant A");
});

test("status=excluded selects EXCLUDED; site and search filters apply", async () => {
  assert.equal(((await get("?status=excluded").then((r) => r!.json())) as unknown[]).length, 1);
  const plantA = (await get("?status=open&site=Plant%20A").then((r) => r!.json())) as Array<{ employeeName: string }>;
  assert.deepEqual(plantA.map((r) => r.employeeName), ["Omar Siddiq"]);
  const search = (await get("?status=open&search=hazwoper").then((r) => r!.json())) as Array<{ measureName: string }>;
  assert.deepEqual(search.map((r) => r.measureName), ["HAZWOPER Surveillance"]);
});

test("missing status defaults to OPEN (not all); status=all is the unfiltered view", async () => {
  const def = (await get().then((r) => r!.json())) as Array<{ status: string }>;
  assert.equal(def.length, 2, "default worklist shows only OPEN cases");
  assert.ok(def.every((c) => c.status === "OPEN"));
  const all = (await get("?status=all").then((r) => r!.json())) as unknown[];
  assert.equal(all.length, 3, "status=all includes the EXCLUDED case");
});

test("assignee=unassigned matches the NULL-assignee cases", async () => {
  assert.equal(((await get("?status=open&assignee=unassigned").then((r) => r!.json())) as unknown[]).length, 2);
  assert.equal(((await get("?status=open&assignee=someone@workwell.dev").then((r) => r!.json())) as unknown[]).length, 0);
});

test("from/to filter by case creation day (inclusive)", async () => {
  assert.equal(((await get("?status=open&from=2999-01-01").then((r) => r!.json())) as unknown[]).length, 0, "future from → none");
  assert.equal(((await get("?status=open&to=2000-01-01").then((r) => r!.json())) as unknown[]).length, 0, "past to → none");
  assert.equal(((await get("?status=open&from=2000-01-01&to=2999-12-31").then((r) => r!.json())) as unknown[]).length, 2, "wide range → all open");
});

test("GET /api/cases/:id returns CaseDetail with evidence + derived why_flagged", async () => {
  const res = await getPath(`/api/cases/${omarCaseId}`);
  assert.equal(res?.status, 200);
  const d = (await res!.json()) as {
    caseId: string;
    employeeName: string;
    measureName: string;
    outcomeSummary: string;
    evidenceJson: { why_flagged: { days_overdue: number; waiver_status: string; last_exam_date: string }; expressionResults: unknown[] };
    timeline: unknown[];
  };
  assert.equal(d.caseId, omarCaseId);
  assert.equal(d.employeeName, "Omar Siddiq");
  assert.equal(d.measureName, "Audiogram");
  assert.match(d.outcomeSummary, /overdue/i);
  // why_flagged derived from the CQL define results (420 days, window 365 → 55 overdue)
  assert.equal(d.evidenceJson.why_flagged.days_overdue, 55);
  assert.equal(d.evidenceJson.why_flagged.last_exam_date, "2025-04-19", "last_exam_date from the recency define");
  assert.equal(d.evidenceJson.why_flagged.waiver_status, "none");
  assert.ok(d.evidenceJson.expressionResults.length >= 1, "raw expressionResults preserved");
  assert.deepEqual(d.timeline, [], "timeline empty before any action is taken on this case");
});

test("GET /api/cases/:id for MISSING_DATA suppresses last_exam_date/days_overdue (no @1900 fallback leak)", async () => {
  const open = (await get("?status=open").then((r) => r!.json())) as Array<{ caseId: string; measureName: string }>;
  const missing = open.find((r) => r.measureName === "HAZWOPER Surveillance")!;
  const res = await getPath(`/api/cases/${missing.caseId}`);
  assert.equal(res?.status, 200);
  const d = (await res!.json()) as { evidenceJson: { why_flagged: { last_exam_date: string | null; days_overdue: number | null } } };
  assert.equal(d.evidenceJson.why_flagged.last_exam_date, null, "no exam → null, not a 1900-era date");
  assert.equal(d.evidenceJson.why_flagged.days_overdue, null, "no exam → null, not ~45k days");
});

test("GET /api/cases/:id for an unknown case → 404", async () => {
  const res = await getPath(`/api/cases/${crypto.randomUUID()}`);
  assert.equal(res?.status, 404);
});

test("paging via limit/offset", async () => {
  assert.equal(((await get("?status=open&limit=1&offset=0").then((r) => r!.json())) as unknown[]).length, 1);
  assert.equal(((await get("?status=open&limit=1&offset=2").then((r) => r!.json())) as unknown[]).length, 0);
});

test("POST /api/cases/:id/assign sets the assignee and records ASSIGNED on the timeline", async () => {
  const res = await post(`/api/cases/${omarCaseId}/assign?assignee=cm@workwell.dev`);
  assert.equal(res?.status, 200);
  const d = (await res!.json()) as { assignee: string; timeline: Array<{ eventType: string; actor: string }> };
  assert.equal(d.assignee, "cm@workwell.dev");
  const types = d.timeline.map((t) => t.eventType);
  assert.ok(types.includes("ASSIGNED"), "case_action recorded");
  assert.ok(types.includes("CASE_ASSIGNED"), "audit_event recorded");
  // blank assignee clears it back to unassigned
  const cleared = (await post(`/api/cases/${omarCaseId}/assign`).then((r) => r!.json())) as { assignee: string | null };
  assert.equal(cleared.assignee, null);
});

test("POST /api/cases/:id/escalate forces HIGH/OPEN and records ESCALATED", async () => {
  const res = await post(`/api/cases/${omarCaseId}/escalate`);
  assert.equal(res?.status, 200);
  const d = (await res!.json()) as { priority: string; status: string; nextAction: string; timeline: Array<{ eventType: string }> };
  assert.equal(d.priority, "HIGH");
  assert.equal(d.status, "OPEN");
  assert.match(d.nextAction, /supervisor/i);
  assert.ok(d.timeline.map((t) => t.eventType).includes("ESCALATED"));
});

test("the detail timeline is oldest-first and excludes nothing we wrote", async () => {
  const d = (await getPath(`/api/cases/${omarCaseId}`).then((r) => r!.json())) as {
    timeline: Array<{ eventType: string; occurredAt: string; payload: { timelineSource: string } }>;
  };
  assert.ok(d.timeline.length >= 2, "actions accumulated from earlier tests");
  for (let i = 1; i < d.timeline.length; i++) {
    assert.ok(d.timeline[i - 1]!.occurredAt <= d.timeline[i]!.occurredAt, "ascending by occurredAt");
  }
  assert.ok(d.timeline.every((t) => ["audit_event", "case_action"].includes(t.payload.timelineSource)));
});

test("POST /api/cases/:id/assign for an unknown case → 404", async () => {
  assert.equal((await post(`/api/cases/${crypto.randomUUID()}/assign?assignee=x`))?.status, 404);
});

test("GET outreach/preview renders the default template with the case's employee + measure", async () => {
  const res = await getPath(`/api/cases/${omarCaseId}/actions/outreach/preview`);
  assert.equal(res?.status, 200);
  const p = (await res!.json()) as { templateName: string; subject: string; bodyText: string; employeeName: string; measureName: string };
  assert.equal(p.employeeName, "Omar Siddiq");
  assert.equal(p.measureName, "Audiogram");
  // Omar's case is OVERDUE → the outcome-aware default picks the generic compliance reminder (Java
  // parity: OVERDUE never uses a measure-specific body), still rendered with the case's measure/employee.
  assert.equal(p.templateName, "General Compliance Reminder");
  assert.match(p.subject, /Audiogram/);
  assert.match(p.bodyText, /Omar Siddiq/);
});

test("outreach/preview picks the outcome-aware template — MISSING_DATA gets the missing-data template (#150 M1)", async () => {
  // emp-001 / HAZWOPER is MISSING_DATA (seeded in before()).
  const open = (await get("?status=open").then((r) => r!.json())) as Array<{ caseId: string; measureName: string }>;
  const missing = open.find((r) => r.measureName === "HAZWOPER Surveillance")!;
  const p = (await getPath(`/api/cases/${missing.caseId}/actions/outreach/preview`).then((r) => r!.json())) as { templateName: string; subject: string };
  assert.equal(p.templateName, "Missing Data Follow-Up");
  assert.match(p.subject, /[Mm]issing/);
});

test("outreach/preview honors an explicit, known templateId over the outcome default (#150 M1 — Java parity)", async () => {
  // Omar's case is OVERDUE → the default is the generic reminder, but an explicit hearing templateId wins.
  const hearingId = "11111111-0000-0000-0000-000000000001";
  const p = (await getPath(`/api/cases/${omarCaseId}/actions/outreach/preview?templateId=${hearingId}`).then((r) => r!.json())) as {
    templateId: string;
    templateName: string;
  };
  assert.equal(p.templateId, hearingId);
  assert.equal(p.templateName, "Hearing Conservation Overdue Outreach");
});

test("outreach/preview clamps an already-past due date to today (#150 M13)", async () => {
  // Omar's audiogram: last exam 2025-04-19 + 365d window = 2026-04-19, already elapsed → clamp to today
  // so the message never reads "complete by <a past date>".
  const p = (await getPath(`/api/cases/${omarCaseId}/actions/outreach/preview`).then((r) => r!.json())) as { dueDate: string };
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(p.dueDate >= today, `due date ${p.dueDate} must not be before today ${today}`);
  assert.equal(p.dueDate, today);
});

test("GET /api/cases exposes X-Total-Count so clients can page past the limit (#150 M10)", async () => {
  const full = await get("?status=open&limit=500");
  const total = Number(full!.headers.get("X-Total-Count"));
  const body = (await full!.json()) as unknown[];
  assert.ok(Number.isFinite(total) && total >= 1, "X-Total-Count present and >= 1");
  assert.equal(total, body.length, "when limit >= total, the header equals the page length");
  // A smaller limit caps the body, but the header still reports the FULL match total (not the page size).
  const capped = await get("?status=open&limit=1");
  assert.equal(((await capped!.json()) as unknown[]).length, Math.min(1, total));
  assert.equal(Number(capped!.headers.get("X-Total-Count")), total);
});

test("delivery update before a send → 400; send then delivery flips latestOutreachDeliveryStatus", async () => {
  // before any send, delivery update is rejected
  assert.equal((await post(`/api/cases/${omarCaseId}/actions/outreach/delivery?deliveryStatus=SENT`))?.status, 400);

  // send outreach (simulated) → OPEN + latest status SIMULATED
  const sent = await post(`/api/cases/${omarCaseId}/actions/outreach`);
  assert.equal(sent?.status, 200);
  const sd = (await sent!.json()) as {
    status: string;
    nextAction: string;
    latestOutreachDeliveryStatus: string;
    timeline: Array<{ eventType: string }>;
  };
  assert.equal(sd.status, "OPEN");
  assert.match(sd.nextAction, /rerun to verify/i);
  assert.equal(sd.latestOutreachDeliveryStatus, "SIMULATED");
  const types = sd.timeline.map((t) => t.eventType);
  assert.ok(types.includes("OUTREACH_SENT") && types.includes("CASE_OUTREACH_SENT"));

  // now a delivery update is allowed and updates the latest status
  const del = await post(`/api/cases/${omarCaseId}/actions/outreach/delivery?deliveryStatus=SENT`);
  assert.equal(del?.status, 200);
  const dd = (await del!.json()) as { latestOutreachDeliveryStatus: string; nextAction: string };
  assert.equal(dd.latestOutreachDeliveryStatus, "SENT");
  assert.match(dd.nextAction, /rerun to verify/i);
});

test("delivery update with an invalid status → 400", async () => {
  assert.equal((await post(`/api/cases/${omarCaseId}/actions/outreach/delivery?deliveryStatus=NONSENSE`))?.status, 400);
});

test("POST outreach for an unknown case → 404", async () => {
  assert.equal((await post(`/api/cases/${crypto.randomUUID()}/actions/outreach`))?.status, 404);
});

test("worklist exposes outreachRecordCount; a sent case is no longer a gap (badge parity)", async () => {
  // Omar's case had outreach sent in an earlier test → count > 0; others stay 0.
  const rows = (await get("?status=open").then((r) => r!.json())) as Array<{
    employeeName: string;
    outreachRecordCount: number;
  }>;
  const omar = rows.find((r) => r.employeeName === "Omar Siddiq")!;
  assert.ok(omar.outreachRecordCount >= 1, "sent case reflects the outreach send");
  const missing = rows.find((r) => r.employeeName !== "Omar Siddiq");
  if (missing) assert.equal(missing.outreachRecordCount, 0, "un-contacted case is a gap (0)");
});

// Runs last: rerun-to-verify may transition Omar's case to a closing status, which would
// remove it from the open worklist asserted above.
test("POST /api/cases/:id/rerun-to-verify re-evaluates and records the verification on the timeline", async () => {
  const res = await post(`/api/cases/${omarCaseId}/rerun-to-verify`);
  assert.equal(res?.status, 200);
  const d = (await res!.json()) as {
    currentOutcomeStatus: string;
    status: string;
    closedReason: string | null;
    closedBy: string | null;
    timeline: Array<{ eventType: string }>;
  };
  const buckets = ["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"];
  assert.ok(buckets.includes(d.currentOutcomeStatus), "verified to a known outcome bucket");
  const types = d.timeline.map((t) => t.eventType);
  assert.ok(types.includes("RERUN_TO_VERIFY"), "case_action recorded");
  assert.ok(types.includes("CASE_RERUN_VERIFIED"), "audit_event recorded");
  // closing outcomes set the closed_reason/closed_by columns (else they stay null)
  if (d.currentOutcomeStatus === "COMPLIANT") {
    assert.equal(d.status, "RESOLVED");
    assert.equal(d.closedReason, "RERUN_VERIFIED");
    assert.equal(d.closedBy, "cm@workwell.dev");
  } else if (d.currentOutcomeStatus === "EXCLUDED") {
    assert.equal(d.closedReason, "RERUN_EXCLUDED");
  } else {
    assert.equal(d.closedReason, null, "non-closing outcome leaves the case open");
  }
});

test("POST /api/cases/:id/rerun-to-verify for an unknown case → 404", async () => {
  assert.equal((await post(`/api/cases/${crypto.randomUUID()}/rerun-to-verify`))?.status, 404);
});

// ---- evidence + appointments + resolve (#108) -------------------------------

// A 5-byte PNG signature is enough for magic-byte detection.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

function uploadReq(caseId: string, bytes: Uint8Array, fileName: string, description?: string) {
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: "application/octet-stream" }), fileName);
  if (description !== undefined) form.set("description", description);
  return handleCases(new Request(`http://x/api/cases/${caseId}/evidence`, { method: "POST", body: form }), env as never, "cm@workwell.dev");
}
const postJson = (path: string, body: unknown) =>
  handleCases(new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), env as never, "cm@workwell.dev");

test("evidence: upload (magic-byte detect) → list → download (inline for images)", async () => {
  const up = await uploadReq(omarCaseId, PNG_BYTES, "scan.png", "audiogram scan");
  assert.equal(up?.status, 201);
  const rec = (await up!.json()) as { id: string; mimeType: string; fileName: string; description: string };
  assert.equal(rec.mimeType, "image/png", "detected from magic bytes, not the octet-stream header");
  assert.equal(rec.description, "audiogram scan");

  const list = (await getPath(`/api/cases/${omarCaseId}/evidence`).then((r) => r!.json())) as Array<{ id: string }>;
  assert.ok(list.some((e) => e.id === rec.id), "uploaded evidence is listed");

  const dl = await getPath(`/api/evidence/${rec.id}/download`);
  assert.equal(dl?.status, 200);
  assert.equal(dl!.headers.get("content-type"), "image/png");
  assert.match(dl!.headers.get("content-disposition") ?? "", /^inline; filename="scan\.png"/);
  assert.deepEqual(new Uint8Array(await dl!.arrayBuffer()), PNG_BYTES, "bytes round-trip from the bucket");
});

test("evidence: unsupported content type → 415; unknown evidence download → 404", async () => {
  const bad = await uploadReq(omarCaseId, new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff]), "x.bin");
  assert.equal(bad?.status, 415);
  assert.equal((await getPath(`/api/evidence/${crypto.randomUUID()}/download`))?.status, 404);
});

// A fresh OPEN case (own run) so action tests don't couple to other tests' state.
async function freshOpenCase(subjectId: string): Promise<string> {
  const db = env.DB as never;
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z",
    measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
  });
  const c = await new SqliteCaseStore(db).upsertFromOutcome({
    runId: run.id,
    subjectId,
    measureId: "audiogram",
    evaluationPeriod: "2026-01-01",
    outcomeStatus: "OVERDUE",
  });
  return c!.id;
}

test("appointments: SCHEDULE_APPOINTMENT action moves OPEN→IN_PROGRESS and lists", async () => {
  const caseId = await freshOpenCase("emp-010");
  const res = await postJson(`/api/cases/${caseId}/actions`, {
    type: "SCHEDULE_APPOINTMENT",
    appointmentType: "AUDIOGRAM",
    scheduledAt: "2026-07-01T15:00:00.000Z",
    location: "Plant A Clinic",
    notes: "bring earplugs",
  });
  assert.equal(res?.status, 200);
  const detail = (await res!.json()) as { status: string; timeline: Array<{ eventType: string }> };
  assert.equal(detail.status, "IN_PROGRESS", "OPEN case advances to IN_PROGRESS");
  assert.ok(detail.timeline.some((t) => t.eventType === "SCHEDULE_APPOINTMENT" || t.eventType === "APPOINTMENT_SCHEDULED"));

  const list = (await getPath(`/api/cases/${caseId}/appointments`).then((r) => r!.json())) as Array<{ appointmentType: string; status: string; location: string }>;
  assert.equal(list.length, 1);
  assert.equal(list[0]!.appointmentType, "AUDIOGRAM");
  assert.equal(list[0]!.status, "PENDING");
  assert.equal(list[0]!.location, "Plant A Clinic");
});

test("appointments: missing required fields → 400; unsupported action type → 400", async () => {
  const caseId = await freshOpenCase("emp-011");
  assert.equal((await postJson(`/api/cases/${caseId}/actions`, { type: "SCHEDULE_APPOINTMENT", appointmentType: "X", location: "Y" }))?.status, 400);
  assert.equal((await postJson(`/api/cases/${caseId}/actions`, { type: "FROBNICATE" }))?.status, 400);
});

test("RESOLVE action manually closes an open case (note required)", async () => {
  const caseId = await freshOpenCase("emp-009");
  assert.equal((await postJson(`/api/cases/${caseId}/actions`, { type: "RESOLVE" }))?.status, 400, "note required");
  const ok = await postJson(`/api/cases/${caseId}/actions`, { type: "RESOLVE", note: "documented offline" });
  assert.equal(ok?.status, 200);
  const detail = (await ok!.json()) as { status: string; closedReason: string | null };
  assert.equal(detail.status, "CLOSED");
  assert.equal(detail.closedReason, "MANUAL_RESOLVE");
  // resolving an already-closed case → 400
  assert.equal((await postJson(`/api/cases/${caseId}/actions`, { type: "RESOLVE", note: "again" }))?.status, 400);
});

test("RESOLVE action with an unparsable resolvedAt → 400 (a typo must not silently record now())", async () => {
  const caseId = await freshOpenCase("emp-012");
  assert.equal(
    (await postJson(`/api/cases/${caseId}/actions`, { type: "RESOLVE", note: "documented offline", resolvedAt: "yesterday" }))?.status,
    400,
    "present-but-unparsable resolvedAt is rejected",
  );
  // the case is untouched by the rejected request, and a valid resolvedAt still closes it
  const detail = (await getPath(`/api/cases/${caseId}`).then((r) => r!.json())) as { status: string };
  assert.equal(detail.status, "OPEN", "rejected resolve did not close the case");
  const ok = await postJson(`/api/cases/${caseId}/actions`, { type: "RESOLVE", note: "done", resolvedAt: "2026-06-14T12:00:00.000Z" });
  assert.equal(ok?.status, 200);
  assert.equal((await ok!.json() as { closedAt: string }).closedAt, "2026-06-14T12:00:00.000Z", "the supplied timestamp is honored");
});

// Runs last (seeds extra cases): the current-cycle default is scoped to the OPEN worklist, so the
// closed/excluded tabs still show full history (Codex P2). Isolated on flu_vaccine + fresh employees.
test("terminal tabs (excluded) show full history, not just the current cycle (Codex P2)", async () => {
  const db = env.DB as never;
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "flu_vaccine",
    triggeredBy: "test",
    requestedScope: { measureId: "flu_vaccine" },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z",
    measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
  });
  const store = new SqliteCaseStore(db);
  // An OPEN case at flu's CURRENT seasonal cycle + an EXCLUDED case in a PRIOR season (FLU_PRIOR !=
  // FLU_CYCLE). flu's anchor is Jul 1 (seasonal), so this also guards cadence-correctness: an annual
  // Jan-1 period would NOT be flu's current cycle (Codex P2).
  await store.upsertFromOutcome({ runId: run.id, subjectId: "emp-013", measureId: "flu_vaccine", evaluationPeriod: FLU_CYCLE, outcomeStatus: "MISSING_DATA" });
  await store.upsertFromOutcome({ runId: run.id, subjectId: "emp-014", measureId: "flu_vaccine", evaluationPeriod: FLU_PRIOR, outcomeStatus: "EXCLUDED" });

  // Excluded tab (no period) → full history: the prior-season excluded case must show (the current-cycle
  // default would hide it by restricting to FLU_CYCLE).
  const excluded = (await get("?status=excluded&measureId=flu_vaccine").then((r) => r!.json())) as Array<{ evaluationPeriod: string }>;
  assert.ok(excluded.some((c) => c.evaluationPeriod === FLU_PRIOR), "prior-season excluded case is shown in the excluded tab");

  // Open tab defaults to flu's current seasonal cycle only.
  const open = (await get("?status=open&measureId=flu_vaccine").then((r) => r!.json())) as Array<{ evaluationPeriod: string }>;
  assert.deepEqual(open.map((c) => c.evaluationPeriod), [FLU_CYCLE], "open tab stays on flu's current seasonal cycle");
});
