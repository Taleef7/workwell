/**
 * Case outreach dispatch test (#75 E5) — the channel-aware `dispatchOutreach` core behind
 * `sendOutreach`. Seeds a case + its outcome on the SQLite floor, then asserts the recorded
 * OUTREACH_SENT action payload: EMAIL is the default (unchanged behavior), and an explicit
 * "SMS" channel is carried through to the payload.
 *   node --import tsx --test src/case/case-outreach.test.ts
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
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { sendOutreach, updateOutreachDelivery, previewOutreach, type OutreachDeps } from "./case-outreach.ts";
import { runCampaign } from "./outreach-campaign.ts";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const dbPath = join(tmpdir(), `workwell-outreach-${crypto.randomUUID()}.sqlite`);
let db: Awaited<ReturnType<typeof createSqliteD1>>;
let deps: OutreachDeps;

/** Seed a fresh OVERDUE audiogram case (its own run) + evidence, returning its case id. */
async function freshCase(subjectId: string): Promise<string> {
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
  await new SqliteOutcomeStore(db).recordOutcome({
    runId: run.id,
    subjectId,
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
  return c!.id;
}

/** The latest outreach action payload from the (audit-sourced) timeline. The case_action payload
 *  rides under the CASE_OUTREACH_SENT audit event's `payload.action` (case-outreach.ts). */
async function latestOutreachAction(caseId: string): Promise<Record<string, unknown>> {
  const timeline = await deps.events.caseTimeline(caseId);
  const sent = timeline.filter((t) => t.eventType === "CASE_OUTREACH_SENT").at(-1);
  assert.ok(sent, "a CASE_OUTREACH_SENT audit event exists");
  return (sent!.payload.action as Record<string, unknown>) ?? {};
}

before(async () => {
  db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  deps = {
    cases: new SqliteCaseStore(db),
    events: new SqliteCaseEventStore(db),
    outcomes: new SqliteOutcomeStore(db),
  };
});

after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("sendOutreach defaults to EMAIL: payload carries channel=EMAIL + simulated provider; case OPEN", async () => {
  const caseId = await freshCase("emp-100");
  const detail = await sendOutreach(deps, caseId, "cm@workwell.dev");
  assert.ok(detail, "detail returned for an existing case");
  assert.equal(detail!.status, "OPEN");
  assert.equal(detail!.latestOutreachDeliveryStatus, "SIMULATED");

  const payload = await latestOutreachAction(caseId);
  assert.equal(payload.channel, "EMAIL", "default channel is EMAIL (was hardcoded SIMULATED_EMAIL)");
  assert.equal(payload.deliveryProvider, "simulated");
  assert.equal(payload.toAddress, "emp-100@workwell-demo.dev", "EMAIL address shape unchanged");
  assert.equal(detail!.nextAction, "Wait for employee follow-up, then rerun to verify closure.");

  const delivered = await updateOutreachDelivery(deps, caseId, "SENT", "cm@workwell.dev");
  assert.equal(delivered!.nextAction, "Wait for employee response, then rerun to verify closure.");
});

test("sendOutreach with channel=SMS records channel=SMS + simulated provider; case OPEN", async () => {
  const caseId = await freshCase("emp-101");
  const detail = await sendOutreach(deps, caseId, "cm@workwell.dev", null, "SMS");
  assert.ok(detail, "detail returned for an existing case");
  assert.equal(detail!.status, "OPEN");

  const payload = await latestOutreachAction(caseId);
  assert.equal(payload.channel, "SMS");
  assert.equal(payload.deliveryProvider, "simulated");
  assert.equal(payload.toAddress, "sms:emp-101", "SMS address shape");
});

test("patient profile renders clinic wording with no compliance phrasing or due-date metadata", () => {
  const script = `
    import assert from "node:assert/strict";
    import { createSqliteD1 } from "@mieweb/cloud-local";
    import { RUN_STORE_FLOOR_DDL } from "./src/stores/sqlite/schema.ts";
    import { SqliteCaseStore } from "./src/stores/sqlite/case-store-sqlite.ts";
    import { SqliteOutcomeStore } from "./src/stores/sqlite/outcome-store-sqlite.ts";
    import { SqliteRunStore } from "./src/stores/sqlite/run-store-sqlite.ts";
     import { previewOutreach, sendOutreach, updateOutreachDelivery } from "./src/case/case-outreach.ts";

    const db = await createSqliteD1(":memory:");
    await db.exec(RUN_STORE_FLOOR_DDL.replace(/\\n/g, " "));
    const deps = {
      cases: new SqliteCaseStore(db),
      events: new (await import("./src/stores/sqlite/case-event-store-sqlite.ts")).SqliteCaseEventStore(db),
      outcomes: new SqliteOutcomeStore(db),
    };
    const run = await new SqliteRunStore(db).createRun({
      scopeType: "MEASURE",
      scopeId: "cms125",
      triggeredBy: "test",
      requestedScope: { measureId: "cms125" },
      measurementPeriodStart: "2026-01-01T00:00:00.000Z",
      measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
    });
    const overdue = await deps.cases.upsertFromOutcome({
      runId: run.id,
      subjectId: "pat-1",
      measureId: "cms125",
      evaluationPeriod: "2026-01-01",
      outcomeStatus: "OVERDUE",
    });
    await deps.outcomes.recordOutcome({
      runId: run.id,
      subjectId: "pat-1",
      measureId: "cms125",
      evaluationPeriod: "2026-01-01",
      status: "OVERDUE",
      evidence: {
        expressionResults: [
          { define: "Most Recent Mammography Date", result: "2025-04-19T00:00:00.000Z" },
          { define: "Days Since Last Mammography", result: 420 },
          { define: "Outcome Status", result: "OVERDUE" },
        ],
      },
    });
    const missing = await deps.cases.upsertFromOutcome({
      runId: run.id,
      subjectId: "pat-2",
      measureId: "cms125",
      evaluationPeriod: "2026-01-01",
      outcomeStatus: "MISSING_DATA",
    });
    await deps.outcomes.recordOutcome({
      runId: run.id,
      subjectId: "pat-2",
      measureId: "cms125",
      evaluationPeriod: "2026-01-01",
      status: "MISSING_DATA",
      evidence: { expressionResults: [{ define: "Outcome Status", result: "MISSING_DATA" }] },
    });
    const rendered = {
       general: await previewOutreach(deps, overdue.id, "11111111-0000-0000-0000-000000000003"),
       missing: await previewOutreach(deps, missing.id),
     };
     const sent = await sendOutreach(deps, overdue.id, "cm@pilot.test", "11111111-0000-0000-0000-000000000003");
     const delivered = await updateOutreachDelivery(deps, overdue.id, "SENT", "cm@pilot.test");
     console.log(JSON.stringify({ rendered, sentNextAction: sent?.nextAction, deliveredNextAction: delivered?.nextAction }));
  `;
  const output = runProfileChild("maui", script);
  const rendered = output.rendered as Record<"general" | "missing", Record<string, unknown>>;
  const forbidden = ["requirement", "compliance", "occupational", "Due date"];
  assert.ok(rendered.general, `general preview rendered: ${JSON.stringify(output)}`);
  assert.ok(rendered.missing, `missing preview rendered: ${JSON.stringify(output)}`);
  const measureName = rendered.general.measureName as string;
  const patientName = rendered.general.employeeName as string;
  assert.equal(rendered.general.subject, "A reminder from your clinic");
  assert.equal(rendered.general.bodyText, `Hello ${patientName}, our records show you are due for a mammogram. Please call the clinic to schedule, or reply to this message with a good time to reach you.`);
  assert.equal(rendered.missing.subject, "A reminder from your clinic");
  assert.equal(rendered.missing.bodyText, `Hello ${rendered.missing.employeeName}, we could not find a record of a mammogram. If you had it done elsewhere, please send us the report or call the clinic.`);
  // Q1: the catalog title is never in what the patient reads (the preview still names it for staff).
  for (const preview of [rendered.general, rendered.missing]) {
    assert.ok(!String(preview.subject).includes(measureName) && !String(preview.bodyText).includes(measureName), "the measure title reaches the patient");
  }
  assert.equal(rendered.general.dueDate, undefined);
  assert.equal(rendered.missing.dueDate, undefined);
  assert.equal(output.sentNextAction, "Wait for patient follow-up, then rerun to verify closure.");
  assert.equal(output.deliveredNextAction, "Wait for patient response, then rerun to verify closure.");
  for (const preview of [rendered.general, rendered.missing]) {
    const serialized = JSON.stringify(preview).toLowerCase();
    for (const phrase of forbidden) assert.ok(!serialized.includes(phrase.toLowerCase()), `forbidden phrase: ${phrase}`);
  }
});

test("patient campaign resolves an employee template id against patient templates", () => {
  const output = runProfileChild("maui", `
    import { runCampaign } from "./src/case/outreach-campaign.ts";
    const actions = [];
    const c = {
      id: "case-patient-campaign", employeeId: "pat-001", measureId: "cms122", evaluationPeriod: "2026-01-01",
      status: "OPEN", priority: "HIGH", assignee: null, nextAction: null, currentOutcomeStatus: "OVERDUE",
      lastRunId: "run-patient-campaign", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      closedAt: null, closedReason: null, closedBy: null,
    };
    const deps = {
      cases: {
        listCases: async () => [c],
        getCase: async () => c,
        patchCase: async () => c,
      },
      events: { recordCaseEvent: async ({ audit }) => actions.push(audit) },
      outcomes: { listOutcomes: async () => [] },
      campaigns: { recordCampaign: async () => {} },
      channels: () => ({ type: "EMAIL", send: (message) => ({ channel: "EMAIL", provider: "simulated", status: "SIMULATED", messageId: "msg-1", to: message.to, sentAt: "2026-01-01T00:00:00.000Z", errorDetail: null }) }),
    };
    const result = await runCampaign(deps, { measureId: "cms122", channel: "EMAIL", templateId: "11111111-0000-0000-0000-000000000003" }, "cm@pilot.test");
    console.log(JSON.stringify({ result, action: actions[0] }));
  `);
  const action = output.action as { payload: { action: { templateId: string; templateName: string } } };
  assert.equal(action.payload.action.templateId, "patient-general");
  assert.equal(action.payload.action.templateName, "General Clinic Reminder");
});

test("default preview keeps the employee general template and dueDate field", async () => {
  const caseId = await freshCase("emp-102");
  const preview = await previewOutreach(deps, caseId);
  assert.ok(preview);
  assert.equal(preview!.templateName, "General Compliance Reminder");
  assert.match(preview!.subject, /^Outreach Reminder for /u);
  assert.match(preview!.bodyText, /pending .* requirement and complete the required follow-up/u);
  assert.equal(typeof preview!.dueDate, "string");
});

test("Q1: a patient campaign sends one message per patient listing every gap, and never CMS2 or CMS137", () => {
  const output = runProfileChild("maui", `
    import { runCampaign, CampaignError } from "./src/case/outreach-campaign.ts";
    const sends = [];
    const audits = [];
    const mk = (id, employeeId, measureId, outcome = "OVERDUE") => ({
      id, employeeId, measureId, evaluationPeriod: "2026-01-01", status: "OPEN", priority: "HIGH", assignee: null, nextAction: null,
      currentOutcomeStatus: outcome, lastRunId: "run-q1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      closedAt: null, closedReason: null, closedBy: null,
    });
    const cases = [mk("c1", "pat-001", "cms125"), mk("c2", "pat-001", "cms122"), mk("c3", "pat-001", "cms137"), mk("c4", "pat-002", "cms2"), mk("c5", "pat-003", "cms165", "MISSING_DATA"), mk("c6", "pat-004", "cms130"), mk("c7", "pat-004", "cms165", "MISSING_DATA")];
    const deps = {
      cases: { listCases: async () => cases, getCase: async (id) => cases.find((c) => c.id === id), patchCase: async () => null },
      events: { recordCaseEvent: async ({ audit }) => audits.push(audit) },
      outcomes: { listOutcomes: async () => [] },
      campaigns: { recordCampaign: async () => {} },
      channels: () => ({ type: "EMAIL", send: (m) => { sends.push(m); return { channel: "EMAIL", provider: "simulated", status: "SIMULATED", messageId: "msg-" + sends.length, to: m.to, sentAt: "2026-01-01T00:00:00.000Z", errorDetail: null }; } }),
    };
    const result = await runCampaign(deps, { channel: "EMAIL" }, "cm@pilot.test");
    const preview = await runCampaign(deps, { channel: "EMAIL", dryRun: true }, "cm@pilot.test");
    let refused = null;
    for (const measureId of ["cms2", "cms137"]) {
      try { await runCampaign(deps, { channel: "EMAIL", measureId }, "cm@pilot.test"); } catch (e) { refused = (refused ?? []).concat(e instanceof CampaignError ? measureId : "other"); }
    }
    console.log(JSON.stringify({ result, preview: { messages: preview.messages, withheld: preview.withheld, total: preview.total }, sends, auditCases: audits.map((a) => [a.refCaseId, a.payload.action.emailMessageId]), refused }));
  `);
  const result = output.result as { messages: number; withheld: number; total: number; sent: number };
  const sends = output.sends as Array<{ to: string; subject: string; body: string }>;
  assert.equal(sends.length, 3, "one message per patient: pat-001 (two gaps), pat-003 and pat-004 (two gaps)");
  assert.equal(result.messages, 3);
  assert.equal(result.withheld, 2, "the CMS137 and CMS2 cases are left out, counted");
  assert.equal(result.total, 5);
  assert.match(sends[0]!.body, /you are due for a mammogram and an A1c blood test\./);
  assert.match(sends[1]!.body, /we could not find a record of a blood pressure check\./, "a patient whose only gap is missing data gets the record request");
  assert.match(sends[2]!.body, /you are due for a colorectal cancer screening and a blood pressure check\./, "one gap overdue and one missing data: the due reminder, not the record request");
  for (const m of sends) {
    assert.equal(m.subject, "A reminder from your clinic");
    assert.doesNotMatch(m.body, /substance|depression|CMS|MIPS|Glycemic/i);
  }
  assert.deepEqual(output.auditCases, [["c1", "msg-1"], ["c2", "msg-1"], ["c5", "msg-2"], ["c6", "msg-3"], ["c7", "msg-3"]], "each case records the send, sharing its patient's message");
  assert.deepEqual(output.preview, { messages: 3, withheld: 2, total: 5 }, "the dry run says the same");
  assert.deepEqual(output.refused, ["cms2", "cms137"], "a campaign aimed at either is refused");
});
