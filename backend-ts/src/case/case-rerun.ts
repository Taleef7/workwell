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
import type { CaseStore } from "../stores/case-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import type { RunStore } from "../stores/run-store.ts";
import type { EvaluateMeasureBinding } from "@work-well/measure-engine";
import {
  employeeById,
  type EmployeeProfile,
  EVALUABLE_EMPLOYEES,
  isRunnableMeasure,
} from "../config/deployment-profile.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { compositeBundleSource } from "../wiring/subject-bundle-source.ts";
import { priorityFor, nextActionFor } from "./case-logic.ts";
import { toCaseDetail, type CaseDetail } from "./case-detail-read-model.ts";
import { caseRerunMeasurementPeriod } from "../run/run-period.ts";

export interface RerunDeps {
  cases: CaseStore;
  events: CaseEventStore;
  outcomes: OutcomeStore;
  runStore: RunStore;
  engine: EvaluateMeasureBinding;
  employees?: readonly EmployeeProfile[];
}

export class UnsupportedCaseRerunError extends Error {
  readonly code = "unsupported_scope";
  constructor(message = "Live WebChart CASE rerun-to-verify is not supported until fetch-one-patient is available.") {
    super(message);
    this.name = "UnsupportedCaseRerunError";
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

const verificationNextAction = (verified: string, measureId: string): string =>
  verified === "COMPLIANT" ? "No follow-up needed after compliant verification rerun." : nextActionFor(verified, measureId);

const isClosing = (verified: string): boolean => verified === "COMPLIANT" || verified === "EXCLUDED";

/** Re-evaluate the case subject and transition the case; returns the refreshed detail, or null if unknown. */
export async function rerunToVerify(deps: RerunDeps, caseId: string, actor: string): Promise<CaseDetail | null> {
  const existing = await deps.cases.getCase(caseId);
  if (!existing) return null;
  // A wc subject has no synthetic target and phase 1 deliberately has no fetch-one-patient path.
  // Reject before creating a run or writing outcomes/case/audit state: stale population bundles are
  // never reused and a fabricated MISSING_DATA verification is never persisted.
  if (existing.employeeId.startsWith("wc|")) throw new UnsupportedCaseRerunError();
  const employees = deps.employees ?? EVALUABLE_EMPLOYEES;
  const employee = employeeById(existing.employeeId);
  // Unknown subject/measure can't be verified — leave the case untouched (no state change).
  // isRunnableMeasure alone (not a binding check): official-only ids are runnable without a binding.
  if (!employee || !isRunnableMeasure(existing.measureId)) return null;

  // Re-evaluate AS-OF today so the day-math (days overdue, etc.) is CURRENT, while the outcome
  // stays keyed to the case's existing compliance-cycle period (`existing.evaluationPeriod`, the
  // idempotency key, used unchanged below). Decoupling the two is the #150 H1/M6 fix: the period
  // buckets the cycle (so rerun upserts, never duplicates); the eval date drives the numbers.
  // Mirrors the Java rerunToVerify (`LocalDate evaluationDate = LocalDate.now()`).
  const evalDate = new Date().toISOString().slice(0, 10);
  const period = caseRerunMeasurementPeriod(existing.measureId, evalDate);

  const run = await deps.runStore.createRun({
    scopeType: "CASE",
    scopeId: existing.measureId,
    triggeredBy: actor,
    requestedScope: { caseId, measureId: existing.measureId, employeeExternalId: existing.employeeId, evaluationDate: evalDate },
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
  try {
    const result = await deps.engine.evaluate({ measureId: existing.measureId, patientBundle: bundle, evaluationDate: evalDate });
    verifiedStatus = result.outcome;
    evidence = result.evidence;
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
  });

  const updatedCaseStatus = verificationCaseStatus(existing.status, verifiedStatus);
  const nextAction = verificationNextAction(verifiedStatus, existing.measureId);
  const closing = isClosing(verifiedStatus);
  const closedAt = closing ? new Date().toISOString() : null;
  const closedReason = verifiedStatus === "COMPLIANT" ? "RERUN_VERIFIED" : verifiedStatus === "EXCLUDED" ? "RERUN_EXCLUDED" : null;
  const closedBy = closing ? actor : null;

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
  }

  await deps.runStore.finalizeRun(run.id, hasEvaluationError ? "PARTIAL_FAILURE" : "COMPLETED");
  return buildDetail(deps, caseId);
}

async function buildDetail(deps: RerunDeps, caseId: string): Promise<CaseDetail | null> {
  const c = await deps.cases.getCase(caseId);
  if (!c) return null;
  const outcomes = await deps.outcomes.listOutcomes(c.lastRunId);
  const outcome = outcomes.find((o) => o.subjectId === c.employeeId && o.measureId === c.measureId) ?? null;
  const timeline = await deps.events.caseTimeline(caseId);
  const latest = await deps.events.latestOutreachDeliveryStatus(caseId);
  return toCaseDetail(c, outcome, timeline, latest);
}
