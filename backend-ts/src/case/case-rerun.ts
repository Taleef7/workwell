/**
 * Rerun-to-verify (#107) — TS port of CaseFlowService.rerunToVerify (the CASE run scope).
 *
 * Re-evaluates the case subject through the JVM-free CQL engine for the case's measure +
 * evaluation period, persists a verification run + outcome + logs, records the action and
 * audit ledger, and transitions the case (COMPLIANT → RESOLVED, EXCLUDED → EXCLUDED, else
 * stays open). Because the synthetic engine is deterministic per (subject, measure), a
 * non-compliant case re-confirms its status on rerun — same behaviour as the Java demo.
 *
 * Waiver auto-linkage on the EXCLUDED branch is deferred (waivers live in the admin module,
 * #108); the exclusion still closes the case with closed_reason RERUN_EXCLUDED.
 */
import type { CaseRecord, CaseStore } from "../stores/case-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import type { RunStore } from "../stores/run-store.ts";
import type { EvaluateMeasureBinding } from "@work-well/measure-engine";
import {
  employeeById,
  type EmployeeProfile,
  evaluableEmployees,
  isRunnableMeasure,
} from "../config/deployment-profile.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { compositeBundleSource } from "../wiring/subject-bundle-source.ts";
import { ACTIVE_CASE_STATUSES, priorityFor, nextActionFor } from "./case-logic.ts";
import { toCaseDetail, type CaseDetail } from "./case-detail-read-model.ts";
import { caseRerunEvaluationDate, caseRerunMeasurementPeriod } from "../run/run-period.ts";
import { isFqmScored, type RoutedEngine } from "../wiring/executor-router.ts";
import { outcomeForCase } from "./case-outcome.ts";
import { practiceToday } from "../config/practice-date.ts";
import { isEarlierCycle } from "../run/compliance-period.ts";

export interface RerunDeps {
  cases: CaseStore;
  events: CaseEventStore;
  outcomes: OutcomeStore;
  runStore: RunStore;
  /** `logicFor` is optional because the authored engine has none: every unrouted measure reads it as absent. */
  engine: EvaluateMeasureBinding & Partial<Pick<RoutedEngine, "logicFor">>;
  employees?: readonly EmployeeProfile[];
}

export class UnsupportedCaseRerunError extends Error {
  readonly code = "unsupported_scope";
  constructor(message = "Live WebChart CASE rerun-to-verify is not supported until fetch-one-patient is available.") {
    super(message);
    this.name = "UnsupportedCaseRerunError";
  }
}

/**
 * The verification ran and the engine threw. The attempt is already recorded (outcome, audit, a
 * PARTIAL_FAILURE run) and the case is unchanged; callers must report a failure, never a completed rerun.
 */
export class CaseRerunFailedError extends Error {
  readonly code = "verification_failed";
  constructor(
    readonly runId: string,
    message = "Verification failed: the CQL engine returned no answer. The case was left unchanged.",
  ) {
    super(message);
    this.name = "CaseRerunFailedError";
  }
}

const verificationCaseStatus = (current: string, verified: string): string =>
  verified === "COMPLIANT"
    ? "RESOLVED"
    : verified === "EXCLUDED"
      ? "EXCLUDED"
      : current === "OPEN" || current === "IN_PROGRESS"
        ? current
        : "OPEN";

// `evidence` is the FRESH outcome's evidence_json: a multi-rate measure's action names the rate the
// subject missed (ADR-074 d13), and a rerun that dropped it reverted the case to the combined wording.
const verificationNextAction = (verified: string, measureId: string, evidence: unknown): string =>
  verified === "COMPLIANT" ? "No follow-up needed after compliant verification rerun." : nextActionFor(verified, measureId, evidence);

/**
 * Whether the rerun's own engine scores this measure with official logic: the router defines `logicFor`
 * for a routed measure and answers `undefined` otherwise, so the period and date follow what will run.
 * An engine without `logicFor` (the authored one) routes nothing; a `logicFor` that throws is a routed
 * measure whose artifact failed, which the evaluation below then reports.
 */
function routedOfficially(engine: RerunDeps["engine"], measureId: string, today: string): boolean {
  if (!engine.logicFor) return false;
  try {
    return engine.logicFor(measureId, today) !== undefined;
  } catch {
    return true;
  }
}

const isClosing = (verified: string): boolean => verified === "COMPLIANT" || verified === "EXCLUDED";

