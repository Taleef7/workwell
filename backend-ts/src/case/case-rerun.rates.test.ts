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

/**
 * The action a rerun writes is SYSTEM-owned, not the operator's (ADR-076 d2 — review finding).
 *
 * `patchCase` marks an action OPERATOR by default, which is right for escalate, manual resolve and an
 * outreach send: a person wrote those words. Rerun-to-verify is different — `verificationNextAction`
 * returns `nextActionFor(...)`, the exact string the nightly run computes — and marking it OPERATOR
 * would FREEZE it: `planNextAction` preserves an operator action while the status is re-confirmed, so
 * this very case (still OVERDUE, missed rate moving from Engagement back to Initiation next month)
 * would keep saying Engagement forever. That is the ADR-074 d13 behaviour ADR-076 d2 promises it does
 * not touch, and every case ever reverified would also stop receiving wording-table edits.
 */
test("rerun-to-verify hands the action back to the SYSTEM, so the rate can keep moving", async () => {
  const { rerunToVerify } = await import("./case-rerun.ts");
  let patched: Record<string, unknown> | null = null;
  const noop = async () => undefined;
  const deps = {
    cases: {
      getCase: async () => existing,
      patchCase: async (_id: string, patch: Record<string, unknown>) => { patched = patch; return { ...existing, ...patch }; },
      listCases: async () => [existing],
      upsertFromOutcome: noop,
      countByLastRun: async () => 1,
    },
    events: { recordCaseEvent: noop, appendAudit: noop, caseTimeline: async () => [], latestOutreachDeliveryStatus: async () => null },
    outcomes: { recordOutcome: noop, listOutcomes: async () => [] },
    runStore: { createRun: async () => ({ id: "run-rerun" }), markRunning: noop, appendLog: noop, finalizeRun: noop, listRuns: async () => [] },
    engine: { evaluate: async () => ({ outcome: "OVERDUE", evidence: NOT_ENGAGED }) },
  } as unknown as RerunDeps;

  await rerunToVerify(deps, existing.id, "tester");

  assert.equal(
    (patched as Record<string, unknown> | null)?.nextActionSource,
    "SYSTEM",
    "a computed action must say so, or patchCase's OPERATOR default freezes it",
  );
});

test("rerun-to-verify closes a case whose subject the OFFICIAL logic finds outside the initial population, as a system closure (ADR-078)", async () => {
  const { rerunToVerify } = await import("./case-rerun.ts");
  const OUTSIDE = {
    expressionResults: [],
    official: { ecqmId: "CMS137", populationResults: rate(false).map((p) => ({ ...p, result: false })), measurementPeriod: { start: "2026-01-01", end: "2026-12-31" } },
  };
  let patched: Record<string, unknown> | null = null;
  const audits: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
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
      recordCaseEvent: noop,
      appendAudit: async (input: { eventType: string; payload: Record<string, unknown> }) => { audits.push({ eventType: input.eventType, payload: input.payload }); },
      caseTimeline: async () => [],
      latestOutreachDeliveryStatus: async () => null,
    },
    outcomes: { recordOutcome: noop, listOutcomes: async () => [] },
    runStore: { createRun: async () => ({ id: "run-rerun-oop" }), markRunning: noop, appendLog: noop, finalizeRun: noop, listRuns: async () => [] },
    engine: {
      evaluate: async () => ({ outcome: "MISSING_DATA", evidence: OUTSIDE, inInitialPopulation: false }),
      logicVersionFor: () => "official-fqm:1.0.000:artifact:terminology",
    },
  } as unknown as RerunDeps;

  await rerunToVerify(deps, existing.id, "tester");
  const p = patched as Record<string, unknown> | null;
  assert.ok(p, "the case was patched");
  assert.equal(p!.status, "RESOLVED");
  assert.equal(p!.closedReason, "OUT_OF_POPULATION");
  assert.equal(p!.closedBy, null, "the system's determination, not the operator's closure — a later in-population outcome may reopen it");
  assert.ok(String(p!.nextAction).includes("not in the measure's initial population"));
  assert.ok(audits.some((a) => a.eventType === "CASE_RESOLVED" && a.payload.closedReason === "OUT_OF_POPULATION"), "the closure is audited with its reason");

  // The AUTHORED engine's flag does not close anything through this path either.
  patched = null;
  audits.length = 0;
  const authored = { ...deps, engine: { evaluate: async () => ({ outcome: "MISSING_DATA", evidence: { expressionResults: [] }, inInitialPopulation: false }), logicVersionFor: () => "sha256:authored" } } as unknown as RerunDeps;
  await rerunToVerify(authored, existing.id, "tester");
  assert.equal((patched as Record<string, unknown> | null)?.status, "OPEN", "an authored out-of-population subject keeps the case open, unchanged");
});
