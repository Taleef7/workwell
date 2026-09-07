/**
 * Rerun-to-verify keeps the rate-aware next action (ADR-074 d13; MM-1 U3 review finding).
 *
 * The nightly upsert words a multi-rate case's `next_action` from the outcome's persisted rates — an
 * initiated-but-not-engaged cms137 patient gets the Engagement action. Rerun-to-verify re-evaluates the
 * same patient and rewrites `next_action` from the fresh outcome; a rerun path that dropped the evidence
 * on the floor reverted the case to the combined wording ("confirm initiation … and engagement") and
 * recorded that in the audit payload, contradicting the chart for a patient who HAD initiated. Staff
 * press "Rerun to verify" precisely on the patients they are working, so this is the wording they see.
 *
 * Runs as the MAUI profile: cms137 is runnable only where a profile lists it (ADR-072), and the profile
 * is read once at module load, so the env is set before the first import and the modules are imported
 * dynamically. The engine is stubbed; the corpus builds the real bundle for `pat-001`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CaseRecord } from "../stores/case-store.ts";
import type { RerunDeps } from "./case-rerun.ts";

process.env.WORKWELL_INSTANCE = "maui";
process.env.WORKWELL_OFFICIAL_MEASURES = "cms122,cms125,cms137";

const rate = (numer: boolean) => [
  { populationType: "initial-population", result: true },
  { populationType: "denominator", result: true },
  { populationType: "denominator-exclusion", result: false },
  { populationType: "denominator-exception", result: false },
  { populationType: "numerator", result: numer },
];
/** Initiated (rate 1 met), not engaged (rate 2 missed) — the 8-of-45 shape in the steward's deck. */
const NOT_ENGAGED = {
  expressionResults: [],
  official: { ecqmId: "CMS137", populationResults: rate(true), rates: [rate(true), rate(false)], measurementPeriod: { start: "2026-01-01", end: "2026-12-31" } },
};

const existing: CaseRecord = {
  id: "case-137", employeeId: "pat-001", measureId: "cms137", evaluationPeriod: "2026-01-01",
  status: "OPEN", priority: "HIGH", assignee: null, nextAction: "stale", nextActionSource: "SYSTEM", currentOutcomeStatus: "OVERDUE",
  lastRunId: "run-existing", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  closedAt: null, closedReason: null, closedBy: null,
};

test("rerun-to-verify words next_action from the fresh outcome's rates, in the case row and in the audit payload", async () => {
  const { rerunToVerify } = await import("./case-rerun.ts");
  let patched: Record<string, unknown> | null = null;
  let auditPayload: Record<string, unknown> | null = null;
  const noop = async () => undefined;
  const deps = {
    cases: {
      getCase: async () => existing,
      patchCase: async (_id: string, patch: Record<string, unknown>) => { patched = patch; return { ...existing, ...patch }; },
      listCases: async () => [existing],
      upsertFromOutcome: noop,
      countByLastRun: async () => 1,
    },
    events: {
      recordCaseEvent: async (input: { audit: { payload: Record<string, unknown> } }) => { auditPayload = input.audit.payload; },
      appendAudit: noop,
      caseTimeline: async () => [],
      latestOutreachDeliveryStatus: async () => null,
    },
    outcomes: { recordOutcome: noop, listOutcomes: async () => [] },
    runStore: { createRun: async () => ({ id: "run-rerun" }), markRunning: noop, appendLog: noop, finalizeRun: noop, listRuns: async () => [] },
    engine: { evaluate: async () => ({ outcome: "OVERDUE", evidence: NOT_ENGAGED }) },
  } as unknown as RerunDeps;

  await rerunToVerify(deps, existing.id, "tester");

  assert.ok(patched, "the case was patched (the profile lists cms137 and the routing env routes it)");
  const nextAction = String((patched as Record<string, unknown>).nextAction);
  assert.match(nextAction, /engagement|follow-up/i, "the Engagement rate is the one missed");
  assert.doesNotMatch(nextAction, /confirm initiation/i, "the combined wording would tell staff to confirm an initiation that happened");
  assert.equal((auditPayload as Record<string, unknown> | null)?.nextAction, nextAction, "the audit payload records the same wording");
});
