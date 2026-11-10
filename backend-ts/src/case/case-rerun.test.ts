import { test } from "node:test";
import assert from "node:assert/strict";
import { rerunToVerify, CaseRerunFailedError, type RerunDeps } from "./case-rerun.ts";
import type { CaseRecord } from "../stores/case-store.ts";

const existing: CaseRecord = {
  id: "case-wc", employeeId: "wc|rerun-patient", measureId: "audiogram", evaluationPeriod: "2026-01-01",
  status: "OPEN", priority: "HIGH", assignee: null, nextAction: "Verify", nextActionSource: "SYSTEM", assignmentSource: null, currentOutcomeStatus: "OVERDUE",
  lastRunId: "run-existing", createdAt: "2026-07-17T00:00:00.000Z", updatedAt: "2026-07-17T00:00:00.000Z",
  closedAt: null, closedReason: null, closedBy: null,
};

test("rerunToVerify — a verification that throws records the attempt and leaves the case as it was", async () => {
  // Before this guard the failure's MISSING_DATA reopened a closed case (and overwrote an open one).
  const closed: CaseRecord = {
    ...existing, id: "case-closed", employeeId: "emp-001", status: "CLOSED", currentOutcomeStatus: "OVERDUE",
    closedAt: "2026-07-18T00:00:00.000Z", closedReason: "MANUAL_RESOLVE", closedBy: "nurse@example.test",
  };
  const patched: unknown[] = [];
  const audits: Array<{ eventType: string; payload: unknown }> = [];
  const outcomes: Array<{ status: string; evidence: unknown }> = [];
  let finalStatus = "";
  const deps = {
    cases: { getCase: async () => closed, patchCase: async (_id: string, patch: unknown) => { patched.push(patch); return closed; } },
    events: {
      recordCaseEvent: async (e: { audit: { eventType: string; payload: unknown } }) => { audits.push(e.audit); },
      appendAudit: async (a: { eventType: string; payload: unknown }) => { audits.push(a); },
      caseTimeline: async () => [],
      latestOutreachDeliveryStatus: async () => null,
    },
    outcomes: {
      recordOutcome: async (o: { status: string; evidence: unknown }) => { outcomes.push(o); },
      listOutcomes: async () => [],
    },
    runStore: {
      createRun: async () => ({ id: "run-verify" }),
      markRunning: async () => {},
      appendLog: async () => {},
      finalizeRun: async (_id: string, status: string) => { finalStatus = status; },
    },
    engine: { evaluate: async () => { throw new Error("engine down"); } },
  } as unknown as RerunDeps;

  await assert.rejects(
    () => rerunToVerify(deps, closed.id, "tester"),
    (err: unknown) => err instanceof CaseRerunFailedError && err.runId === "run-verify",
    "the caller is told the verification failed, with the new run's id",
  );
  assert.deepEqual(patched, [], "the case is never patched");
  assert.deepEqual(audits.map((a) => a.eventType), ["CASE_RERUN_FAILED"], "the attempt is audited, as a failure");
  assert.equal((audits[0]!.payload as { caseUnchanged?: boolean }).caseUnchanged, true);
  assert.equal(outcomes.length, 1, "the failed outcome is still recorded");
  assert.ok((outcomes[0]!.evidence as { evaluationError?: string }).evaluationError);
  assert.equal(finalStatus, "PARTIAL_FAILURE");
});

