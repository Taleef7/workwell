/**
 * The audit-first rule, asserted rather than commented (#598).
 *
 * `CLAUDE.md` and `DATA_MODEL_CONTRACTS` §4 say: write new code audit-first, so the ledger errs toward
 * an **over-claim** — an event for a change that then failed to commit — rather than toward a silent
 * state change. Nine call sites were flipped to that order across #607/#608 and this change, and **not
 * one test could tell.** Every existing test asserts that the event EXISTS after a successful
 * operation, which is equally true in either order; a reorder back would have been silent.
 *
 * So each case here makes the MUTATION fail and requires the event to be there anyway. That is exactly
 * the property the rule promises, it is the only externally visible difference between the two orders,
 * and reversing any one call site fails the corresponding case.
 *
 * The route-level surfaces resolve their stores from `env` rather than taking them injected, so they
 * are not reachable THIS way — but they are reachable (`routes/segments.test.ts` patches the store's
 * prototype to make a write fail, and asserts the same property). An earlier version of this comment
 * said their ordering was not testable at all, and three cases were written to a weaker property as a
 * result (#612 review).
 *
 *   node --import tsx --test src/audit/audit-order.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppendAuditInput } from "../stores/case-event-store.ts";
import { grantWaiver } from "../admin/waivers.ts";
import { scheduleAppointment } from "../case/appointment-service.ts";
import { uploadEvidence } from "../case/evidence-service.ts";
import { createMeasure, approveMeasure, deprecateMeasure, transitionStatus } from "../measure/measure-lifecycle.ts";
import { attachValueSet, detachValueSet, createTerminologyMapping } from "../measure/value-set-governance.ts";

/** A ledger that records what it was asked to append, in order. */
function ledger() {
  const events: AppendAuditInput[] = [];
  return {
    events,
    types: () => events.map((e) => e.eventType),
    appendAudit: async (input: AppendAuditInput) => {
      events.push(input);
    },
    // `recordCaseEvent` is the action+audit transaction the case surfaces use; both halves land here.
    recordCaseEvent: async (input: { action: unknown; audit: AppendAuditInput }) => {
      events.push(input.audit);
    },
    recordCaseEvents: async (inputs: Array<{ action: unknown; audit: AppendAuditInput }>) => {
      for (const i of inputs) events.push(i.audit);
    },
  };
}

const BOOM = new Error("the write failed");
const explode = async (): Promise<never> => {
  throw BOOM;
};

// A record whose activation readiness PASSES, so `approveMeasure` reaches its write rather than
// throwing on a blocker — the fixture is what `validateTests` requires, not decoration.
const MEASURE = {
  measureId: "audiogram",
  versionId: "v-1",
  name: "Audiogram",
  policyRef: "OSHA 1910.95",
  owner: "safety",
  version: "v1.0",
  status: "Draft",
  compileStatus: "COMPILED",
  tags: [],
  spec: {
    testFixtures: [{ fixtureName: "overdue welder", employeeExternalId: "emp-001", expectedOutcome: "OVERDUE" }],
  },
};

