/**
 * POST /api/cases/patient-outreach (#868): one message about several of one patient's gaps, from the
 * patient page. The default (employee) profile runs in-process; the patient profile's one-message
 * behaviour runs in a child with WORKWELL_INSTANCE=maui, since the profile is read at module load.
 *   node --import tsx --test src/routes/cases.patient-outreach.test.ts
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
import { handleCases } from "./cases.ts";
import { authorize } from "../auth/authorize.ts";
import { sendPatientOutreachMessages } from "../case/patient-outreach.ts";
import { runProfileChild } from "../test-support/run-profile-child.ts";
import { measureDisplayName } from "../measure/measure-name.ts";

const dbPath = join(tmpdir(), `workwell-patient-outreach-${crypto.randomUUID()}.sqlite`);
const bucketDir = join(tmpdir(), `workwell-patient-outreach-bucket-${crypto.randomUUID()}`);
let env: { DB: unknown; BUCKET: unknown };
let events: SqliteCaseEventStore;
let audiogram: string;
let hazwoper: string;
let otherPatient: string;
let resolved: string;

const send = (body: unknown, actor = "cm@workwell.dev") =>
  handleCases(
    new Request("http://x/api/cases/patient-outreach", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    env as never,
    actor,
  );

const outreachEvents = async (caseId: string) =>
  (await events.caseTimeline(caseId)).filter((e) => e.eventType === "CASE_OUTREACH_SENT");

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db, BUCKET: createFsBucket(bucketDir) };
  events = new SqliteCaseEventStore(db);
  const store = new SqliteCaseStore(db);
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z",
    measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
  });
  const up = (subjectId: string, measureId: string, outcomeStatus: string) =>
    store.upsertFromOutcome({ runId: run.id, subjectId, measureId, evaluationPeriod: "2026-01-01", outcomeStatus });
  audiogram = (await up("emp-006", "audiogram", "OVERDUE"))!.id;
  hazwoper = (await up("emp-006", "hazwoper", "MISSING_DATA"))!.id;
  otherPatient = (await up("emp-001", "audiogram", "OVERDUE"))!.id;
  resolved = (await up("emp-006", "flu_vaccine", "OVERDUE"))!.id;
  await up("emp-006", "flu_vaccine", "COMPLIANT"); // auto-RESOLVED: no longer an open gap
});

after(() => {
  try {
    rmSync(dbPath, { force: true });
    rmSync(bucketDir, { recursive: true, force: true });
  } catch {
    /* best effort: Windows holds the open SQLite file */
  }
});

test("every field is checked before a case is read: each malformed body is a 400 naming its parameter", async () => {
  const cases: Array<[unknown, string | undefined]> = [
    ["not json", undefined],
    [{}, "caseIds"],
    [{ caseIds: "abc" }, "caseIds"],
    [{ caseIds: [1, 2] }, "caseIds"],
    [{ caseIds: [] }, "caseIds"],
    [{ caseIds: ["  "] }, "caseIds"],
    [{ caseIds: Array.from({ length: 21 }, (_, i) => `case-${i}`) }, "caseIds"],
    [{ caseIds: ["a", "a"] }, "caseIds"],
    [{ caseIds: ["a"], channel: "FAX" }, "channel"],
    [{ caseIds: ["a"], channel: "email" }, "channel"],
    [{ caseIds: ["a"], templateId: 5 }, "templateId"],
    [{ caseIds: ["a"], dryRun: "yes" }, "dryRun"],
  ];
  for (const [body, parameter] of cases) {
    const res = (await send(body))!;
    assert.equal(res.status, 400, JSON.stringify(body));
    const out = (await res.json()) as { error: string; parameter?: string };
    assert.equal(out.error, "invalid_request");
    assert.equal(out.parameter, parameter, JSON.stringify(body));
  }
});

test("an unknown case is a 404 naming it; cases of two patients are a 400; a closed gap is a 409", async () => {
  const unknown = crypto.randomUUID();
  const notFound = (await send({ caseIds: [audiogram, unknown] }))!;
  assert.equal(notFound.status, 404);
  assert.deepEqual(await notFound.json(), { error: "not_found", message: `Case ${unknown} was not found.`, id: unknown });

  const mixed = (await send({ caseIds: [audiogram, otherPatient] }))!;
  assert.equal(mixed.status, 400);
  assert.equal(((await mixed.json()) as { error: string }).error, "mixed_subjects");

  const closed = (await send({ caseIds: [audiogram, resolved] }))!;
  assert.equal(closed.status, 409);
  const body = (await closed.json()) as { error: string; id: string };
  assert.equal(body.error, "case_not_active");
  assert.equal(body.id, resolved);
  assert.equal((await outreachEvents(audiogram)).length, 0, "a refused request sends nothing, even for its open gaps");
});