/** Re-evaluate the case subject and transition the case; returns the refreshed detail, or null if unknown. */
export async function rerunToVerify(deps: RerunDeps, caseId: string, actor: string): Promise<CaseDetail | null> {
  const existing = await deps.cases.getCase(caseId);
  if (!existing) return null;
  // A wc subject has no synthetic target and phase 1 deliberately has no fetch-one-patient path.
  // Reject before creating a run or writing outcomes/case/audit state: stale population bundles are
  // never reused and a fabricated MISSING_DATA verification is never persisted.
  if (existing.employeeId.startsWith("wc|")) throw new UnsupportedCaseRerunError();
  const employees = deps.employees ?? evaluableEmployees();
  const employee = employeeById(existing.employeeId);
  // Unknown subject/measure can't be verified — leave the case untouched (no state change).
  // isRunnableMeasure alone (not a binding check): official-only ids are runnable without a binding.
  if (!employee || !isRunnableMeasure(existing.measureId)) return null;

  // Re-evaluate AS-OF today so the day-math (days overdue, etc.) is CURRENT, while the outcome
  // stays keyed to the case's existing compliance-cycle period (`existing.evaluationPeriod`, the
  // idempotency key, used unchanged below). Decoupling the two is the #150 H1/M6 fix: the period
  // buckets the cycle (so rerun upserts, never duplicates); the eval date drives the numbers.
  // Mirrors the Java rerunToVerify (`LocalDate evaluationDate = LocalDate.now()`), except that an
  // official measure's case from an earlier year is verified as of that year's last day: the official
  // period and logic follow the evaluation date's year, and the case is that year's.
  const today = practiceToday();
  const official = routedOfficially(deps.engine, existing.measureId, today);
  const evalDate = caseRerunEvaluationDate(official, existing.evaluationPeriod, today);
  const period = caseRerunMeasurementPeriod(existing.measureId, evalDate, official);
  // #882 (LOCKED_DECISIONS §4A.10): a case of a cycle that has ended. Its re-check records the result and
  // never reopens it, and its run is nobody's "latest" (the marker, `run/earlier-cycle.ts`), so a
  // re-checked 2026 case never becomes the patient's current answer in January.
  const earlierCycle = isEarlierCycle(existing.measureId, existing.evaluationPeriod, today);
  const heldClosed = earlierCycle && !(ACTIVE_CASE_STATUSES as readonly string[]).includes(existing.status);

  const run = await deps.runStore.createRun({
    scopeType: "CASE",
    scopeId: existing.measureId,
    triggeredBy: actor,
    requestedScope: {
      caseId, measureId: existing.measureId, employeeExternalId: existing.employeeId, evaluationDate: evalDate, today,
      ...(earlierCycle ? { earlierCycle: true } : {}),
    },
    measurementPeriodStart: period.start,
    measurementPeriodEnd: period.end,
  });
  await deps.runStore.markRunning(run.id);
  await deps.runStore.appendLog(run.id, "INFO", "Case loaded for rerun-to-verify.");
  await deps.runStore.appendLog(run.id, "INFO", `Subject resolved for rerun-to-verify: ${existing.employeeId}.`);
  await deps.runStore.appendLog(run.id, "INFO", "Scoped CQL verification started.");

  // Deterministic per-subject target (same seed the original run used) → idempotent rerun.
  const bundleSource = compositeBundleSource(process.env as Record<string, unknown>);
  const target = bundleSource.targetFor(employees, existing.measureId, existing.employeeId) ?? "MISSING_DATA";
  const bundle = bundleSource.bundleFor(employee, existing.measureId, target, evalDate);

  let verifiedStatus: string;
  let evidence: unknown;
  // ADR-078: the OFFICIAL logic found the subject outside the initial population. The nightly run closes
  // such a case under OUT_OF_POPULATION; a rerun-to-verify must reach the same answer, or the operator's
  // own click leaves the case open until the next night (Gemini review). Authored measures set the flag
  // too and are deliberately not read here — same gate as the pipeline.
  // UNDEFINED until the official logic answers — the same rule as the pipeline (ADR-079): `false`
  // asserts "evaluated, and inside the population", which an engine failure has not established.
  // The case decision below reads it as falsy either way, so only the PERSISTED row changes.
  let outOfPopulation: boolean | undefined;
  try {
    const result = await deps.engine.evaluate({ measureId: existing.measureId, patientBundle: bundle, evaluationDate: evalDate });
    verifiedStatus = result.outcome;
    evidence = result.evidence;
    // The date the evaluation used, so the answer describes the logic that just ran (a 2026 case
    // verified during 2027 is evaluated as of 2026-12-31, by 2026's logic).
    outOfPopulation = isFqmScored(deps.engine.logicFor?.(existing.measureId, evalDate))
      ? result.inInitialPopulation === false
      : undefined;
  } catch (err) {
    verifiedStatus = "MISSING_DATA";
    evidence = { evaluationError: "engine failure", message: String((err as Error)?.message ?? err) };
  }
  const hasEvaluationError = !!(evidence as { evaluationError?: unknown })?.evaluationError;
  await deps.runStore.appendLog(run.id, "INFO", `Scoped CQL verification completed with status ${verifiedStatus}.`);
  await deps.outcomes.recordOutcome({
    runId: run.id,
    subjectId: existing.employeeId,
    measureId: existing.measureId,
    evaluationPeriod: existing.evaluationPeriod,
    status: verifiedStatus,
    evidence,
    // The same flag this rerun already read to decide the case, recorded on the row too (ADR-079) —
    // a CASE-scope run is never a read model's winner, but its row outlives the run and is read
    // back by the per-subject history surfaces.
    outOfPopulation,
  });

  // A verification that threw is not a verdict. Before this branch its MISSING_DATA reopened a closed
  // case and overwrote an open one's outcome. The attempt is recorded (audit first, as everywhere) and
  // the run is PARTIAL_FAILURE, but the case is left exactly as it was.
  if (hasEvaluationError) {
    const failedPayload = {
      priorOutcomeStatus: existing.currentOutcomeStatus,
      verifiedStatus,
      runId: run.id,
      subjectId: existing.employeeId,
      evaluationPeriod: existing.evaluationPeriod,
      status: existing.status,
      caseUnchanged: true,
    };
    await deps.events.recordCaseEvent({
      action: { caseId, actionType: "RERUN_TO_VERIFY", actor, payload: failedPayload },
      audit: {
        eventType: "CASE_RERUN_FAILED",
        entityType: "case",
        entityId: caseId,
        actor,
        refRunId: run.id,
        refCaseId: caseId,
        refMeasureVersionId: existing.measureId,
        payload: failedPayload,
      },
    });
    await deps.runStore.appendLog(run.id, "WARN", "Verification failed; the case was left unchanged.");
    await deps.runStore.finalizeRun(run.id, "PARTIAL_FAILURE");
    throw new CaseRerunFailedError(run.id);
  }

  if (heldClosed) return recordEarlierCycleResult(deps, existing, caseId, actor, run.id, verifiedStatus);

  const updatedCaseStatus = outOfPopulation ? "RESOLVED" : verificationCaseStatus(existing.status, verifiedStatus);
  const nextAction = outOfPopulation
    ? "No follow-up needed: not in the measure's initial population on verification rerun."
    : verificationNextAction(verifiedStatus, existing.measureId, evidence);
  const closing = isClosing(verifiedStatus) || outOfPopulation;
  const closedAt = closing ? new Date().toISOString() : null;
  const closedReason =
    verifiedStatus === "COMPLIANT" ? "RERUN_VERIFIED" : verifiedStatus === "EXCLUDED" ? "RERUN_EXCLUDED" : outOfPopulation ? "OUT_OF_POPULATION" : null;
  // An out-of-population closure is the SYSTEM's determination even when a person clicked rerun: it
  // stays `closed_by = NULL` so a later in-population outcome reopens it, exactly as the nightly path
  // closes it. A verified COMPLIANT/EXCLUDED is the operator's closure and keeps their name.
  const closedBy = closing && !outOfPopulation ? actor : null;

  const actionPayload = {
    priorOutcomeStatus: existing.currentOutcomeStatus,
    verifiedStatus,
    runId: run.id,
    subjectId: existing.employeeId,
    evaluationPeriod: existing.evaluationPeriod,
  };
  const verificationPayload = {
    ...actionPayload,
    status: updatedCaseStatus,
    nextAction,
  };
  // Atomic action + audit BEFORE the patch (upholds the audit invariant under partial failure).
  await deps.events.recordCaseEvent({
    action: { caseId, actionType: "RERUN_TO_VERIFY", actor, payload: actionPayload },
    audit: {
      eventType: "CASE_RERUN_VERIFIED",
      entityType: "case",
      entityId: caseId,
      actor,
      refRunId: run.id,
      refCaseId: caseId,
      refMeasureVersionId: existing.measureId,
      payload: verificationPayload,
    },
  });
  await deps.cases.patchCase(caseId, {
    status: updatedCaseStatus,
    priority: priorityFor(verifiedStatus),
    nextAction,
    // SYSTEM, explicitly. `patchCase` is the operator surface and marks an action OPERATOR-owned by
    // default (ADR-076 d2) — right for escalate, manual resolve and outreach, where a person wrote the
    // words. This action is not that: `verificationNextAction` returns `nextActionFor(...)`, the very
    // string a run would compute. Marking it OPERATOR would freeze it: `planNextAction` preserves an
    // operator action while the status is re-confirmed, so a rerun-to-verify on a still-OVERDUE
    // multi-rate case would pin the rate it missed THAT day and never follow the rate moving
    // afterwards — breaking exactly the ADR-074 d13 behaviour ADR-076 d2 promises is untouched. Every
    // case that had ever been reverified would also stop receiving wording-table edits.
    nextActionSource: "SYSTEM",
    currentOutcomeStatus: verifiedStatus,
    lastRunId: run.id,
    closedAt,
    closedReason,
    closedBy,
  });
  await deps.runStore.appendLog(run.id, "INFO", `Case updated from ${existing.status} to ${updatedCaseStatus}.`);

  if (verifiedStatus === "COMPLIANT") {
    await deps.events.appendAudit({
      eventType: "CASE_RESOLVED",
      entityType: "case",
      entityId: caseId,
      actor,
      refRunId: run.id,
      refCaseId: caseId,
      refMeasureVersionId: existing.measureId,
      payload: { status: "COMPLIANT", summary: "Case closed by rerun-to-verify after real CQL verification.", runId: run.id },
    });
  } else if (verifiedStatus === "EXCLUDED") {
    await deps.events.appendAudit({
      eventType: "CASE_EXCLUDED",
      entityType: "case",
      entityId: caseId,
      actor,
      refRunId: run.id,
      refCaseId: caseId,
      refMeasureVersionId: existing.measureId,
      payload: { ...verificationPayload, exclusionReason: "Excluded on verification rerun." },
    });
  } else if (outOfPopulation) {
    await deps.events.appendAudit({
      eventType: "CASE_RESOLVED",
      entityType: "case",
      entityId: caseId,
      actor,
      refRunId: run.id,
      refCaseId: caseId,
      refMeasureVersionId: existing.measureId,
      payload: { ...verificationPayload, closedReason: "OUT_OF_POPULATION", summary: "Case closed by rerun-to-verify: the subject is outside the measure's initial population (ADR-078).", runId: run.id },
    });
  }

  await deps.runStore.finalizeRun(run.id, "COMPLETED");
  return buildDetail(deps, caseId);
}

