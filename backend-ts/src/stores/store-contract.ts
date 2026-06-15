/**
 * Backend-agnostic store contract suite (#104).
 *
 * The whole point of the ports/adapters split is that one contract holds on every
 * backend. So rather than test SQLite and Postgres separately, both adapters run
 * THIS suite — the floor (`UPDATE … RETURNING`) and the ceiling (`FOR UPDATE SKIP
 * LOCKED`) must produce identical observable behaviour. Each `freshStore*` factory
 * hands back an isolated, empty store so ordering assertions are deterministic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CreateRunInput, RunStore } from "./run-store.ts";
import type { OutcomeStore } from "./outcome-store.ts";
import type { CaseStore } from "./case-store.ts";
import type { CaseEventStore } from "./case-event-store.ts";
import type { MeasureStore, SeedMeasureInput } from "./measure-store.ts";

export const sampleRun = (scopeId?: string): CreateRunInput => ({
  scopeType: "MEASURE",
  scopeId,
  triggeredBy: "spike@workwell.dev",
  requestedScope: { measureId: scopeId ?? "audiogram" },
  measurementPeriodStart: "2025-06-12T00:00:00.000Z",
  measurementPeriodEnd: "2026-06-12T00:00:00.000Z",
});

/** Registers the RunStore contract for one backend. `freshStore` → isolated, empty. */
export function runStoreContract(label: string, freshStore: () => Promise<RunStore>): void {
  test(`[${label}] createRun inserts a QUEUED run and getRun reads it back`, async () => {
    const store = await freshStore();
    const created = await store.createRun(sampleRun("audiogram"));
    assert.equal(created.status, "QUEUED");
    assert.equal(created.scopeType, "MEASURE");
    assert.equal(created.scopeId, "audiogram");
    assert.ok(created.id);
    assert.equal(created.completedAt, null);

    const fetched = await store.getRun(created.id);
    assert.deepEqual(fetched, created);
  });

  test(`[${label}] getRun returns null for an unknown id`, async () => {
    const store = await freshStore();
    assert.equal(await store.getRun(crypto.randomUUID()), null);
  });

  test(`[${label}] getRun/markRunning return null for a malformed (non-UUID) id`, async () => {
    // The Postgres ceiling has native UUID id columns; a malformed id (e.g. `foo`
    // from GET /api/runs/foo) must NOT throw — it must match the floor's "no row".
    const store = await freshStore();
    assert.equal(await store.getRun("not-a-uuid"), null);
    assert.equal(await store.markRunning("not-a-uuid"), null);
  });

  test(`[${label}] appendLog writes, listLogs reads them back oldest-first`, async () => {
    const store = await freshStore();
    const run = await store.createRun(sampleRun());
    await store.appendLog(run.id, "INFO", "run started");
    await store.appendLog(run.id, "WARN", "evaluated 1 employee");
    const logs = await store.listLogs(run.id);
    assert.equal(logs.length, 2);
    assert.deepEqual(
      logs.map((l) => `${l.level}:${l.message}`),
      ["INFO:run started", "WARN:evaluated 1 employee"],
    );
    assert.ok(logs[0]!.ts, "log carries a timestamp");
    // the limit bounds the payload (oldest-first window)
    assert.equal((await store.listLogs(run.id, 1)).length, 1);
  });

  test(`[${label}] listRuns returns runs newest-first, capped at limit`, async () => {
    const store = await freshStore();
    const a = await store.createRun(sampleRun("a"));
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.createRun(sampleRun("b"));
    const all = await store.listRuns();
    assert.deepEqual(
      all.map((r) => r.id),
      [b.id, a.id],
      "newest started_at first",
    );
    assert.equal((await store.listRuns(1)).length, 1, "respects the limit");
  });

  test(`[${label}] claimNextQueuedRun atomically flips QUEUED → RUNNING, FIFO, then null`, async () => {
    const store = await freshStore();
    const first = await store.createRun(sampleRun("first"));
    await new Promise((r) => setTimeout(r, 5)); // ensure distinct started_at ordering
    const second = await store.createRun(sampleRun("second"));

    const claim1 = await store.claimNextQueuedRun("worker-A");
    assert.equal(claim1?.id, first.id, "oldest QUEUED run is claimed first");
    assert.equal(claim1?.status, "RUNNING");

    const claim2 = await store.claimNextQueuedRun("worker-B");
    assert.equal(claim2?.id, second.id);
    assert.equal(claim2?.status, "RUNNING");

    assert.equal(await store.claimNextQueuedRun("worker-C"), null, "no QUEUED rows left");
  });

  test(`[${label}] concurrent claims hand each worker a distinct run (no double-claim)`, async () => {
    const store = await freshStore();
    const made = [];
    for (let i = 0; i < 5; i++) {
      made.push(await store.createRun(sampleRun(`run-${i}`)));
      await new Promise((r) => setTimeout(r, 2));
    }
    // Fire all claims at once: each worker must get a different run, none repeated.
    const claims = await Promise.all(
      Array.from({ length: 5 }, (_, i) => store.claimNextQueuedRun(`worker-${i}`)),
    );
    const ids = claims.map((c) => c?.id);
    assert.equal(new Set(ids).size, 5, "every claim is a distinct run id");
    assert.deepEqual([...ids].sort(), made.map((m) => m.id).sort());
    assert.equal(await store.claimNextQueuedRun("worker-late"), null);
  });

  test(`[${label}] markRunning moves a QUEUED run out of the claim path (idempotent)`, async () => {
    const store = await freshStore();
    const run = await store.createRun(sampleRun());
    const running = await store.markRunning(run.id);
    assert.equal(running?.status, "RUNNING");
    assert.equal(await store.claimNextQueuedRun("worker-X"), null, "a RUNNING run is not claimable");
    assert.equal((await store.markRunning(run.id))?.status, "RUNNING", "idempotent");
  });

  test(`[${label}] finalizeRun sets a terminal status + completed_at, and createRun preserves requestedScope`, async () => {
    const store = await freshStore();
    const run = await store.createRun(sampleRun("audiogram"));
    assert.deepEqual(run.requestedScope, { measureId: "audiogram" }, "requestedScope round-trips");
    assert.equal(run.completedAt, null);
    const done = await store.finalizeRun(run.id, "COMPLETED");
    assert.equal(done?.status, "COMPLETED");
    assert.ok(done?.completedAt, "completed_at is stamped");
  });
}