test("rerunToVerify — wc CASE is a typed unsupported result before every mutation", async () => {
  const mutations: string[] = [];
  const mutated = (name: string) => async () => { mutations.push(name); throw new Error(`unexpected mutation: ${name}`); };
  const deps = {
    cases: { getCase: async () => existing, patchCase: mutated("case"), listCases: async () => [existing], upsertFromOutcome: mutated("case"), countByLastRun: async () => 1 },
    events: { recordCaseEvent: mutated("audit"), appendAudit: mutated("audit"), caseTimeline: async () => [], latestOutreachDeliveryStatus: async () => null },
    outcomes: { recordOutcome: mutated("outcome"), listOutcomes: async () => [] },
    runStore: { createRun: mutated("run"), markRunning: mutated("run"), appendLog: mutated("run"), finalizeRun: mutated("run"), listRuns: async () => [] },
    engine: { evaluate: mutated("engine") },
  } as unknown as RerunDeps;

  await assert.rejects(
    () => rerunToVerify(deps, existing.id, "tester"),
    (error: unknown) => (error as { code?: string }).code === "unsupported_scope",
  );
  assert.deepEqual(mutations, [], "no run/outcome/case/audit/engine mutation occurred");
  assert.deepEqual(await deps.cases.listCases({}), [existing], "existing case state is unchanged");
  assert.deepEqual(await deps.outcomes.listOutcomes(existing.lastRunId), [], "existing outcome state is unchanged");
  assert.deepEqual(await deps.runStore.listRuns(), [], "run count is unchanged");
});

test("rerunToVerify — the year rule follows the rerun's own engine, not process.env's routing", async () => {
  // This file routes nothing through process.env; the engine below routes cms122, as an engine built from
  // a worker env would. An earlier year's case must still be verified as of that year's last day.
  assert.equal(process.env.WORKWELL_OFFICIAL_MEASURES ?? "", "");
  const lastYear: CaseRecord = { ...existing, id: "case-122-2025", employeeId: "emp-001", measureId: "cms122", evaluationPeriod: "2025-01-01" };
  const asked: string[] = [];
  let created: Record<string, unknown> | null = null;
  const noop = async () => undefined;
  const deps = {
    cases: { getCase: async () => lastYear, patchCase: async (_id: string, patch: Record<string, unknown>) => ({ ...lastYear, ...patch }) },
    events: { recordCaseEvent: noop, appendAudit: noop, caseTimeline: async () => [], latestOutreachDeliveryStatus: async () => null },
    outcomes: { recordOutcome: noop, listOutcomes: async () => [] },
    runStore: { createRun: async (input: Record<string, unknown>) => { created = input; return { id: "run-122" }; }, markRunning: noop, appendLog: noop, finalizeRun: noop },
    engine: {
      evaluate: async (input: { evaluationDate: string }) => { asked.push(input.evaluationDate); return { outcome: "OVERDUE", evidence: { expressionResults: [] } }; },
      logicFor: () => ({ version: "v", kind: "official" as const, warning: null }),
    },
  } as unknown as RerunDeps;

  await rerunToVerify(deps, lastYear.id, "tester");
  assert.deepEqual(asked, ["2025-12-31"]);
  assert.equal((created as Record<string, unknown> | null)?.measurementPeriodStart, "2025-01-01T00:00:00.000Z", "the official calendar year, not a one-day window");
});

// ---- #882: a case whose cycle has ended ---------------------------------------------------------

/** A re-check over fakes that logs, in order, every audit and patch, and keeps the run it created. */
function earlierCycleHarness(c: CaseRecord, outcome: string) {
  const calls: string[] = [];
  const audits: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  let created: Record<string, unknown> | null = null;
  let finalStatus = "";
  let current = c;
  const noop = async () => undefined;
  const deps = {
    cases: {
      getCase: async () => current,
      patchCase: async (_id: string, patch: Record<string, unknown>) => {
        calls.push(`patch:${Object.keys(patch).sort().join(",")}`);
        current = { ...current, ...patch } as CaseRecord;
        return current;
      },
    },
    events: {
      recordCaseEvent: async (e: { audit: { eventType: string; payload: Record<string, unknown> } }) => { calls.push(`audit:${e.audit.eventType}`); audits.push(e.audit); },
      appendAudit: async (a: { eventType: string; payload: Record<string, unknown> }) => { calls.push(`audit:${a.eventType}`); audits.push(a); },
      caseTimeline: async () => [],
      latestOutreachDeliveryStatus: async () => null,
    },
    outcomes: { recordOutcome: noop, listOutcomes: async () => [] },
    runStore: {
      createRun: async (input: Record<string, unknown>) => { created = input; return { id: "run-verify" }; },
      markRunning: noop,
      appendLog: noop,
      finalizeRun: async (_id: string, status: string) => { finalStatus = status; },
    },
    engine: { evaluate: async () => ({ outcome, evidence: { expressionResults: [] } }) },
  } as unknown as RerunDeps;
  return { deps, calls, audits, created: () => created as Record<string, unknown> | null, finalStatus: () => finalStatus, current: () => current };
}

