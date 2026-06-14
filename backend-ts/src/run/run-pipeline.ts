/**
 * Manual-run / rerun pipeline (#107) — the run WRITE path in TS. Resolves a scoped run
 * to (employee × measure) work items via the seeded distribution, evaluates each through
 * the JVM-free CQL engine, persists the run + outcomes, and returns the frontend's
 * `ManualRunResponse`. Port of the Java run-service orchestration (the structured CQL path).
 *
 * This slice supports the bounded, synchronous scopes: MEASURE (one measure × all
 * employees) and EMPLOYEE (all runnable measures × one employee). ALL_PROGRAMS / SITE /
 * CASE need the async run-job model (or the cases module) and are a later slice.
 *
 * Invariant preserved: one employee's evaluation failure does not abort the run — it is
 * persisted as MISSING_DATA with the error in evidence (matches the Java runtime invariant).
 */
import type { RunStore } from "../stores/run-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import type { EvaluateMeasureBinding } from "../engine/evaluate-measure.ts";
import { EMPLOYEES, employeeById, type EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { deriveExamConfig, type TargetOutcome } from "../engine/synthetic/exam-config.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { seededDistribution, seededTargetFor } from "./distribution.ts";

export type RunScopeType = "ALL_PROGRAMS" | "MEASURE" | "SITE" | "EMPLOYEE" | "CASE";

export interface ManualRunRequest {
  scopeType: RunScopeType;
  measureId?: string;
  site?: string;
  employeeExternalId?: string;
  caseId?: string;
  evaluationDate?: string;
  triggeredBy?: string;
}

export interface ManualRunResponse {
  runId: string;
  scopeType: string;
  scopeLabel: string;
  status: string;
  activeMeasuresExecuted: number;
  totalEvaluated: number;
  compliant: number;
  nonCompliant: number;
  message: string;
  measuresExecuted: string[];
}

export interface RunPipelineDeps {
  runStore: RunStore;
  outcomeStore: OutcomeStore;
  engine: EvaluateMeasureBinding;
  /** When present, each outcome upserts/resolves a case (idempotent). */
  caseStore?: CaseStore;
  /** Injectable for tests (defaults to the full synthetic directory). */
  employees?: readonly EmployeeProfile[];
}

/** Thrown for scopes not yet ported to the TS backend (ALL_PROGRAMS / SITE / CASE). */
export class UnsupportedScopeError extends Error {}
/** Thrown for a malformed request (unknown measure/employee, missing field). */
export class InvalidRunRequestError extends Error {}

const NON_COMPLIANT = new Set(["DUE_SOON", "OVERDUE", "MISSING_DATA"]);
const RUNNABLE_MEASURE_IDS = Object.keys(MEASURES);

interface WorkItem {
  employee: EmployeeProfile;
  measureId: string;
  target: TargetOutcome;
}

/** Resolve a scoped request into the (employee × measure) work items + run metadata. */
function resolveScope(req: ManualRunRequest, employees: readonly EmployeeProfile[]) {
  switch (req.scopeType) {
    case "MEASURE": {
      const measureId = req.measureId;
      if (!measureId || !MEASURES[measureId]) throw new InvalidRunRequestError(`Unknown measure: ${measureId}`);
      const rateKey = MEASURE_BINDINGS[measureId]!.rateKey;
      const items = seededDistribution(employees, rateKey).map((a) => ({ employee: a.employee, measureId, target: a.target }));
      return { items, measureIds: [measureId], scopeId: measureId, scopeLabel: `Measure: ${MEASURES[measureId]!.name}` };
    }
    case "EMPLOYEE": {
      const id = req.employeeExternalId;
      if (!id || !employeeById(id)) throw new InvalidRunRequestError(`Unknown employee: ${id}`);
      const employee = employeeById(id)!;
      const items: WorkItem[] = RUNNABLE_MEASURE_IDS.map((measureId) => ({
        employee,
        measureId,
        target: seededTargetFor(employees, MEASURE_BINDINGS[measureId]!.rateKey, id) ?? "MISSING_DATA",
      }));
      return { items, measureIds: RUNNABLE_MEASURE_IDS, scopeId: null, scopeLabel: `Employee: ${id}` };
    }
    default:
      throw new UnsupportedScopeError(
        `Scope ${req.scopeType} is not yet served by the TS backend (MEASURE/EMPLOYEE only in this slice).`,
      );
  }
}

export async function executeManualRun(deps: RunPipelineDeps, req: ManualRunRequest): Promise<ManualRunResponse> {
  const employees = deps.employees ?? EMPLOYEES;
  const evalDate = req.evaluationDate ?? new Date().toISOString().slice(0, 10);
  const { items, measureIds, scopeId, scopeLabel } = resolveScope(req, employees);

  const periodEnd = `${evalDate}T00:00:00.000Z`;
  const periodStart = new Date(new Date(periodEnd).getTime() - 365 * 86400000).toISOString();
  const run = await deps.runStore.createRun({
    scopeType: req.scopeType,
    scopeId: scopeId ?? undefined,
    triggeredBy: req.triggeredBy ?? "manual",
    // Persist the resolved evaluationDate so a rerun reuses the same evaluation period
    // (and the case upsert stays idempotent rather than opening a fresh-period case).
    requestedScope: pruneUndefined({ measureId: req.measureId, employeeExternalId: req.employeeExternalId, site: req.site, evaluationDate: evalDate }),
    measurementPeriodStart: periodStart,
    measurementPeriodEnd: periodEnd,
  });
  await deps.runStore.markRunning(run.id);
  await deps.runStore.appendLog(run.id, "INFO", `${scopeLabel} — evaluating ${items.length} subject(s)`);

  let compliant = 0;
  let nonCompliant = 0;
  let failures = 0;
  for (const item of items) {
    const config = deriveExamConfig(MEASURE_BINDINGS[item.measureId]!, item.target);
    const bundle = buildSyntheticBundle(item.employee, config, evalDate);
    let status: string;
    let evidence: unknown;
    try {
      const result = await deps.engine.evaluate({ measureId: item.measureId, patientBundle: bundle, evaluationDate: evalDate });
      status = result.outcome;
      evidence = result.evidence;
    } catch (err) {
      // One subject's failure must not abort the run (runtime invariant): persist it as
      // MISSING_DATA with the error, but flag the run PARTIAL_FAILURE so it isn't reported
      // as fully successful.
      status = "MISSING_DATA";
      evidence = { evaluationError: "engine failure", message: String((err as Error)?.message ?? err) };
      failures++;
    }
    await deps.outcomeStore.recordOutcome({
      runId: run.id,
      subjectId: item.employee.externalId,
      measureId: item.measureId,
      status,
      evidence,
    });
    // Idempotent case upsert: non-compliant opens, EXCLUDED excludes, COMPLIANT resolves.
    await deps.caseStore?.upsertFromOutcome({
      runId: run.id,
      subjectId: item.employee.externalId,
      measureId: item.measureId,
      evaluationPeriod: evalDate,
      outcomeStatus: status,
    });
    if (status === "COMPLIANT") compliant++;
    else if (NON_COMPLIANT.has(status)) nonCompliant++;
  }

  const terminalStatus = failures > 0 ? "PARTIAL_FAILURE" : "COMPLETED";
  await deps.runStore.finalizeRun(run.id, terminalStatus);
  return {
    runId: run.id,
    scopeType: req.scopeType,
    scopeLabel,
    status: terminalStatus,
    activeMeasuresExecuted: measureIds.length,
    totalEvaluated: items.length,
    compliant,
    nonCompliant,
    message:
      `Evaluated ${items.length} subject(s) across ${measureIds.length} measure(s).` +
      (failures > 0 ? ` ${failures} evaluation failure(s).` : ""),
    measuresExecuted: measureIds.map((id) => MEASURES[id]!.name),
  };
}

/** Rerun an existing run's scope as a new run. */
export async function executeRerun(deps: RunPipelineDeps, runId: string): Promise<ManualRunResponse> {
  const prior = await deps.runStore.getRun(runId);
  if (!prior) throw new InvalidRunRequestError(`Unknown run: ${runId}`);
  const scope = prior.requestedScope;
  return executeManualRun(deps, {
    scopeType: prior.scopeType,
    measureId: (scope.measureId as string | undefined) ?? prior.scopeId ?? undefined,
    employeeExternalId: scope.employeeExternalId as string | undefined,
    site: scope.site as string | undefined,
    evaluationDate: scope.evaluationDate as string | undefined, // reuse the period → idempotent cases
    triggeredBy: "rerun",
  });
}

function pruneUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