/** Registers the OutcomeStore contract. `fresh` → isolated, empty {run, outcome} pair. */
export function outcomeStoreContract(
  label: string,
  fresh: () => Promise<{ runStore: RunStore; outcomeStore: OutcomeStore }>,
): void {
  test(`[${label}] recordOutcome persists and listOutcomes reads it back with evidence intact`, async () => {
    const { runStore, outcomeStore } = await fresh();
    const run = await runStore.createRun(sampleRun("audiogram"));
    const evidence = { expressionResults: [{ define: "Outcome Status", result: "OVERDUE" }] };

    const rec = await outcomeStore.recordOutcome({
      runId: run.id,
      subjectId: "emp-006",
      measureId: "audiogram",
      status: "OVERDUE",
      evidence,
    });
    assert.ok(rec.id);
    assert.equal(rec.status, "OVERDUE");

    const listed = await outcomeStore.listOutcomes(run.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.subjectId, "emp-006");
    assert.equal(listed[0]!.status, "OVERDUE");
    assert.deepEqual(listed[0]!.evidence, evidence, "JSON evidence round-trips identically");
  });

  test(`[${label}] listOutcomes returns [] for a run with no outcomes`, async () => {
    const { runStore, outcomeStore } = await fresh();
    const run = await runStore.createRun(sampleRun());
    assert.deepEqual(await outcomeStore.listOutcomes(run.id), []);
  });

  test(`[${label}] listOutcomes returns [] for a malformed (non-UUID) run id`, async () => {
    const { outcomeStore } = await fresh();
    assert.deepEqual(await outcomeStore.listOutcomes("not-a-uuid"), []);
  });

  test(`[${label}] listOutcomesWithRun joins started_at + filters by measure/date in the store`, async () => {
    const { runStore, outcomeStore } = await fresh();
    const run = await runStore.createRun(sampleRun("audiogram"));
    await outcomeStore.recordOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", status: "OVERDUE", evidence: {} });
    await outcomeStore.recordOutcome({ runId: run.id, subjectId: "emp-001", measureId: "hazwoper", status: "COMPLIANT", evidence: {} });

    const all = await outcomeStore.listOutcomesWithRun({});
    assert.equal(all.length, 2);
    assert.ok(all.every((r) => r.runStartedAt && r.runId === run.id), "each row carries the run's started_at");

    const justAudiogram = await outcomeStore.listOutcomesWithRun({ measureId: "audiogram" });
    assert.deepEqual(justAudiogram.map((r) => r.measureId), ["audiogram"], "measure filter applied in SQL");

    // date filter is on the run's started day (the run started ~now)
    assert.equal((await outcomeStore.listOutcomesWithRun({ from: "2099-01-01" })).length, 0, "future from → none");
    assert.equal((await outcomeStore.listOutcomesWithRun({ to: "2000-01-01" })).length, 0, "past to → none");
    assert.equal((await outcomeStore.listOutcomesWithRun({ from: "2000-01-01", to: "2099-12-31" })).length, 2, "wide range → all");
  });

  test(`[${label}] listOutcomesForMeasure returns the measure's outcomes with period + evidence`, async () => {
    const { runStore, outcomeStore } = await fresh();
    const run = await runStore.createRun(sampleRun("audiogram"));
    const evidence = { expressionResults: [{ define: "Most Recent Audiogram Date", result: "2025-04-19" }] };
    await outcomeStore.recordOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", status: "OVERDUE", evidence });
    await outcomeStore.recordOutcome({ runId: run.id, subjectId: "emp-001", measureId: "hazwoper", evaluationPeriod: "2026-06-13", status: "COMPLIANT", evidence: {} });

    const rows = await outcomeStore.listOutcomesForMeasure("audiogram");
    assert.equal(rows.length, 1, "measure-scoped");
    assert.equal(rows[0]!.subjectId, "emp-006");
    assert.equal(rows[0]!.evaluationPeriod, "2026-06-13", "evaluation_period round-trips");
    assert.deepEqual(rows[0]!.evidence, evidence, "evidence carried for recency derivation");
  });

  test(`[${label}] listOutcomesForEmployee returns the employee's outcomes newest-first, capped`, async () => {
    const { runStore, outcomeStore } = await fresh();
    const run = await runStore.createRun(sampleRun("audiogram"));
    await outcomeStore.recordOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", status: "OVERDUE", evidence: {} });
    await outcomeStore.recordOutcome({ runId: run.id, subjectId: "emp-006", measureId: "hazwoper", evaluationPeriod: "2026-06-13", status: "COMPLIANT", evidence: {} });
    await outcomeStore.recordOutcome({ runId: run.id, subjectId: "emp-001", measureId: "audiogram", evaluationPeriod: "2026-06-13", status: "COMPLIANT", evidence: {} });

    const rows = await outcomeStore.listOutcomesForEmployee("emp-006", 5);
    assert.equal(rows.length, 2, "employee-scoped (emp-006 only)");
    assert.ok(rows.every((r) => ["audiogram", "hazwoper"].includes(r.measureId)));
    assert.equal((await outcomeStore.listOutcomesForEmployee("emp-006", 1)).length, 1, "limit honored");
    assert.deepEqual(await outcomeStore.listOutcomesForEmployee("emp-404", 5), [], "unknown employee → []");
  });
}