// 2025 has ended in any year this suite runs.
const rolledOver: CaseRecord = {
  ...existing, id: "case-2025", employeeId: "emp-001", evaluationPeriod: "2025-01-01", status: "RESOLVED",
  closedAt: "2026-01-01T12:05:00.000Z", closedReason: "CYCLE_ROLLED_OVER", closedBy: null, currentOutcomeStatus: "OVERDUE",
};

test("rerunToVerify (#882) — a rolled-over case found in a gap stays closed and shows the result, audit first", async () => {
  const h = earlierCycleHarness({ ...rolledOver, currentOutcomeStatus: "DUE_SOON" }, "OVERDUE");
  const detail = await rerunToVerify(h.deps, rolledOver.id, "lead@example.test");
  assert.deepEqual(h.calls, ["audit:CASE_RERUN_VERIFIED", "patch:currentOutcomeStatus,lastRunId"], "recorded before the case moves, and never reopened");
  assert.equal(h.current().status, "RESOLVED");
  assert.equal(h.current().closedReason, "CYCLE_ROLLED_OVER");
  assert.equal(h.current().currentOutcomeStatus, "OVERDUE", "the case shows what the re-check found");
  assert.equal(h.current().lastRunId, "run-verify");
  assert.equal(h.audits[0]!.payload.earlierCycle, true);
  assert.equal(h.audits[0]!.payload.verifiedStatus, "OVERDUE");
  assert.equal(h.audits[0]!.payload.caseUnchanged, undefined);
  assert.equal((h.created()!.requestedScope as Record<string, unknown>).earlierCycle, true, "its run is marked");
  assert.equal(h.finalStatus(), "COMPLETED");
  assert.ok(detail);
});

test("rerunToVerify (#882) — a staff closure of a cycle that has ended is not touched; the timeline has the result", async () => {
  const staffClosed: CaseRecord = { ...rolledOver, status: "CLOSED", closedReason: "MANUAL_RESOLVE", closedBy: "nurse@example.test" };
  const h = earlierCycleHarness(staffClosed, "OVERDUE");
  await rerunToVerify(h.deps, staffClosed.id, "lead@example.test");
  assert.deepEqual(h.calls, ["audit:CASE_RERUN_VERIFIED"], "no patch: its outcome is frozen at closure");
  assert.deepEqual(h.current(), staffClosed);
  assert.equal(h.audits[0]!.payload.caseUnchanged, true);
  assert.equal(h.audits[0]!.payload.verifiedStatus, "OVERDUE");
});

test("rerunToVerify (#882) — an ACTIVE case of a cycle that has ended still resolves as before", async () => {
  const h = earlierCycleHarness({ ...rolledOver, status: "OPEN", closedAt: null, closedReason: null }, "COMPLIANT");
  await rerunToVerify(h.deps, rolledOver.id, "lead@example.test");
  assert.equal(h.current().status, "RESOLVED");
  assert.ok(h.calls.includes("audit:CASE_RESOLVED"), "the ordinary resolution, audited");
  assert.equal((h.created()!.requestedScope as Record<string, unknown>).earlierCycle, true, "the run is still marked");
});
