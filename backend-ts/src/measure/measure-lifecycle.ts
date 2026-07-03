/**
 * Measure lifecycle (#107 authoring) — TS port of MeasureService.createMeasure /
 * approveMeasure / deprecateMeasure / transitionStatus. Each transition is gated exactly
 * like Java and writes a MEASURE_* audit_event (CLAUDE.md: every state change writes audit).
 *
 * Gate note (faithful to Java): approve + Approved→Active require passing test fixtures
 * (activationReadiness), and no fixtures are ported yet, so those transitions are blocked
 * until the Tests-tab fixtures land — same as a fresh measure in Java.
 *
 * Deprecation is NOT a `/status` transition (Fable M2): it lives only on the ADMIN-only
 * `POST /:id/deprecate` route, which requires a reason. Leaving `Active->Deprecated` in the
 * generic `/status` allow-list let an APPROVER deprecate an Active measure with no reason,
 * bypassing that gate — so it is deliberately absent from `ALLOWED_TRANSITIONS` below.
 */
import type { MeasureStore, MeasureRecord } from "../stores/measure-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import { compileAllowsActivation, toActivationReadiness } from "./measure-read-models.ts";

export interface MeasureLifecycleDeps {
  measures: MeasureStore;
  events: CaseEventStore;
}

/** A bad-request-class lifecycle failure (the route maps this to HTTP 400). */
export class MeasureError extends Error {}

// Active->Deprecated is intentionally excluded — deprecation goes through the ADMIN-only
// `/deprecate` route (reason required), not this APPROVER-reachable `/status` path (Fable M2).
const ALLOWED_TRANSITIONS = new Set(["Draft->Approved", "Approved->Active"]);

async function audit(deps: MeasureLifecycleDeps, eventType: string, r: MeasureRecord, actor: string, payload: Record<string, unknown>): Promise<void> {
  await deps.events.appendAudit({
    eventType,
    entityType: "measure_version",
    entityId: r.versionId,
    actor,
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: r.versionId,
    payload,
  });
}

/** POST /api/measures — create a new measure with an empty Draft v1.0 version. Returns the new measure id. */
export async function createMeasure(
  deps: MeasureLifecycleDeps,
  input: { name: string; policyRef: string; owner: string },
  actor: string,
): Promise<string> {
  const name = input.name?.trim();
  const policyRef = input.policyRef?.trim();
  const owner = input.owner?.trim();
  if (!name || !policyRef || !owner) throw new MeasureError("name, policyRef and owner are required");
  const r = await deps.measures.createMeasure({ name, policyRef, owner });
  await audit(deps, "MEASURE_CREATED", r, actor, { measureId: r.measureId, name, policyRef, owner });
  return r.measureId;
}

/** POST /api/measures/:id/approve — Draft → Approved (gated on the activation readiness). */
export async function approveMeasure(deps: MeasureLifecycleDeps, measureId: string, actor: string): Promise<string | null> {
  const r = await deps.measures.getLatest(measureId);
  if (!r) return null;
  if (r.status !== "Draft") throw new MeasureError("Only Draft measures can be approved.");
  const readiness = toActivationReadiness(r);
  if (!compileAllowsActivation(readiness.compileStatus)) {
    throw new MeasureError("Measure cannot be approved until compile status is COMPILED or WARNINGS.");
  }
  if (!readiness.testValidationPassed) throw new MeasureError("Measure cannot be approved until test fixtures pass validation.");
  const updated = await deps.measures.setVersionStatus(measureId, r.versionId, { status: "Approved", approvedBy: actor });
  await audit(deps, "MEASURE_APPROVED", updated ?? r, actor, {
    measureId,
    version: r.version,
    approvedBy: actor,
    compileStatus: readiness.compileStatus,
    testFixtureCount: readiness.testFixtureCount,
    testValidationPassed: readiness.testValidationPassed,
  });
  return "Approved";
}

/** POST /api/measures/:id/deprecate — Active → Deprecated (reason required). */
export async function deprecateMeasure(deps: MeasureLifecycleDeps, measureId: string, reason: string, actor: string): Promise<string | null> {
  if (!reason || !reason.trim()) throw new MeasureError("Deprecation reason is required.");
  const r = await deps.measures.getLatest(measureId);
  if (!r) return null;
  if (r.status !== "Active") throw new MeasureError("Only Active measures can be deprecated.");
  await deps.measures.setVersionStatus(measureId, r.versionId, { status: "Deprecated" });
  await audit(deps, "MEASURE_DEPRECATED", r, actor, { measureId, version: r.version, reason: reason.trim(), deprecatedBy: actor });
  return "Deprecated";
}

/** POST /api/measures/:id/status — explicit transition (Draft→Approved / Approved→Active / Active→Deprecated). */
export async function transitionStatus(deps: MeasureLifecycleDeps, measureId: string, targetStatus: string, actor: string): Promise<string | null> {
  const r = await deps.measures.getLatest(measureId);
  if (!r) return null;
  if (!ALLOWED_TRANSITIONS.has(`${r.status}->${targetStatus}`)) {
    throw new MeasureError(`Invalid transition from ${r.status} to ${targetStatus}`);
  }
  const readiness = toActivationReadiness(r);
  // Draft→Approved must enforce the same compile + test-fixture gate as the dedicated
  // `/approve` route (Fable M3) — otherwise `/status` lets a measure reach Approved (with a
  // matching audit trail) while never having compiled, violating "cannot Approve unless
  // compile passes". (Activation still blocks later, but the Approved state would be wrong.)
  if (r.status === "Draft" && targetStatus === "Approved") {
    if (!compileAllowsActivation(readiness.compileStatus)) {
      throw new MeasureError("Measure cannot be approved until compile status is COMPILED or WARNINGS.");
    }
    if (!readiness.testValidationPassed) {
      throw new MeasureError("Measure cannot be approved until test fixtures pass validation.");
    }
  }
  if (r.status === "Approved" && targetStatus === "Active") {
    if (!compileAllowsActivation(readiness.compileStatus)) {
      throw new MeasureError("Measure cannot be activated until CQL compile status is COMPILED or WARNINGS");
    }
    if (!readiness.ready) throw new MeasureError("Measure cannot be activated until test fixtures pass validation");
  }
  await deps.measures.setVersionStatus(measureId, r.versionId, { status: targetStatus, activate: targetStatus === "Active" });
  await audit(deps, "MEASURE_VERSION_STATUS_CHANGED", r, actor, {
    measureId,
    fromStatus: r.status,
    toStatus: targetStatus,
    compileStatus: readiness.compileStatus,
    valueSetCount: readiness.valueSetCount,
    testFixtureCount: readiness.testFixtureCount,
    testValidationPassed: readiness.testValidationPassed,
    activationBlockers: readiness.activationBlockers,
  });
  return targetStatus;
}
