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
import type { EvaluateMeasureBinding } from "../engine/evaluate-measure.ts";
import { EMPLOYEES, employeeById, type EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { deriveExamConfig } from "../engine/synthetic/exam-config.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { seededTargetFor } from "../run/distribution.ts";
import { priorityFor, nextActionFor } from "./case-logic.ts";
import { toCaseDetail, type CaseDetail } from "./case-detail-read-model.ts";

export interface RerunDeps {
  cases: CaseStore;
  events: CaseEventStore;
  outcomes: OutcomeStore;
  runStore: RunStore;
  engine: EvaluateMeasureBinding;
  employees?: readonly EmployeeProfile[];
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
  const employees = deps.employees ?? EMPLOYEES;
  const employee = employeeById(existing.employeeId);
  const binding = MEASURE_BINDINGS[existing.measureId];
  // Unknown subject/measure can't be verified — leave the case untouched (no state change).
  if (!employee || !binding) return null;

  // Re-evaluate AS-OF today so the day-math (days overdue, etc.) is CURRENT, while the outcome
  // stays keyed to the case's existing compliance-cycle period (`existing.evaluationPeriod`, the
  // idempotency key, used unchanged below). Decoupling the two is the #150 H1/M6 fix: the period
  // buckets the cycle (so rerun upserts, never duplicates); the eval date drives the numbers.
  // Mirrors the Java rerunToVerify (`LocalDate evaluationDate = LocalDate.now()`).
  const evalDate = new Date().toISOString().slice(0, 10);
  const periodStart = `${evalDate}T00:00:00.000Z`;
  const periodEnd = new Date(new Date(`${evalDate}T00:00:00.000Z`).getTime() + 86400000 - 1000).toISOString();

  const run = await deps.runStore.createRun({
    scopeType: "CASE",
    scopeId: existing.measureId,
    triggeredBy: actor,
    requestedScope: { caseId, measureId: existing.measureId, employeeExternalId: existing.employeeId, evaluationDate: evalDate },
    measurementPeriodStart: periodStart,
    measurementPeriodEnd: periodEnd,
  });
  await deps.runStore.markRunning(run.id);
  await deps.runStore.appendLog(run.id, "INFO", "Case loaded for rerun-to-verify.");
  await deps.runStore.appendLog(run.id, "INFO", `Subject resolved for rerun-to-verify: ${existing.employeeId}.`);
  await deps.runStore.appendLog(run.id, "INFO", "Scoped CQL verification started.");

  // Deterministic per-subject target (same seed the original run used) → idempotent rerun.
  const target = seededTargetFor(employees, binding.rateKey, existing.employeeId) ?? "MISSING_DATA";
  const config = deriveExamConfig(binding, target);
  const bundle = buildSyntheticBundle(employee, config, evalDate);

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