/** Registers the CaseStore contract — the idempotency invariant is the headline case. */
export function caseStoreContract(label: string, freshStore: () => Promise<CaseStore>): void {
  const upsert = (store: CaseStore, outcomeStatus: string, over: Partial<{ subjectId: string; measureId: string }> = {}) =>
    store.upsertFromOutcome({
      runId: crypto.randomUUID(),
      subjectId: over.subjectId ?? "emp-006",
      measureId: over.measureId ?? "audiogram",
      evaluationPeriod: "2026-06-13",
      outcomeStatus,
    });

  test(`[${label}] a rerun upserts the SAME case — never a duplicate (idempotency invariant)`, async () => {
    const store = await freshStore();
    const first = await upsert(store, "OVERDUE");
    assert.equal(first?.status, "OPEN");
    assert.equal(first?.priority, "HIGH");
    const second = await upsert(store, "OVERDUE"); // rerun, same (employee, measure, period)
    assert.equal(second?.id, first?.id, "same case id on rerun");
    assert.equal((await store.listCases({})).length, 1, "exactly one case, not two");
  });

  test(`[${label}] non-compliant priorities + EXCLUDED + COMPLIANT routing`, async () => {
    const store = await freshStore();
    assert.equal((await upsert(store, "DUE_SOON", { subjectId: "emp-007" }))?.priority, "MEDIUM");
    assert.equal((await upsert(store, "EXCLUDED", { subjectId: "emp-008" }))?.status, "EXCLUDED");
    // COMPLIANT with no existing case → no row created
    assert.equal(await upsert(store, "COMPLIANT", { subjectId: "emp-009" }), null);
  });

  test(`[${label}] COMPLIANT resolves an existing open case (closed_at set)`, async () => {
    const store = await freshStore();
    await upsert(store, "OVERDUE");
    const resolved = await upsert(store, "COMPLIANT"); // same key
    assert.equal(resolved?.status, "RESOLVED");
    assert.ok(resolved?.closedAt, "closed_at stamped");
    assert.equal((await store.listCases({ statuses: ["OPEN"] })).length, 0, "no longer open");
  });

  test(`[${label}] listCases filters by status`, async () => {
    const store = await freshStore();
    await upsert(store, "OVERDUE", { subjectId: "emp-005" });
    await upsert(store, "EXCLUDED", { subjectId: "emp-006" });
    assert.equal((await store.listCases({ statuses: ["OPEN"] })).length, 1);
    assert.equal((await store.listCases({ statuses: ["EXCLUDED"] })).length, 1);
    assert.equal((await store.listCases({})).length, 2);
  });

  test(`[${label}] assignee=unassigned matches NULL-assignee cases (COALESCE parity)`, async () => {
    const store = await freshStore();
    await upsert(store, "OVERDUE"); // new case → assignee NULL
    assert.equal((await store.listCases({ assignee: "unassigned" })).length, 1, "unassigned selects NULL rows");
    assert.equal((await store.listCases({ assignee: "Unassigned" })).length, 1, "case-insensitive");
    assert.equal((await store.listCases({ assignee: "someone@workwell.dev" })).length, 0);
  });

  test(`[${label}] patchCase updates only the given fields, bumps updated_at, returns null for unknown id`, async () => {
    const store = await freshStore();
    const c = (await upsert(store, "OVERDUE"))!;
    const patched = await store.patchCase(c.id, { assignee: "cm@workwell.dev" });
    assert.equal(patched?.assignee, "cm@workwell.dev");
    assert.equal(patched?.priority, "HIGH", "untouched fields preserved");
    assert.ok(patched!.updatedAt >= c.updatedAt, "updated_at bumped");
    // assignee: null clears it; nextAction patch is independent
    assert.equal((await store.patchCase(c.id, { assignee: null }))?.assignee, null);
    assert.equal((await store.patchCase(c.id, { nextAction: "Do the thing" }))?.nextAction, "Do the thing");
    assert.equal(await store.patchCase(crypto.randomUUID(), { priority: "LOW" }), null, "unknown id → null");
  });

  test(`[${label}] patchCase sets the rerun-close fields (status/outcome/closedReason/closedBy)`, async () => {
    const store = await freshStore();
    const c = (await upsert(store, "OVERDUE"))!;
    const closedAt = new Date().toISOString();
    const verified = await store.patchCase(c.id, {
      status: "RESOLVED",
      currentOutcomeStatus: "COMPLIANT",
      closedAt,
      closedReason: "RERUN_VERIFIED",
      closedBy: "cm@workwell.dev",
    });
    assert.equal(verified?.status, "RESOLVED");
    assert.equal(verified?.currentOutcomeStatus, "COMPLIANT");
    assert.equal(verified?.closedReason, "RERUN_VERIFIED");
    assert.equal(verified?.closedBy, "cm@workwell.dev");
    assert.ok(verified?.closedAt, "closed_at stamped");
  });

  test(`[${label}] countByLastRun counts cases whose last_run_id matches`, async () => {
    const store = await freshStore();
    const runId = crypto.randomUUID();
    await store.upsertFromOutcome({ runId, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
    await store.upsertFromOutcome({ runId, subjectId: "emp-007", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "DUE_SOON" });
    assert.equal(await store.countByLastRun(runId), 2);
    assert.equal(await store.countByLastRun(crypto.randomUUID()), 0, "unrelated run → 0");
  });
}

/** Registers the CaseEventStore contract — actions + audit ledger + merged timeline. */
export function caseEventStoreContract(
  label: string,
  fresh: () => Promise<{ caseStore: CaseStore; eventStore: CaseEventStore }>,
): void {
  const newCase = (caseStore: CaseStore) =>
    caseStore.upsertFromOutcome({
      runId: crypto.randomUUID(),
      subjectId: "emp-006",
      measureId: "audiogram",
      evaluationPeriod: "2026-06-13",
      outcomeStatus: "OVERDUE",
    });

  test(`[${label}] timeline merges audit_events + case_actions oldest-first; CASE_VIEWED excluded`, async () => {
    const { caseStore, eventStore } = await fresh();
    const c = (await newCase(caseStore))!;
    await eventStore.insertAction({ caseId: c.id, actionType: "ASSIGNED", actor: "cm@x", payload: { assignee: "cm@x" } });
    await eventStore.appendAudit({
      eventType: "CASE_ASSIGNED",
      entityType: "case",
      entityId: c.id,
      actor: "cm@x",
      refRunId: c.lastRunId,
      refCaseId: c.id,
      refMeasureVersionId: c.measureId,
      payload: { assignee: "cm@x" },
    });
    // CASE_VIEWED must never surface on the timeline.
    await eventStore.appendAudit({
      eventType: "CASE_VIEWED",
      entityType: "case",
      entityId: c.id,
      actor: "cm@x",
      refRunId: null,
      refCaseId: c.id,
      refMeasureVersionId: null,
      payload: {},
    });

    const timeline = await eventStore.caseTimeline(c.id);
    const types = timeline.map((t) => t.eventType);
    assert.ok(types.includes("ASSIGNED") && types.includes("CASE_ASSIGNED"), "both sources present");
    assert.ok(!types.includes("CASE_VIEWED"), "CASE_VIEWED excluded");
    assert.ok(
      timeline.every((t) => t.payload.timelineSource === "audit_event" || t.payload.timelineSource === "case_action"),
      "each entry carries a timelineSource discriminator",
    );
    // oldest-first
    for (let i = 1; i < timeline.length; i++) {
      assert.ok(timeline[i - 1]!.occurredAt <= timeline[i]!.occurredAt, "ordered by occurred_at ascending");
    }
  });

  test(`[${label}] caseTimeline is [] for a case with no events`, async () => {
    const { caseStore, eventStore } = await fresh();
    const c = (await newCase(caseStore))!;
    assert.deepEqual(await eventStore.caseTimeline(c.id), []);
  });

  test(`[${label}] listAuditEvents returns the ledger oldest-first with refs + payload`, async () => {
    const { caseStore, eventStore } = await fresh();
    const c = (await newCase(caseStore))!;
    await eventStore.appendAudit({
      eventType: "CASE_ASSIGNED",
      entityType: "case",
      entityId: c.id,
      actor: "cm@x",
      refRunId: c.lastRunId,
      refCaseId: c.id,
      refMeasureVersionId: c.measureId,
      payload: { assignee: "cm@x" },
    });
    const events = await eventStore.listAuditEvents();
    assert.ok(events.length >= 1);
    const e = events.find((x) => x.eventType === "CASE_ASSIGNED")!;
    assert.equal(e.refCaseId, c.id);
    assert.equal(e.actor, "cm@x");
    assert.deepEqual(e.payload, { assignee: "cm@x" });
  });

  test(`[${label}] recordCaseEvent writes the action + audit atomically (both on the timeline)`, async () => {
    const { caseStore, eventStore } = await fresh();
    const c = (await newCase(caseStore))!;
    await eventStore.recordCaseEvent({
      action: { caseId: c.id, actionType: "ESCALATED", actor: "cm@x", payload: { priority: "HIGH" } },
      audit: {
        eventType: "CASE_ESCALATED",
        entityType: "case",
        entityId: c.id,
        actor: "cm@x",
        refRunId: c.lastRunId,
        refCaseId: c.id,
        refMeasureVersionId: c.measureId,
        payload: { priority: "HIGH" },
      },
    });
    const types = (await eventStore.caseTimeline(c.id)).map((t) => t.eventType);
    assert.ok(types.includes("ESCALATED"), "case_action committed");
    assert.ok(types.includes("CASE_ESCALATED"), "audit_event committed in the same transaction");
  });

  test(`[${label}] hasOutreachSent + latestOutreachDeliveryStatus track the OUTREACH_* actions`, async () => {
    const { caseStore, eventStore } = await fresh();
    const c = (await newCase(caseStore))!;
    assert.equal(await eventStore.hasOutreachSent(c.id), false, "no outreach yet");
    assert.equal(await eventStore.latestOutreachDeliveryStatus(c.id), null);

    await eventStore.insertAction({
      caseId: c.id,
      actionType: "OUTREACH_SENT",
      actor: "cm@x",
      payload: { deliveryStatus: "SIMULATED" },
    });
    assert.equal(await eventStore.hasOutreachSent(c.id), true, "outreach recorded");
    assert.equal(await eventStore.latestOutreachDeliveryStatus(c.id), "SIMULATED");

    await new Promise((r) => setTimeout(r, 2)); // ensure a later performed_at
    await eventStore.insertAction({
      caseId: c.id,
      actionType: "OUTREACH_DELIVERY_UPDATED",
      actor: "cm@x",
      payload: { deliveryStatus: "SENT" },
    });
    assert.equal(await eventStore.latestOutreachDeliveryStatus(c.id), "SENT", "latest wins");
  });

  test(`[${label}] outreachSentCounts groups OUTREACH_SENT per case ([] for no ids)`, async () => {
    const { caseStore, eventStore } = await fresh();
    const a = (await newCase(caseStore))!;
    const b = (await caseStore.upsertFromOutcome({
      runId: crypto.randomUUID(),
      subjectId: "emp-007",
      measureId: "audiogram",
      evaluationPeriod: "2026-06-13",
      outcomeStatus: "OVERDUE",
    }))!;
    const sent = (caseId: string) =>
      eventStore.insertAction({ caseId, actionType: "OUTREACH_SENT", actor: "cm@x", payload: { deliveryStatus: "SIMULATED" } });
    await sent(a.id);
    await sent(a.id); // two sends on a
    // a delivery-updated row must NOT inflate the send count
    await eventStore.insertAction({ caseId: a.id, actionType: "OUTREACH_DELIVERY_UPDATED", actor: "cm@x", payload: {} });

    const counts = await eventStore.outreachSentCounts([a.id, b.id]);
    assert.equal(counts[a.id], 2, "two OUTREACH_SENT for a");
    assert.equal(counts[b.id] ?? 0, 0, "no sends for b → absent/0");
    assert.deepEqual(await eventStore.outreachSentCounts([]), {}, "empty input → {}");
  });
}

/** Registers the MeasureStore contract — seed, latest-version reads, create, lifecycle status. */
export function measureStoreContract(label: string, freshStore: () => Promise<MeasureStore>): void {
  const seed = (over: Partial<SeedMeasureInput> = {}): SeedMeasureInput => ({
    measureId: "audiogram",
    name: "Annual Audiogram Completed",
    policyRef: "OSHA 29 CFR 1910.95",
    owner: "system",
    tags: ["surveillance", "hearing"],
    versionId: "audiogram-v1.0",
    version: "v1.0",
    status: "Active",
    spec: { description: "d", eligibilityCriteria: { roleFilter: "", siteFilter: "", programEnrollmentText: "" }, exclusions: [], complianceWindow: "Annual", requiredDataElements: [], testFixtures: [] },
    cqlText: "library X",
    compileStatus: "COMPILED",
    createdAt: "2026-06-10T00:00:00.000Z",
    changeSummary: "Seeded",
    ...over,
  });

  test(`[${label}] seedMeasure + getLatest round-trips tags/spec; isEmpty flips`, async () => {
    const store = await freshStore();
    assert.equal(await store.isEmpty(), true);
    await store.seedMeasure(seed());
    assert.equal(await store.isEmpty(), false);
    const r = (await store.getLatest("audiogram"))!;
    assert.equal(r.name, "Annual Audiogram Completed");
    assert.deepEqual(r.tags, ["surveillance", "hearing"]);
    assert.equal(r.spec.complianceWindow, "Annual");
    assert.equal(r.compileStatus, "COMPILED");
    assert.equal(r.versionId, "audiogram-v1.0");
    assert.ok(r.activatedAt, "Active seed stamps activated_at");
    assert.equal((await store.listLatest()).length, 1);
    assert.equal((await store.listVersions("audiogram")).length, 1);
    assert.equal(await store.getLatest("missing"), null);
  });

  test(`[${label}] createMeasure inserts a Draft v1.0; setVersionStatus drives the lifecycle`, async () => {
    const store = await freshStore();
    const created = await store.createMeasure({ name: "New M", policyRef: "P", owner: "o@x" });
    assert.equal(created.status, "Draft");
    assert.equal(created.version, "v1.0");
    assert.equal(created.compileStatus, "ERROR");
    assert.notEqual(created.measureId, created.versionId, "real distinct ids");

    const approved = await store.setVersionStatus(created.measureId, created.versionId, { status: "Approved", approvedBy: "appr@x" });
    assert.equal(approved?.status, "Approved");
    assert.equal(approved?.approvedBy, "appr@x");
    const active = await store.setVersionStatus(created.measureId, created.versionId, { status: "Active", activate: true });
    assert.equal(active?.status, "Active");
    assert.ok(active?.activatedAt, "activate stamps activated_at");
    assert.equal(await store.setVersionStatus("nope", "nope", { status: "Active" }), null);
  });

  test(`[${label}] updateSpec/updateCql replace the latest version (authoring edits); null for unknown`, async () => {
    const store = await freshStore();
    await store.seedMeasure(seed());
    const newSpec = {
      description: "edited",
      eligibilityCriteria: { roleFilter: "Welder", siteFilter: "Plant A", programEnrollmentText: "HCP" },
      exclusions: [{ label: "Waiver", criteriaText: "on file" }],
      complianceWindow: "Annual",
      requiredDataElements: ["Last exam"],
      testFixtures: [{ fixtureName: "f1", employeeExternalId: "emp-001", expectedOutcome: "COMPLIANT", notes: "" }],
    };
    const specUpdated = await store.updateSpec("audiogram", newSpec, "OSHA 29 CFR 1910.95 — edited");
    assert.equal(specUpdated?.spec.description, "edited");
    assert.equal(specUpdated?.spec.testFixtures.length, 1);
    assert.equal(specUpdated?.policyRef, "OSHA 29 CFR 1910.95 — edited", "policyRef updated when provided");

    const cqlUpdated = await store.updateCql("audiogram", "library Edited version '1.0.0'", "WARNINGS");
    assert.equal(cqlUpdated?.cqlText, "library Edited version '1.0.0'");
    assert.equal(cqlUpdated?.compileStatus, "WARNINGS");
    // updateCql without a status leaves compile_status unchanged
    const cqlNoStatus = await store.updateCql("audiogram", "library Again", undefined);
    assert.equal(cqlNoStatus?.compileStatus, "WARNINGS");

    assert.equal(await store.updateSpec("missing", newSpec), null);
    assert.equal(await store.updateCql("missing", "x"), null);
  });
}