test("a dry run returns what would be sent and writes nothing (one message per case on the employee profile)", async () => {
  const res = (await send({ caseIds: [audiogram, hazwoper], dryRun: true }))!;
  assert.equal(res.status, 200);
  const out = (await res.json()) as { dryRun: boolean; messages: Array<{ caseIds: string[]; subject: string; bodyText: string }> };
  assert.equal(out.dryRun, true);
  assert.deepEqual(out.messages.map((m) => m.caseIds), [[audiogram], [hazwoper]]);
  for (const m of out.messages) assert.ok(m.subject && m.bodyText);
  assert.equal((await outreachEvents(audiogram)).length, 0);
  assert.equal((await outreachEvents(hazwoper)).length, 0);
});

test("the employee profile sends one message per case on the chosen channel, each recorded once", async () => {
  const res = (await send({ caseIds: [audiogram, hazwoper], channel: "SMS" }))!;
  assert.equal(res.status, 200);
  const out = (await res.json()) as { messages: number; unrecorded: string[]; results: Array<{ caseId: string; channel: string; messageId: string; recorded: boolean }> };
  assert.equal(out.messages, 2);
  assert.deepEqual(out.unrecorded, []);
  assert.deepEqual(out.results.map((r) => [r.caseId, r.channel, r.recorded]), [[audiogram, "SMS", true], [hazwoper, "SMS", true]]);
  assert.notEqual(out.results[0]!.messageId, out.results[1]!.messageId, "two messages");
  for (const id of [audiogram, hazwoper]) {
    const sent = await outreachEvents(id);
    assert.equal(sent.length, 1, `${id}: one CASE_OUTREACH_SENT`);
    assert.equal(sent[0]!.actor, "cm@workwell.dev");
  }
});

test("a case whose dispatch throws is reported unrecorded, and the cases after it are still sent", async () => {
  let calls = 0;
  const mk = (id: string, measureId: string) => ({
    id, employeeId: "emp-006", measureId, evaluationPeriod: "2026-01-01", status: "OPEN", priority: "HIGH", assignee: null,
    nextAction: null, currentOutcomeStatus: "OVERDUE", lastRunId: "run-x", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", closedAt: null, closedReason: null, closedBy: null,
  });
  const cases = [mk("c1", "audiogram"), mk("c2", "hazwoper"), mk("c3", "tb_surveillance")];
  const recorded: string[] = [];
  const deps = {
    cases: { getCase: async (id: string) => cases.find((c) => c.id === id) ?? null, patchCase: async () => null },
    events: {
      recordCaseEvent: async ({ audit }: { audit: { refCaseId: string } }) => {
        calls++;
        if (calls === 2) throw new Error("ledger down");
        recorded.push(audit.refCaseId);
      },
    },
    outcomes: { listOutcomes: async () => [] },
  };
  const out = await sendPatientOutreachMessages(deps as never, cases as never, { actor: "cm@workwell.dev" });
  assert.deepEqual(recorded, ["c1", "c3"]);
  assert.deepEqual(out.unrecorded, ["c2"]);
  assert.deepEqual(out.results.map((r) => [r.caseId, r.recorded]), [["c1", true], ["c2", false], ["c3", true]]);
});

test("only a Case Manager or Admin may send; a viewer is refused at the gate", () => {
  const p = (role: string) => ({ email: "u@workwell.dev", role });
  assert.equal(authorize("POST", "/api/cases/patient-outreach", p("ROLE_CASE_MANAGER")).ok, true);
  assert.equal(authorize("POST", "/api/cases/patient-outreach", p("ROLE_ADMIN")).ok, true);
  assert.equal(authorize("POST", "/api/cases/patient-outreach", p("ROLE_VIEWER")).ok, false);
  assert.equal(authorize("POST", "/api/cases/patient-outreach", p("ROLE_AUTHOR")).ok, false);
});

