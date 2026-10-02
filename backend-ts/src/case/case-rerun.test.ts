import { test } from "node:test";
import assert from "node:assert/strict";
import { rerunToVerify, type RerunDeps } from "./case-rerun.ts";
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

  const detail = await rerunToVerify(deps, closed.id, "tester");
  assert.ok(detail, "the case detail is still returned");
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