/**
 * The re-check of a closed case whose cycle has ended (#882): the result is recorded and the case stays
 * closed. A person's closure is not touched at all: its outcome is frozen at closure (DATA_MODEL §4) and
 * the timeline row carries the new result. A system closure (rolled over, auto-resolved, excluded, out
 * of population) shows the new result: only `currentOutcomeStatus` and `lastRunId` move, after the audit.
 */
async function recordEarlierCycleResult(
  deps: RerunDeps,
  existing: CaseRecord,
  caseId: string,
  actor: string,
  runId: string,
  verifiedStatus: string,
): Promise<CaseDetail | null> {
  const staffClosed = existing.closedBy != null;
  const payload = {
    priorOutcomeStatus: existing.currentOutcomeStatus,
    verifiedStatus,
    runId,
    subjectId: existing.employeeId,
    evaluationPeriod: existing.evaluationPeriod,
    status: existing.status,
    earlierCycle: true,
    ...(staffClosed ? { caseUnchanged: true } : {}),
  };
  await deps.events.recordCaseEvent({
    action: { caseId, actionType: "RERUN_TO_VERIFY", actor, payload },
    audit: {
      eventType: "CASE_RERUN_VERIFIED",
      entityType: "case",
      entityId: caseId,
      actor,
      refRunId: runId,
      refCaseId: caseId,
      refMeasureVersionId: existing.measureId,
      payload,
    },
  });
  if (!staffClosed) await deps.cases.patchCase(caseId, { currentOutcomeStatus: verifiedStatus, lastRunId: runId });
  await deps.runStore.appendLog(
    runId,
    "INFO",
    `The case's cycle (${existing.evaluationPeriod}) has ended: the result ${verifiedStatus} is recorded and the case stays ${existing.status}.`,
  );
  await deps.runStore.finalizeRun(runId, "COMPLETED");
  return buildDetail(deps, caseId);
}

async function buildDetail(deps: RerunDeps, caseId: string): Promise<CaseDetail | null> {
  const c = await deps.cases.getCase(caseId);
  if (!c) return null;
  const outcome = await outcomeForCase(deps.outcomes, c.lastRunId, c.employeeId, c.measureId, c.evaluationPeriod);
  const timeline = await deps.events.caseTimeline(caseId);
  const latest = await deps.events.latestOutreachDeliveryStatus(caseId);
  return toCaseDetail(c, outcome, timeline, latest);
}