const CASE = {
  id: "11111111-2222-3333-4444-555555555555",
  employeeId: "emp-001",
  measureId: "audiogram",
  evaluationPeriod: "2026",
  status: "OPEN",
  priority: "HIGH",
  assignee: null,
  nextAction: null,
  lastRunId: "run-1",
  currentOutcomeStatus: "OVERDUE",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("grantWaiver: the WAIVER_GRANTED event survives a failed insert", async () => {
  const log = ledger();
  await assert.rejects(
    () =>
      grantWaiver(
        {
          waivers: { insert: explode } as never,
          measures: { getLatest: async () => MEASURE, getByVersionId: async () => MEASURE } as never,
          events: log as never,
        },
        { employeeExternalId: "emp-001", measureId: "audiogram", exclusionReason: "Medically exempt", expiresAt: null, notes: null, active: true },
        "admin",
      ),
    /the write failed/,
  );
  assert.deepEqual(log.types(), ["WAIVER_GRANTED"]);
  // And the event describes the waiver the insert was about to write, not a row it read back.
  const payload = log.events[0]!.payload as Record<string, unknown>;
  assert.equal(payload.measureId, "audiogram");
  assert.equal(payload.exclusionReason, "Medically exempt");
  assert.equal(payload.active, true);
});

test("scheduleAppointment: the case action + audit survive a failed insert", async () => {
  const log = ledger();
  await assert.rejects(
    () =>
      scheduleAppointment(
        {
          appointments: { insert: explode } as never,
          cases: { getCase: async () => CASE, patchCase: explode } as never,
          events: log as never,
          outcomes: { listOutcomes: async () => [] } as never,
        },
        CASE.id,
        { appointmentType: "Audiometric test", scheduledAt: "2026-10-01T15:00:00.000Z", location: "Plant A", notes: null },
        "nurse",
      ),
    /the write failed/,
  );
  assert.deepEqual(log.types(), ["APPOINTMENT_SCHEDULED"]);
});

test("uploadEvidence: the event survives BOTH a failed bucket write and a failed insert", async () => {
  // Two separate cases, because the bucket write is the one whose exposure is wider than a row: an
  // object in storage the ledger never mentions is harder to notice than a missing row.
  const bytes = new TextEncoder().encode("name,role\nOmar,Welder\n");
  const upload = { bytes, fileName: "evidence.csv", description: "signed form" };

  const failedBucket = ledger();
  await assert.rejects(
    () =>
      uploadEvidence(
        {
          evidence: { insert: explode } as never,
          cases: { getCase: async () => CASE } as never,
          bucket: { put: explode } as never,
          events: failedBucket as never,
        },
        CASE.id,
        upload,
        "nurse",
      ),
    /the write failed/,
  );
  assert.deepEqual(failedBucket.types(), ["EVIDENCE_UPLOADED"]);

  const failedRow = ledger();
  let putCalls = 0;
  await assert.rejects(
    () =>
      uploadEvidence(
        {
          evidence: { insert: explode } as never,
          cases: { getCase: async () => CASE } as never,
          bucket: { put: async () => { putCalls++; } } as never,
          events: failedRow as never,
        },
        CASE.id,
        upload,
        "nurse",
      ),
    /the write failed/,
  );
  assert.deepEqual(failedRow.types(), ["EVIDENCE_UPLOADED"]);
  assert.equal(putCalls, 1);
  // `payload.timestamp` used to read `record.uploadedAt`, which the store minted — the reason this
  // one needed a seam change rather than a reorder. It must now be a real stamp, not empty.
  const payload = failedRow.events[0]!.payload as Record<string, unknown>;
  assert.match(String(payload.timestamp), /^\d{4}-\d{2}-\d{2}T/);
});

test("uploadEvidence: a successful upload stores the stamp the event reported", async () => {
  // The other half of the seam change, and the way it could go quietly wrong: mint the stamp for the
  // event and let the store mint a second one for the row, so the ledger and the attachment disagree
  // about when the upload happened.
  const log = ledger();
  let stored: Record<string, unknown> | null = null;
  const record = await uploadEvidence(
    {
      evidence: {
        insert: async (input: Record<string, unknown>) => {
          stored = input;
          return { ...input, uploadedAt: input.uploadedAt };
        },
      } as never,
      cases: { getCase: async () => CASE } as never,
      bucket: { put: async () => {} } as never,
      events: log as never,
    },
    CASE.id,
    { bytes: new TextEncoder().encode("hello"), fileName: "note.txt", description: null },
    "nurse",
  );
  const payload = log.events[0]!.payload as Record<string, unknown>;
  assert.equal(stored!.uploadedAt, payload.timestamp);
  assert.equal(record.uploadedAt, payload.timestamp);
});

test("createMeasure: the MEASURE_CREATED event survives a failed insert, and names the version it would have made", async () => {
  const log = ledger();
  await assert.rejects(
    () =>
      createMeasure(
        { measures: { createMeasure: explode } as never, events: log as never },
        { name: "Respirator fit test", policyRef: "OSHA 1910.134", owner: "safety" },
        "admin",
      ),
    /the write failed/,
  );
  assert.deepEqual(log.types(), ["MEASURE_CREATED"]);
  assert.match(String(log.events[0]!.entityId), /^[0-9a-f-]{36}$/, "a real version id, minted caller-side");
  assert.equal(log.events[0]!.entityId, log.events[0]!.refMeasureVersionId);
});

test("createMeasure: a successful create inserts under the ids the event named", async () => {
  // The enabling change, and the way it could regress silently: mint ids for the event and let the
  // store mint its own, leaving every MEASURE_CREATED event pointing at a version that never existed.
  const log = ledger();
  let passed: Record<string, unknown> | null = null;
  const returned = await createMeasure(
    {
      measures: {
        createMeasure: async (input: Record<string, unknown>) => {
          passed = input;
          return { ...MEASURE, measureId: input.measureId, versionId: input.versionId };
        },
      } as never,
      events: log as never,
    },
    { name: "Respirator fit test", policyRef: "OSHA 1910.134", owner: "safety" },
    "admin",
  );
  assert.equal(passed!.versionId, log.events[0]!.entityId);
  assert.equal(passed!.measureId, returned);
  assert.equal((log.events[0]!.payload as Record<string, unknown>).measureId, returned);
});

test("approveMeasure / deprecateMeasure: the event survives a failed status write", async () => {
  for (const [label, run] of [
    ["MEASURE_APPROVED", (deps: never) => approveMeasure(deps, "audiogram", "approver")],
    ["MEASURE_DEPRECATED", (deps: never) => deprecateMeasure(deps, "audiogram", "retired", "admin")],
  ] as const) {
    const log = ledger();
    const status = label === "MEASURE_APPROVED" ? "Draft" : "Active";
    await assert.rejects(
      () =>
        run({
          measures: { getLatest: async () => ({ ...MEASURE, status }), setVersionStatus: explode } as never,
          events: log as never,
        } as never),
      /the write failed/,
    );
    assert.deepEqual(log.types(), [label], `${label} is written before the status changes`);
  }
});

/**
 * The four audit-first paths flipped in #607/#608 that this file did not cover (#612 review).
 *
 * §4 says "a new audit-first path belongs in it", and four existing ones did not — so a reorder back on
 * any of them was as silent as the five this file was written for. They are cheap to add because all
 * four take their deps injected.
 */
test("transitionStatus: the event survives a failed status write", async () => {
  const log = ledger();
  await assert.rejects(
    () =>
      transitionStatus(
        { measures: { getLatest: async () => MEASURE, setVersionStatus: explode } as never, events: log as never },
        "audiogram",
        "Approved",
        "approver",
      ),
    /the write failed/,
  );
  assert.deepEqual(log.types(), ["MEASURE_VERSION_STATUS_CHANGED"]);
});

test("createTerminologyMapping: the event survives a failed insert, and names the id it would have made", async () => {
  const log = ledger();
  await assert.rejects(
    () =>
      createTerminologyMapping(
        { valueSets: { createTerminologyMapping: explode } as never, events: log as never },
        {
          localCode: "L1", localSystem: "urn:local", standardCode: "S1", standardSystem: "http://loinc.org",
          localDisplay: null, standardDisplay: null, mappingStatus: null, mappingConfidence: null, notes: null,
        },
        "admin",
      ),
    /the write failed/,
  );
  assert.deepEqual(log.types(), ["TERMINOLOGY_MAPPING_CREATED"]);
  assert.match(String(log.events[0]!.entityId), /^[0-9a-f-]{36}$/, "minted caller-side — the property that let it flip");
});

test("attachValueSet / detachValueSet: the event survives a failed link write", async () => {
  for (const [label, run] of [
    ["MEASURE_VALUE_SET_LINKED", (deps: never) => attachValueSet(deps, "audiogram", "vs-1", "admin")],
    ["MEASURE_VALUE_SET_UNLINKED", (deps: never) => detachValueSet(deps, "audiogram", "vs-1", "admin")],
  ] as const) {
    const log = ledger();
    await assert.rejects(
      () =>
        run({
          measures: { getLatest: async () => MEASURE } as never,
          valueSets: { link: explode, unlink: explode } as never,
          events: log as never,
        } as never),
      /the write failed/,
    );
    assert.deepEqual(log.types(), [label]);
    assert.equal(log.events[0]!.entityId, MEASURE.versionId, "keyed on the version the link belongs to");
  }
});
