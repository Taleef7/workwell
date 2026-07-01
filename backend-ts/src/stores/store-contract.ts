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
import type { EvidenceStore } from "./evidence-store.ts";
import type { AppointmentStore } from "./appointment-store.ts";
import type { ValueSetStore } from "./value-set-store.ts";
import type { OutreachTemplateStore } from "./outreach-template-store.ts";
import type { WaiverStore } from "./waiver-store.ts";
import type { SegmentStore } from "./segment-store.ts";
import type { QualitySnapshotStore, QualitySnapshotInput } from "./quality-snapshot-store.ts";
import type { PersonLinkStore } from "./person-link-store.ts";

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
    assert.equal(created.triggeredBy, "spike@workwell.dev", "triggered_by round-trips into RunRecord");
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

  test(`[${label}] createRun honors optional backdating (startedAt/completedAt/status) — synthetic trend history`, async () => {
    const store = await freshStore();
    const startedAt = "2026-03-01T00:00:00.000Z";
    const completedAt = "2026-03-01T00:01:00.000Z";
    const created = await store.createRun({
      ...sampleRun("audiogram"),
      triggeredBy: "seed:trend-history",
      status: "COMPLETED",
      startedAt,
      completedAt,
    });
    assert.equal(created.status, "COMPLETED", "explicit status persisted (not the QUEUED default)");
    assert.equal(created.startedAt, startedAt, "backdated started_at persisted");
    assert.equal(created.completedAt, completedAt, "completed_at persisted");
    const fetched = await store.getRun(created.id);
    assert.deepEqual(fetched, created, "backdated run round-trips through getRun");
  });

  test(`[${label}] createRun without backdating keeps the QUEUED/now defaults (existing behavior unchanged)`, async () => {
    const store = await freshStore();
    const created = await store.createRun(sampleRun("audiogram"));
    assert.equal(created.status, "QUEUED");
    assert.equal(created.completedAt, null);
    assert.ok(created.startedAt, "started_at defaulted to now");
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

  test(`[${label}] failStuckRuns recovers only UNCLAIMED stuck RUNNING runs (ctx.waitUntil orphans)`, async () => {
    const store = await freshStore();
    // A CLAIMED worker run: claimNextQueuedRun stamps claimed_by → not an orphan, never recovered.
    const claimed = await store.createRun(sampleRun("claimed"));
    await store.claimNextQueuedRun("worker-1"); // the only QUEUED row → RUNNING + claimed_by
    // An async (ctx.waitUntil) run: markRunning leaves claimed_by NULL → the orphan case.
    const orphan = await store.createRun(sampleRun("orphan"));
    await store.markRunning(orphan.id);
    const queued = await store.createRun(sampleRun("q")); // stays QUEUED — claim-path pending work
    const done = await store.createRun(sampleRun("d"));
    await store.finalizeRun(done.id, "COMPLETED"); // terminal

    // The default threshold (30 min) is far beyond these just-created runs → nothing recovered.
    assert.equal((await store.failStuckRuns()).length, 0, "recent runs are not failed");

    await new Promise((r) => setTimeout(r, 10)); // ensure started_at precedes the threshold-0 cutoff
    // Threshold 0 → every currently UNCLAIMED RUNNING run is treated as stuck (orphaned by a restart).
    const recoveredIds = await store.failStuckRuns(0);
    assert.deepEqual(recoveredIds, [orphan.id], "only the UNCLAIMED RUNNING run (the ctx.waitUntil orphan) is recovered");
    const recovered = await store.getRun(orphan.id);
    assert.equal(recovered?.status, "FAILED");
    assert.ok(recovered?.completedAt, "completed_at is stamped on recovery");
    assert.equal((await store.getRun(claimed.id))?.status, "RUNNING", "a CLAIMED worker run is left alone (not an orphan)");
    assert.equal((await store.getRun(queued.id))?.status, "QUEUED", "QUEUED runs are left for the claim path, never failed");
    assert.equal((await store.getRun(done.id))?.status, "COMPLETED", "terminal runs are untouched");
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

  test(`[${label}] recordOutcomes batch-persists every input (synthetic trend history); [] is a no-op`, async () => {
    const { runStore, outcomeStore } = await fresh();
    const run = await runStore.createRun(sampleRun("audiogram"));
    await outcomeStore.recordOutcomes([]); // no-op, must not throw
    assert.deepEqual(await outcomeStore.listOutcomes(run.id), [], "empty batch writes nothing");

    const inputs = Array.from({ length: 25 }, (_, i) => ({
      runId: run.id,
      subjectId: `emp-${String(i + 1).padStart(3, "0")}`,
      measureId: "audiogram",
      evaluationPeriod: "2026-03-01",
      status: i % 2 === 0 ? "COMPLIANT" : "OVERDUE",
      evidence: { seedTrendHistory: true, idx: i },
    }));
    await outcomeStore.recordOutcomes(inputs);
    const listed = await outcomeStore.listOutcomes(run.id);
    assert.equal(listed.length, 25, "all batch rows persisted");
    assert.equal(listed.filter((o) => o.status === "COMPLIANT").length, 13);
    const one = listed.find((o) => o.subjectId === "emp-001")!;
    assert.deepEqual(one.evidence, { seedTrendHistory: true, idx: 0 }, "evidence round-trips per row");
    assert.equal(one.evaluationPeriod, "2026-03-01", "evaluation_period persisted");
  });

  test(`[${label}] recordOutcome(s) honor an explicit backdated evaluatedAt; default is ~now`, async () => {
    const { runStore, outcomeStore } = await fresh();
    const run = await runStore.createRun(sampleRun("audiogram"));
    const backdated = "2025-12-01T00:01:00.000Z";

    // Explicit evaluatedAt (single) round-trips exactly.
    const single = await outcomeStore.recordOutcome({
      runId: run.id,
      subjectId: "emp-006",
      measureId: "audiogram",
      status: "OVERDUE",
      evidence: {},
      evaluatedAt: backdated,
    });
    assert.equal(single.evaluatedAt, backdated, "single recordOutcome honors explicit evaluatedAt");

    // Explicit evaluatedAt (batch) round-trips; absent → defaults to ~now.
    await outcomeStore.recordOutcomes([
      { runId: run.id, subjectId: "emp-001", measureId: "audiogram", status: "COMPLIANT", evidence: {}, evaluatedAt: backdated },
      { runId: run.id, subjectId: "emp-002", measureId: "audiogram", status: "COMPLIANT", evidence: {} },
    ]);
    const rows = await outcomeStore.listOutcomes(run.id);
    const emp001 = rows.find((o) => o.subjectId === "emp-001")!;
    const emp002 = rows.find((o) => o.subjectId === "emp-002")!;
    assert.equal(emp001.evaluatedAt, backdated, "batch honors explicit evaluatedAt");
    assert.ok(emp002.evaluatedAt > "2026-01-01T00:00:00.000Z", "batch without evaluatedAt defaults to ~now");
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
    assert.ok(all.every((r) => r.runTriggeredBy === "spike@workwell.dev"), "each row carries the run's triggered_by (seed-exclusion by identity)");

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

  test(`[${label}] timeline is audit-sourced (single-source); case_action twin not double-listed; CASE_VIEWED excluded`, async () => {
    const { caseStore, eventStore } = await fresh();
    const c = (await newCase(caseStore))!;
    // A standalone case_action (no audit twin) must NOT appear — the timeline reads audit_events only.
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
    assert.ok(types.includes("CASE_ASSIGNED"), "audit event present on the timeline");
    assert.ok(!types.includes("ASSIGNED"), "case_action arm not merged (single-source audit timeline)");
    assert.ok(!types.includes("CASE_VIEWED"), "CASE_VIEWED excluded");
    assert.ok(
      timeline.every((t) => t.payload.timelineSource === "audit_event"),
      "every entry is audit-sourced",
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

  test(`[${label}] listAuditEvents pages with limit+offset (oldest-first) — backs the streamed audit export (#150 M9)`, async () => {
    const { caseStore, eventStore } = await fresh();
    const c = (await newCase(caseStore))!;
    for (const assignee of ["a@x", "b@x", "c@x"]) {
      await eventStore.appendAudit({
        eventType: "CASE_ASSIGNED",
        entityType: "case",
        entityId: c.id,
        actor: assignee,
        refRunId: c.lastRunId,
        refCaseId: c.id,
        refMeasureVersionId: c.measureId,
        payload: { assignee },
      });
    }
    const all = await eventStore.listAuditEvents();
    const page1 = await eventStore.listAuditEvents(2, 0);
    const page2 = await eventStore.listAuditEvents(2, 2);
    // Paging concatenated == the full ledger, in the same oldest-first order (no overlap, no gaps).
    assert.deepEqual(
      [...page1, ...page2].map((e) => e.actor),
      all.map((e) => e.actor),
    );
    assert.ok(page1.length === 2 && page2.length === all.length - 2);
  });

  test(`[${label}] auditEventsByRun / auditEventsByMeasureVersion filter the ledger by ref`, async () => {
    const { caseStore, eventStore } = await fresh();
    const c = (await newCase(caseStore))!;
    const versionId = crypto.randomUUID();
    await eventStore.appendAudit({
      eventType: "RUN_COMPLETED",
      entityType: "run",
      entityId: c.lastRunId,
      actor: "cm@x",
      refRunId: c.lastRunId,
      refCaseId: null,
      refMeasureVersionId: null,
      payload: { status: "COMPLETED" },
    });
    await eventStore.appendAudit({
      eventType: "MEASURE_APPROVED",
      entityType: "measure_version",
      entityId: versionId,
      actor: "approver@x",
      refRunId: null,
      refCaseId: null,
      refMeasureVersionId: versionId,
      payload: { version: "v1.0" },
    });

    const byRun = await eventStore.auditEventsByRun(c.lastRunId);
    assert.ok(
      byRun.some((e) => e.eventType === "RUN_COMPLETED"),
      "run ledger includes the run event",
    );
    assert.ok(byRun.every((e) => e.refRunId === c.lastRunId), "only this run's events");

    const byVersion = await eventStore.auditEventsByMeasureVersion(versionId);
    assert.equal(byVersion.length, 1, "one event for the version");
    assert.equal(byVersion[0]!.eventType, "MEASURE_APPROVED");
    assert.deepEqual(byVersion[0]!.payload, { version: "v1.0" });

    assert.deepEqual(await eventStore.auditEventsByRun(crypto.randomUUID()), [], "unknown run → []");
    assert.deepEqual(await eventStore.auditEventsByMeasureVersion(crypto.randomUUID()), [], "unknown version → []");
  });

  test(`[${label}] recentAuditEvents is newest-first + bounded; auditEventsForCases filters by case`, async () => {
    const { caseStore, eventStore } = await fresh();
    const c = (await newCase(caseStore))!;
    const mk = (eventType: string, refCaseId: string | null) =>
      eventStore.appendAudit({
        eventType,
        entityType: "case",
        entityId: c.id,
        actor: "cm@x",
        refRunId: null,
        refCaseId,
        refMeasureVersionId: null,
        payload: { e: eventType },
      });
    await mk("CASE_ASSIGNED", c.id);
    await mk("CASE_ESCALATED", c.id);
    await mk("RUN_COMPLETED", null); // not tied to the case
    await mk("CASE_OUTREACH_SENT", c.id);

    const recent = await eventStore.recentAuditEvents(2);
    assert.equal(recent.length, 2, "bounded to the limit");
    assert.equal(recent[0]!.eventType, "CASE_OUTREACH_SENT", "newest first");

    const forCase = await eventStore.auditEventsForCases([c.id], 10);
    assert.deepEqual(
      forCase.map((e) => e.eventType),
      ["CASE_OUTREACH_SENT", "CASE_ESCALATED", "CASE_ASSIGNED"],
      "only this case's events, newest-first (RUN_COMPLETED excluded — null case)",
    );
    assert.ok(forCase.every((e) => e.refCaseId === c.id));
    assert.deepEqual(await eventStore.auditEventsForCases([], 10), [], "no ids → []");
  });

  test(`[${label}] insertPacketExport records an export row (idempotent inserts, distinct ids)`, async () => {
    const { eventStore } = await fresh();
    const input = {
      packetType: "RUN",
      entityId: crypto.randomUUID(),
      format: "json",
      generatedBy: "cm@x",
      payloadHash: "sha256:deadbeef",
      payloadSizeBytes: 1234,
    };
    // Two builds of the same packet write two distinct export rows (each gets a fresh id).
    await eventStore.insertPacketExport(input);
    await eventStore.insertPacketExport(input);
  });

  test(`[${label}] recordCaseEvent writes the action + audit atomically (timeline is single-source audit)`, async () => {
    const { caseStore, eventStore } = await fresh();
    const c = (await newCase(caseStore))!;
    await eventStore.recordCaseEvent({
      action: { caseId: c.id, actionType: "OUTREACH_SENT", actor: "cm@x", payload: { deliveryStatus: "SIMULATED" } },
      audit: {
        eventType: "CASE_OUTREACH_SENT",
        entityType: "case",
        entityId: c.id,
        actor: "cm@x",
        refRunId: c.lastRunId,
        refCaseId: c.id,
        refMeasureVersionId: c.measureId,
        payload: { deliveryStatus: "SIMULATED" },
      },
    });
    const types = (await eventStore.caseTimeline(c.id)).map((t) => t.eventType);
    // The timeline is sourced solely from audit_events: the audit row shows exactly once and the
    // twin case_action is NOT double-listed (the prior UNION ALL double-counted every action).
    assert.equal(types.filter((t) => t === "CASE_OUTREACH_SENT").length, 1, "audit event on the timeline, exactly once");
    assert.ok(!types.includes("OUTREACH_SENT"), "case_action twin is not double-shown on the timeline");
    // The case_action row is still committed in the same transaction (read via the outreach path).
    assert.equal(await eventStore.hasOutreachSent(c.id), true, "case_action committed atomically with the audit event");
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

    // getByVersionId resolves the version UUID → its measure record (auditor packet lookup).
    const byVersion = (await store.getByVersionId("audiogram-v1.0"))!;
    assert.equal(byVersion.measureId, "audiogram");
    assert.equal(byVersion.versionId, "audiogram-v1.0");
    assert.equal(await store.getByVersionId("nope"), null);
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

/** Registers the EvidenceStore contract — metadata insert/list/get (bytes live in the BUCKET). */
export function evidenceStoreContract(label: string, freshStore: () => Promise<EvidenceStore>): void {
  test(`[${label}] insert + getById round-trips; listByCase is newest-first; unknown → null`, async () => {
    const store = await freshStore();
    const a = await store.insert({
      id: crypto.randomUUID(),
      caseId: "case-1",
      uploadedBy: "cm@x",
      fileName: "report.pdf",
      fileSizeBytes: 1234,
      mimeType: "application/pdf",
      storageKey: "case-1/a-report.pdf",
      description: "Q2 audiogram",
    });
    assert.equal(a.fileName, "report.pdf");
    assert.equal(a.fileSizeBytes, 1234);
    assert.ok(a.uploadedAt, "uploadedAt stamped");

    const back = (await store.getById(a.id))!;
    assert.equal(back.storageKey, "case-1/a-report.pdf");
    assert.equal(back.description, "Q2 audiogram");
    assert.equal(await store.getById(crypto.randomUUID()), null);
    // A malformed id (e.g. /api/evidence/not-a-uuid/download) must be a clean miss, not a
    // Postgres uuid-cast error — the ceiling adapter guards with isUuid before the ::uuid cast.
    assert.equal(await store.getById("not-a-uuid"), null);

    await new Promise((r) => setTimeout(r, 2));
    const b = await store.insert({
      id: crypto.randomUUID(),
      caseId: "case-1",
      uploadedBy: "cm@x",
      fileName: "later.png",
      fileSizeBytes: 9,
      mimeType: "image/png",
      storageKey: "case-1/b-later.png",
      description: null,
    });
    const list = await store.listByCase("case-1");
    assert.equal(list.length, 2);
    assert.equal(list[0]!.id, b.id, "newest-first (uploaded_at DESC)");
    assert.deepEqual(await store.listByCase("case-none"), []);
  });
}

/** Registers the AppointmentStore contract — insert + newest-first list. */
export function appointmentStoreContract(label: string, freshStore: () => Promise<AppointmentStore>): void {
  test(`[${label}] insert round-trips; listByCase is scheduled-at DESC; unknown → []`, async () => {
    const store = await freshStore();
    const earlier = await store.insert({
      id: crypto.randomUUID(),
      caseId: "case-1",
      employeeId: "emp-006",
      measureId: "audiogram",
      appointmentType: "AUDIOGRAM",
      scheduledAt: "2026-07-01T15:00:00.000Z",
      location: "Plant A Clinic",
      status: "PENDING",
      notes: "bring earplugs",
      createdBy: "cm@x",
    });
    assert.equal(earlier.status, "PENDING");
    assert.ok(earlier.createdAt, "createdAt stamped");

    const later = await store.insert({
      id: crypto.randomUUID(),
      caseId: "case-1",
      employeeId: "emp-006",
      measureId: "audiogram",
      appointmentType: "AUDIOGRAM",
      scheduledAt: "2026-08-01T15:00:00.000Z",
      location: "Plant A Clinic",
      status: "PENDING",
      notes: null,
      createdBy: "cm@x",
    });
    const list = await store.listByCase("case-1");
    assert.equal(list.length, 2);
    assert.equal(list[0]!.id, later.id, "latest scheduled_at first");
    assert.equal(list[1]!.id, earlier.id);
    assert.deepEqual(await store.listByCase("case-none"), []);
  });
}

/** Registers the ValueSetStore contract — value sets, links, terminology mappings. */
export function valueSetStoreContract(label: string, freshStore: () => Promise<ValueSetStore>): void {
  test(`[${label}] value sets: seed upserts by id, listAll is name-ordered, getById carries codes`, async () => {
    const store = await freshStore();
    assert.equal(await store.isEmpty(), true);
    await store.seedValueSet({
      id: "vs-b",
      oid: "urn:workwell:vs:bravo",
      name: "Bravo Set",
      version: "2025-demo",
      codes: [{ code: "B1", display: "Bee one", system: "urn:demo" }],
    });
    await store.seedValueSet({
      id: "vs-a",
      oid: "urn:workwell:vs:alpha",
      name: "Alpha Set",
      version: "2025-demo",
      codes: [
        { code: "A1", display: "Ay one", system: "urn:demo" },
        { code: "A2", display: "Ay two", system: "http://www.ama-assn.org/go/cpt" },
      ],
    });
    assert.equal(await store.isEmpty(), false);

    const all = await store.listAll();
    assert.deepEqual(all.map((v) => v.name), ["Alpha Set", "Bravo Set"], "name ASC");
    const a = (await store.getById("vs-a"))!;
    assert.equal(a.codes.length, 2);
    assert.equal(a.resolutionStatus, "RESOLVED");
    assert.equal(a.governanceStatus, "ACTIVE");
    assert.deepEqual(a.codeSystems.sort(), ["http://www.ama-assn.org/go/cpt", "urn:demo"]);
    assert.equal(await store.getById("nope"), null);

    // Re-seed the same id with different codes → upsert (no duplicate, codes replaced).
    await store.seedValueSet({ id: "vs-a", oid: "urn:workwell:vs:alpha", name: "Alpha Set", version: "2025-demo", codes: [{ code: "A1", display: "Ay one", system: "urn:demo" }] });
    assert.equal((await store.getById("vs-a"))!.codes.length, 1, "re-seed replaces codes");
    assert.equal((await store.listAll()).length, 2, "re-seed did not duplicate");

    // setCodes replaces ONLY the codes (+ derived code systems), preserving governance metadata.
    await store.seedValueSet({ id: "vs-c", oid: "urn:workwell:vs:charlie", name: "Charlie Set", version: "operator-v9", codes: [{ code: "C1", display: "Cee one", system: "urn:demo" }] });
    await store.setCodes("vs-c", [
      { code: "C1", display: "Cee one", system: "urn:demo" },
      { code: "C2", display: "Cee two", system: "http://hl7.org/fhir/sid/cvx" },
    ]);
    const c = (await store.getById("vs-c"))!;
    assert.equal(c.codes.length, 2, "setCodes replaces the code list");
    assert.deepEqual(c.codeSystems.sort(), ["http://hl7.org/fhir/sid/cvx", "urn:demo"], "setCodes re-derives code systems");
    assert.equal(c.version, "operator-v9", "setCodes preserves version metadata");
    assert.equal(c.governanceStatus, "ACTIVE", "setCodes preserves status metadata");
    await store.setCodes("nope", [{ code: "Z", display: "Z", system: "urn:demo" }]); // unknown id → no-op, no throw
  });

  test(`[${label}] create + links: create is DRAFT/empty, link/unlink drive listByVersion`, async () => {
    const store = await freshStore();
    const id = await store.create("urn:workwell:vs:new", "New Set", null);
    const created = (await store.getById(id))!;
    assert.equal(created.version, "unspecified", "blank version → unspecified");
    assert.equal(created.governanceStatus, "DRAFT");
    assert.equal(created.codes.length, 0);

    await store.seedValueSet({ id: "vs-x", oid: "urn:workwell:vs:x", name: "X Set", version: "v1", codes: [{ code: "X", display: "X", system: "urn:demo" }] });
    assert.deepEqual(await store.listByVersion("ver-1"), [], "no links yet");
    await store.link("ver-1", "vs-x");
    await store.link("ver-1", "vs-x"); // idempotent
    const linked = await store.listByVersion("ver-1");
    assert.equal(linked.length, 1);
    assert.equal(linked[0]!.id, "vs-x");
    await store.unlink("ver-1", "vs-x");
    assert.deepEqual(await store.listByVersion("ver-1"), []);
    assert.deepEqual(await store.affectedMeasures([]), [], "empty ids → no measures");
  });

  test(`[${label}] terminology mappings: create round-trips, list is status-ordered`, async () => {
    const store = await freshStore();
    assert.deepEqual(await store.listTerminologyMappings(), []);
    const rec = await store.createTerminologyMapping({
      id: "tm-1",
      localCode: "LOCAL-1",
      localDisplay: "Local one",
      localSystem: "urn:workwell:demo",
      standardCode: "92557",
      standardDisplay: "Audiometry",
      standardSystem: "http://www.ama-assn.org/go/cpt",
      mappingStatus: "PROPOSED",
      mappingConfidence: 0.7,
      notes: "note",
    });
    assert.equal(rec.localCode, "LOCAL-1");
    assert.equal(rec.mappingConfidence, 0.7);
    await store.createTerminologyMapping({
      id: "tm-2",
      localCode: "LOCAL-2",
      localDisplay: null,
      localSystem: "urn:workwell:demo",
      standardCode: "86580",
      standardDisplay: null,
      standardSystem: "http://www.ama-assn.org/go/cpt",
      mappingStatus: "APPROVED",
      mappingConfidence: null,
      notes: null,
    });
    const list = await store.listTerminologyMappings();
    assert.equal(list.length, 2);
    assert.equal(list[0]!.mappingStatus, "APPROVED", "status ASC (APPROVED before PROPOSED)");
    assert.equal(list[1]!.mappingConfidence, 0.7);
  });
}

/** Registers the OutreachTemplateStore contract — seed, list (active-only), create, update. */
export function outreachTemplateStoreContract(label: string, freshStore: () => Promise<OutreachTemplateStore>): void {
  test(`[${label}] outreach templates: seed is idempotent, listActive excludes inactive, create + update round-trip`, async () => {
    const store = await freshStore();
    assert.equal(await store.isEmpty(), true);

    await store.seed({ id: "t-1", name: "Alpha", subject: "S1", bodyText: "B1", type: "OUTREACH", createdBy: "system" });
    await store.seed({ id: "t-1", name: "Alpha (dup)", subject: "x", bodyText: "x", type: "OUTREACH", createdBy: "system" }); // ON CONFLICT DO NOTHING
    assert.equal(await store.isEmpty(), false);
    assert.equal((await store.getById("t-1"))!.name, "Alpha", "seed is idempotent — first write wins");

    await new Promise((r) => setTimeout(r, 2)); // distinct created_at so the DESC ordering is deterministic
    const created = await store.create({ id: "t-2", name: "Bravo", subject: "S2", bodyText: "B2", type: "ESCALATION", createdBy: "admin@x" });
    assert.equal(created.active, true);
    assert.equal(created.createdBy, "admin@x");
    assert.equal(created.type, "ESCALATION");

    // create stamps created_at; listActive is created_at DESC — t-2 is newest.
    const active = await store.listActive();
    assert.equal(active.length, 2);
    assert.equal(active[0]!.id, "t-2", "newest-first");

    // update edits fields; deactivating removes it from listActive.
    const updated = (await store.update("t-2", { name: "Bravo v2", subject: "S2b", bodyText: "B2b", type: "OUTREACH", active: false }))!;
    assert.equal(updated.name, "Bravo v2");
    assert.equal(updated.active, false);
    const afterDeactivate = await store.listActive();
    assert.equal(afterDeactivate.length, 1);
    assert.equal(afterDeactivate[0]!.id, "t-1");
    assert.equal(await store.update("missing", { name: "x", subject: "x", bodyText: "x", type: "OUTREACH", active: true }), null);
  });
}

/** Registers the WaiverStore contract — insert, getById, ordering, and the SQL filters. */
export function waiverStoreContract(label: string, freshStore: () => Promise<WaiverStore>): void {
  test(`[${label}] waivers: insert + getById round-trip; list ordering (active DESC, expires NULLS LAST) + filters`, async () => {
    const store = await freshStore();
    assert.deepEqual(await store.list({}), []);

    const w1 = await store.insert({ id: "w-1", employeeExternalId: "emp-006", measureId: "audiogram", measureVersionId: "audiogram-v1.0", exclusionReason: "Medical", grantedBy: "admin@x", expiresAt: "2027-01-01T00:00:00.000Z", notes: "n", active: true });
    assert.equal(w1.active, true);
    assert.ok(w1.grantedAt, "granted_at stamped");
    const w2 = await store.insert({ id: "w-2", employeeExternalId: "emp-010", measureId: "tb_surveillance", measureVersionId: "tb_surveillance-v1.0", exclusionReason: "Religious", grantedBy: "admin@x", expiresAt: null, notes: null, active: true });
    const w3 = await store.insert({ id: "w-3", employeeExternalId: "emp-011", measureId: "audiogram", measureVersionId: "audiogram-v1.0", exclusionReason: "Revoked", grantedBy: "admin@x", expiresAt: "2026-01-01T00:00:00.000Z", notes: null, active: false });

    assert.deepEqual((await store.getById("w-1")), w1);
    assert.equal(await store.getById("missing"), null);

    // ordering: active first; among active, expiry ASC then NULLs last → w-1 (2027) before w-2 (null); inactive w-3 last.
    const all = await store.list({});
    assert.deepEqual(all.map((w) => w.id), ["w-1", "w-2", "w-3"]);

    // filters
    assert.deepEqual((await store.list({ measureId: "audiogram" })).map((w) => w.id).sort(), ["w-1", "w-3"]);
    assert.deepEqual((await store.list({ active: true })).map((w) => w.id).sort(), ["w-1", "w-2"]);
    assert.deepEqual((await store.list({ active: false })).map((w) => w.id), ["w-3"]);
    assert.deepEqual((await store.list({ expiresBefore: "2026-06-01T00:00:00.000Z" })).map((w) => w.id), ["w-3"]);
    assert.deepEqual((await store.list({ expiresAfter: "2026-06-01T00:00:00.000Z" })).map((w) => w.id), ["w-1"]);
    void w2;
  });
}

/** Registers the SegmentStore contract for one backend. `freshStore` → isolated, empty. */
export function segmentStoreContract(label: string, freshStore: () => Promise<SegmentStore>): void {
  test(`[${label}] createSegment persists hydrated measures + overrides; listSegments reads back`, async () => {
    const store = await freshStore();
    const created = await store.createSegment({
      name: "OSHA Safety-Sensitive",
      description: "field roles",
      rule: { match: "ANY", conditions: [{ attr: "role", op: "contains", value: "Welder" }] },
      measureIds: ["audiogram", "hazwoper"],
      overrides: [{ externalId: "emp-001", mode: "INCLUDE" }],
    });
    assert.ok(created.id);
    assert.equal(created.enabled, true);
    assert.deepEqual(created.measureIds.slice().sort(), ["audiogram", "hazwoper"]);
    assert.deepEqual(created.overrides, [{ externalId: "emp-001", mode: "INCLUDE" }]);
    assert.equal(created.rule.conditions[0]!.op, "contains");

    const all = await store.listSegments();
    assert.equal(all.length, 1);
    assert.deepEqual(all[0], created);
  });

  test(`[${label}] getSegment returns null for unknown id`, async () => {
    const store = await freshStore();
    assert.equal(await store.getSegment(crypto.randomUUID()), null);
  });

  test(`[${label}] updateSegment patches enabled + rule, leaves measures; null for unknown`, async () => {
    const store = await freshStore();
    const s = await store.createSegment({ name: "X", rule: { match: "ANY", conditions: [] }, measureIds: ["flu_vaccine"] });
    const upd = await store.updateSegment(s.id, { enabled: false, rule: { match: "ALL", conditions: [{ attr: "site", op: "equals", value: "Clinic" }] } });
    assert.equal(upd!.enabled, false);
    assert.equal(upd!.rule.match, "ALL");
    assert.deepEqual(upd!.measureIds, ["flu_vaccine"], "measures untouched by updateSegment");
    assert.equal(await store.updateSegment(crypto.randomUUID(), { enabled: true }), null);
  });

  test(`[${label}] setMeasures/setOverrides replace; deleteSegment removes children`, async () => {
    const store = await freshStore();
    const s = await store.createSegment({ name: "Y", rule: { match: "ANY", conditions: [] }, measureIds: ["audiogram"] });
    await store.setMeasures(s.id, ["hazwoper", "tb_surveillance"]);
    await store.setOverrides(s.id, [{ externalId: "emp-002", mode: "EXCLUDE" }]);
    const after = await store.getSegment(s.id);
    assert.deepEqual(after!.measureIds.slice().sort(), ["hazwoper", "tb_surveillance"]);
    assert.deepEqual(after!.overrides, [{ externalId: "emp-002", mode: "EXCLUDE" }]);
    await store.deleteSegment(s.id);
    assert.equal(await store.getSegment(s.id), null);
    assert.deepEqual(await store.listSegments(), []);
  });

  test(`[${label}] setMeasures/setOverrides dedupe duplicate input (composite-PK safe)`, async () => {
    const store = await freshStore();
    const s = await store.createSegment({ name: "Z", rule: { match: "ANY", conditions: [] }, measureIds: [] });
    // Duplicate measure ids + duplicate override externalIds must not throw on the PK and must collapse.
    await store.setMeasures(s.id, ["audiogram", "audiogram", "hazwoper"]);
    await store.setOverrides(s.id, [{ externalId: "emp-003", mode: "INCLUDE" }, { externalId: "emp-003", mode: "EXCLUDE" }]);
    const after = await store.getSegment(s.id);
    assert.deepEqual(after!.measureIds.slice().sort(), ["audiogram", "hazwoper"]);
    assert.equal(after!.overrides.length, 1, "duplicate externalId collapses to a single override row");
    assert.equal(after!.overrides[0]!.externalId, "emp-003");
  });
}

/** Registers the QualitySnapshotStore contract for one backend (#E16). `freshStore` → isolated, empty. */
export function qualitySnapshotStoreContract(label: string, freshStore: () => Promise<QualitySnapshotStore>): void {
  const base = (over: Partial<QualitySnapshotInput>): QualitySnapshotInput => ({
    measureId: "audiogram",
    period: "2026-06",
    periodStart: "2026-06-01T00:00:00.000Z",
    periodEnd: "2026-06-30T23:59:59.999Z",
    scopeLevel: "all",
    scopeId: "ALL",
    tenantId: null,
    numerator: 0,
    denominator: 0,
    compliant: 0,
    dueSoon: 0,
    overdue: 0,
    missingData: 0,
    excluded: 0,
    sourceRunId: "run-1",
    computedAt: "2026-06-30T12:00:00.000Z",
    ...over,
  });

  test(`[${label}] quality snapshots: upsert + querySnapshots round-trip, ordered by period then scopeId`, async () => {
    const store = await freshStore();
    await store.upsertSnapshots([
      base({ period: "2026-05", scopeLevel: "all", scopeId: "ALL", numerator: 5, denominator: 10, compliant: 5 }),
      base({ period: "2026-06", scopeLevel: "all", scopeId: "ALL", numerator: 7, denominator: 10, compliant: 7 }),
      base({ period: "2026-06", scopeLevel: "tenant", scopeId: "twh", tenantId: "twh", numerator: 3, denominator: 4, compliant: 3 }),
    ]);
    const rows = await store.querySnapshots({ measureId: "audiogram" });
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => `${r.period}:${r.scopeLevel}:${r.scopeId}`),
      ["2026-05:all:ALL", "2026-06:all:ALL", "2026-06:tenant:twh"],
    );
    assert.ok(rows[0]!.id, "rows carry a persisted id");
    assert.equal(rows[0]!.numerator, 5);
    assert.equal(rows[0]!.denominator, 10);
    assert.equal(rows[0]!.tenantId, null);
    assert.equal(rows[2]!.tenantId, "twh");
    assert.equal(rows[2]!.compliant, 3);
  });

  test(`[${label}] quality snapshots: upsert is idempotent on (measure, period, scope) — last write wins, no dup`, async () => {
    const store = await freshStore();
    await store.upsertSnapshots([base({ numerator: 1, denominator: 10, compliant: 1 })]);
    await store.upsertSnapshots([base({ numerator: 9, denominator: 10, compliant: 9 })]);
    const rows = await store.querySnapshots({ measureId: "audiogram" });
    assert.equal(rows.length, 1, "same (measure, period, scope) overwrites, never duplicates");
    assert.equal(rows[0]!.numerator, 9);
    assert.equal(rows[0]!.compliant, 9);
  });

  test(`[${label}] quality snapshots: filters by period range, scopeLevel/scopeId, tenantId`, async () => {
    const store = await freshStore();
    await store.upsertSnapshots([
      base({ period: "2026-04", scopeLevel: "all", scopeId: "ALL" }),
      base({ period: "2026-05", scopeLevel: "all", scopeId: "ALL" }),
      base({ period: "2026-06", scopeLevel: "all", scopeId: "ALL" }),
      base({ period: "2026-06", scopeLevel: "tenant", scopeId: "twh", tenantId: "twh" }),
      base({ period: "2026-06", scopeLevel: "tenant", scopeId: "ihn", tenantId: "ihn" }),
      base({ period: "2026-06", scopeLevel: "site", scopeId: "twh|HQ", tenantId: "twh" }),
    ]);
    assert.deepEqual(
      (await store.querySnapshots({ from: "2026-05", to: "2026-06", scopeLevel: "all" })).map((r) => r.period),
      ["2026-05", "2026-06"],
    );
    assert.deepEqual((await store.querySnapshots({ scopeLevel: "tenant" })).map((r) => r.scopeId).sort(), ["ihn", "twh"]);
    assert.deepEqual((await store.querySnapshots({ scopeLevel: "tenant", scopeId: "twh" })).map((r) => r.scopeId), ["twh"]);
    assert.deepEqual(
      (await store.querySnapshots({ tenantId: "twh" })).map((r) => `${r.scopeLevel}:${r.scopeId}`).sort(),
      ["site:twh|HQ", "tenant:twh"],
    );
  });

  test(`[${label}] quality snapshots: upsertSnapshots([]) is a no-op`, async () => {
    const store = await freshStore();
    await store.upsertSnapshots([]);
    assert.deepEqual(await store.querySnapshots({}), []);
  });

  test(`[${label}] quality snapshots: an in-batch duplicate (measure, period, scope) collapses last-write-wins`, async () => {
    const store = await freshStore();
    // Two inputs with the SAME key in ONE call: the floor loops last-write-wins; the ceiling's
    // multi-row ON CONFLICT would otherwise raise "cannot affect row a second time" — both must agree.
    await store.upsertSnapshots([
      base({ numerator: 1, denominator: 10, compliant: 1 }),
      base({ numerator: 9, denominator: 10, compliant: 9 }),
    ]);
    const rows = await store.querySnapshots({ measureId: "audiogram" });
    assert.equal(rows.length, 1, "an in-batch duplicate key collapses to a single row (no throw)");
    assert.equal(rows[0]!.numerator, 9, "the last write in the batch wins (floor/ceiling parity)");
  });
}

/** Registers the PersonLinkStore contract for one backend (#187 E15 PR-2). */
export function personLinkStoreContract(label: string, freshStore: () => Promise<PersonLinkStore>): void {
  const ref = (t: string, e: string) => ({ tenantId: t, externalId: e });

  test(`[${label}] person links: upsert normalizes the pair (direction-independent) + reads back`, async () => {
    const store = await freshStore();
    // Insert with b < a lexicographically; the store normalizes so `a` is the smaller ref.
    const link = await store.upsertLink({ a: ref("twh", "emp-007"), b: ref("ihn", "ihn-emp-002"), linkType: "CONFIRMED", createdBy: "cm" });
    assert.equal(link.a.tenantId, "ihn", "smaller ref (ihn|…) is normalized to `a`");
    assert.equal(link.b.tenantId, "twh");
    const all = await store.listLinks();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.linkType, "CONFIRMED");
    assert.equal(all[0]!.createdBy, "cm");
  });

  test(`[${label}] person links: re-asserting the same pair (either direction) is last-write-wins, no dup`, async () => {
    const store = await freshStore();
    await store.upsertLink({ a: ref("twh", "emp-007"), b: ref("ihn", "ihn-emp-002"), linkType: "CONFIRMED", createdBy: "cm" });
    // Same pair, reversed direction, different type → overwrites in place.
    await store.upsertLink({ a: ref("ihn", "ihn-emp-002"), b: ref("twh", "emp-007"), linkType: "BROKEN", createdBy: "admin" });
    const all = await store.listLinks();
    assert.equal(all.length, 1, "one row per pair, direction-independent");
    assert.equal(all[0]!.linkType, "BROKEN", "last write wins");
    assert.equal(all[0]!.createdBy, "admin");
  });

  test(`[${label}] person links: distinct pairs coexist`, async () => {
    const store = await freshStore();
    await store.upsertLink({ a: ref("twh", "emp-007"), b: ref("ihn", "ihn-emp-002"), linkType: "CONFIRMED", createdBy: "cm" });
    await store.upsertLink({ a: ref("twh", "emp-005"), b: ref("ihn", "ihn-emp-050"), linkType: "CONFIRMED", createdBy: "cm" });
    assert.equal((await store.listLinks()).length, 2);
  });
}