test("Maui: ONE message for the chosen gaps, the preview is what is sent, and a ticked CMS2 is never named", () => {
  const output = runProfileChild("maui", `
    import { createSqliteD1 } from "@mieweb/cloud-local";
    import { RUN_STORE_FLOOR_DDL } from "./src/stores/sqlite/schema.ts";
    import { SqliteCaseStore } from "./src/stores/sqlite/case-store-sqlite.ts";
    import { SqliteRunStore } from "./src/stores/sqlite/run-store-sqlite.ts";
    import { SqliteCaseEventStore } from "./src/stores/sqlite/case-event-store-sqlite.ts";
    import { handleCases } from "./src/routes/cases.ts";

    const db = await createSqliteD1(":memory:");
    await db.exec(RUN_STORE_FLOOR_DDL.replace(/\\n/g, " "));
    const env = { DB: db };
    const store = new SqliteCaseStore(db);
    const events = new SqliteCaseEventStore(db);
    const run = await new SqliteRunStore(db).createRun({
      scopeType: "MEASURE", scopeId: "cms125", triggeredBy: "test", requestedScope: { measureId: "cms125" },
      measurementPeriodStart: "2026-01-01T00:00:00.000Z", measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
    });
    const up = async (measureId) => (await store.upsertFromOutcome({ runId: run.id, subjectId: "pat-001", measureId, evaluationPeriod: "2026-01-01", outcomeStatus: "OVERDUE" })).id;
    const ids = [await up("cms125"), await up("cms122"), await up("cms2")];
    const call = (body) => handleCases(new Request("http://x/api/cases/patient-outreach", { method: "POST", body: JSON.stringify(body) }), env, "quality-staff@maui.workwell.dev");
    const preview = await (await call({ caseIds: ids, dryRun: true })).json();
    const sent = await (await call({ caseIds: ids })).json();
    const timelines = [];
    for (const id of ids) timelines.push((await events.caseTimeline(id)).filter((e) => e.eventType === "CASE_OUTREACH_SENT").map((e) => e.payload));
    console.log(JSON.stringify({ ids, preview, sent, timelines }));
  `);
  const ids = output.ids as string[];
  const preview = output.preview as { messages: Array<{ caseIds: string[]; subject: string; bodyText: string }> };
  const sent = output.sent as { messages: number; unrecorded: string[]; results: Array<{ caseId: string; messageId: string; recorded: boolean }> };
  const timelines = output.timelines as Array<Array<{ action: { emailMessageId: string; subject: string; channel: string } }>>;

  assert.equal(preview.messages.length, 1, "one message on a patient deployment");
  assert.deepEqual(preview.messages[0]!.caseIds, ids);
  const message = preview.messages[0]!;
  assert.match(message.bodyText, /you are due for a mammogram, an A1c blood test and a visit with your care team\./);
  const text = `${message.subject} ${message.bodyText}`;
  assert.ok(!text.includes(measureDisplayName("cms2")), "the depression measure's title reaches the patient");
  assert.doesNotMatch(text, /\bcms\d|\bMIPS\b|depress|substance|\{\{/i);

  assert.equal(sent.messages, 1);
  assert.deepEqual(sent.unrecorded, []);
  assert.deepEqual(sent.results.map((r) => [r.caseId, r.recorded]), ids.map((id) => [id, true]));
  const messageIds = new Set(sent.results.map((r) => r.messageId));
  assert.equal(messageIds.size, 1, "every case records the same message");
  for (const [i, t] of timelines.entries()) {
    assert.equal(t.length, 1, `${ids[i]}: one CASE_OUTREACH_SENT`);
    assert.equal(t[0]!.action.emailMessageId, sent.results[0]!.messageId);
    assert.equal(t[0]!.action.subject, message.subject, "the subject sent is the subject previewed");
    assert.equal(t[0]!.action.channel, "EMAIL", "no channel means email");
  }
});

test("Maui: when one case's record fails after the message went out, it alone comes back unrecorded", () => {
  const output = runProfileChild("maui", `
    import { sendPatientOutreachMessages } from "./src/case/patient-outreach.ts";
    let calls = 0;
    const mk = (id, measureId) => ({
      id, employeeId: "pat-001", measureId, evaluationPeriod: "2026-01-01", status: "OPEN", priority: "HIGH", assignee: null, nextAction: null,
      currentOutcomeStatus: "OVERDUE", lastRunId: "run-x", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      closedAt: null, closedReason: null, closedBy: null,
    });
    const cases = [mk("c1", "cms125"), mk("c2", "cms122"), mk("c3", "cms130")];
    const deps = {
      cases: { getCase: async (id) => cases.find((c) => c.id === id), patchCase: async () => null },
      events: { recordCaseEvent: async () => { calls++; if (calls === 2) throw new Error("ledger down"); } },
      outcomes: { listOutcomes: async () => [] },
    };
    console.log(JSON.stringify(await sendPatientOutreachMessages(deps, cases, { actor: "cm@pilot.test" })));
  `);
  const out = output as unknown as { messages: number; unrecorded: string[]; results: Array<{ caseId: string; recorded: boolean; messageId: string; status: string }> };
  assert.equal(out.messages, 1);
  assert.deepEqual(out.unrecorded, ["c2"]);
  assert.deepEqual(out.results.map((r) => [r.caseId, r.recorded]), [["c1", true], ["c2", false], ["c3", true]]);
  assert.equal(out.results[1]!.messageId, out.results[0]!.messageId, "the unrecorded case still names the message that went out");
});
