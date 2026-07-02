/**
 * Manual-run / rerun pipeline (#107) — the run WRITE path in TS. Resolves a scoped run
 * to (employee × measure) work items via the seeded distribution, evaluates each through
 * the JVM-free CQL engine, persists the run + outcomes, and returns the frontend's
 * `ManualRunResponse`. Port of the Java run-service orchestration (the structured CQL path).
 *
 * Supports the manual scopes MEASURE (one measure × all employees), EMPLOYEE (all runnable
 * measures × one employee), ALL_PROGRAMS (all runnable measures × all employees), and SITE
 * (all runnable measures × one site's employees). All run synchronously here — the Java side
 * routes ALL_PROGRAMS/SITE through the async job model, but the frontend contract is identical
 * (the run finishes COMPLETED/PARTIAL_FAILURE either way); the async queue is a later refinement.
 * CASE reruns go through rerun-to-verify in the cases module, not this path.
 *
 * Invariant preserved: one employee's evaluation failure does not abort the run — it is
 * persisted as MISSING_DATA with the error in evidence (matches the Java runtime invariant).
 */
import type { RunStore } from "../stores/run-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import type { EvaluateMeasureBinding } from "../engine/evaluate-measure.ts";
import { isApplicable } from "../segment/segment-applicability.ts";
import type { HydratedSegment } from "../stores/segment-store.ts";
import { EMPLOYEES, employeeById, type EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";
import { deriveExamConfig, type TargetOutcome } from "../engine/synthetic/exam-config.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { seededDistribution, seededTargetFor } from "./distribution.ts";
import { bucketPeriodForMeasure } from "./compliance-period.ts";
import type { QualitySnapshotStore } from "../stores/quality-snapshot-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import { materializeRun } from "../quality/materialize-run.ts";

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
  /** Enabled segments for case-creation applicability gating; empty/absent ⇒ all applicable (reversibility). */
  segments?: HydratedSegment[];
  /** Injectable for tests (defaults to the full synthetic directory). */
  employees?: readonly EmployeeProfile[];
  /** When BOTH present, a completed population run (ALL_PROGRAMS/MEASURE) materializes quality-over-time
   *  snapshots (#E16), best-effort — a snapshot failure never fails the run. Absent ⇒ no materialization
   *  (non-run paths like impact-preview/case-rerun simply don't pass them). */
  qualitySnapshots?: QualitySnapshotStore;
  events?: Pick<CaseEventStore, "appendAudit">;
}

/** Thrown for scopes not served by this path (CASE — handled by rerun-to-verify in the cases module). */
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
      if (!measureId || !MEASURES[measureId]) {
        // The /measures catalog (and so the run picker, unchanged) lists all 60 measures;
        // only the Active ones are runnable (have compiled CQL) — same as Java, whose
        // MEASURE run resolves the measure's `status = 'Active'` version. Distinguish a
        // catalog-but-not-runnable measure from a genuinely unknown id so the 400 is honest.
        const inCatalog = MEASURE_CATALOG.some((m) => m.id === measureId);
        throw new InvalidRunRequestError(
          inCatalog
            ? `Measure '${measureId}' is not Active/runnable (no compiled CQL); only Active measures can be run.`
            : `Unknown measure: ${measureId}`,
        );
      }
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
    case "ALL_PROGRAMS": {
      // Every runnable measure × every employee, each at its measure's seeded target bucket.
      const items: WorkItem[] = RUNNABLE_MEASURE_IDS.flatMap((measureId) =>
        seededDistribution(employees, MEASURE_BINDINGS[measureId]!.rateKey).map((a) => ({ employee: a.employee, measureId, target: a.target })),
      );
      return { items, measureIds: RUNNABLE_MEASURE_IDS, scopeId: null, scopeLabel: "All Programs" };
    }
    case "SITE": {
      const site = req.site?.trim();
      if (!site) throw new InvalidRunRequestError("site is required for a SITE run");
      const siteIds = new Set(employees.filter((e) => e.site === site).map((e) => e.externalId));
      if (siteIds.size === 0) throw new InvalidRunRequestError(`Unknown site: ${site}`);
      // The seeded distribution is computed over the FULL population (parity with ALL_PROGRAMS /
      // MEASURE so an employee's target — and thus their case state — is identical across scope
      // types and the case upsert stays idempotent), then filtered to the site's employees.
      const items: WorkItem[] = RUNNABLE_MEASURE_IDS.flatMap((measureId) =>
        seededDistribution(employees, MEASURE_BINDINGS[measureId]!.rateKey)
          .filter((a) => siteIds.has(a.employee.externalId))
          .map((a) => ({ employee: a.employee, measureId, target: a.target })),
      );
      return { items, measureIds: RUNNABLE_MEASURE_IDS, scopeId: null, scopeLabel: `Site: ${site}` };
    }
    default:
      // CASE reruns go through rerun-to-verify (cases module), not the manual-run path.
      throw new UnsupportedScopeError(`Scope ${req.scopeType} is not served by the manual-run path.`);
  }
}

/** ALL_PROGRAMS / SITE fan out to hundreds–thousands of evaluations (~1 min) — too long for a
 *  synchronous request, so the route runs them in the background (ctx.waitUntil) and the page polls.
 *  MEASURE/EMPLOYEE stay synchronous (≤ a few seconds). */
export const ASYNC_SCOPES: ReadonlySet<RunScopeType> = new Set(["ALL_PROGRAMS", "SITE"]);

/** A created + RUNNING run with its resolved work items — the fast first half of a manual run. */
export interface PlannedRun {
  run: { id: string };
  items: WorkItem[];
  measureIds: string[];
  scopeLabel: string;
  scopeType: RunScopeType;
  evalDate: string;
  /** Actor attribution for the run's audit events (the run's triggered_by). */
  triggeredBy: string;
}

/** Create the run (RUNNING) + resolve work items, without evaluating — fast, safe to await inline. */
export async function planManualRun(deps: RunPipelineDeps, req: ManualRunRequest): Promise<PlannedRun> {
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
  return { run, items, measureIds, scopeLabel, scopeType: req.scopeType, evalDate, triggeredBy: req.triggeredBy ?? "manual" };
}

/** Map an upsert disposition to its case audit event type; UNCHANGED (idempotent re-confirm) → no event. */
const CASE_EVENT_FOR: Record<string, string | null> = {
  CREATED: "CASE_CREATED",
  UPDATED: "CASE_UPDATED",
  REOPENED: "CASE_UPDATED",
  RESOLVED: "CASE_RESOLVED",
  EXCLUDED: "CASE_EXCLUDED",
  UNCHANGED: null,
};

/** The immediate RUNNING response for an async (ALL_PROGRAMS/SITE) run — the page polls to terminal. */
export function runningResponse(planned: PlannedRun): ManualRunResponse {
  return {
    runId: planned.run.id,
    scopeType: planned.scopeType,
    scopeLabel: planned.scopeLabel,
    status: "RUNNING",
    activeMeasuresExecuted: planned.measureIds.length,
    totalEvaluated: planned.items.length,
    compliant: 0,
    nonCompliant: 0,
    message: `Running ${planned.items.length} evaluation(s) in the background — refresh for results.`,
    measuresExecuted: planned.measureIds.map((id) => MEASURES[id]!.name),
  };
}

/** Evaluate the planned work items, persist outcomes + cases, finalize the run — the slow half. */
export async function finishManualRun(deps: RunPipelineDeps, planned: PlannedRun): Promise<ManualRunResponse> {
  const { run, items, measureIds, scopeLabel, scopeType, evalDate } = planned;
  let compliant = 0;
  let nonCompliant = 0;
  let failures = 0;
  for (const item of items) {
    const config = deriveExamConfig(MEASURE_BINDINGS[item.measureId]!, item.target);
    const bundle = buildSyntheticBundle(item.employee, config, evalDate);
    // The engine still evaluates compliance AS-OF `evalDate` (today / the run's date) so the
    // day-math is current, but the persisted evaluation_period is bucketed to the measure's
    // current compliance CYCLE (#150 H1). That decoupling is what keeps a nightly rerun
    // idempotent: same (employee, measure, cycle) key → case upsert, not a fresh cohort.
    const period = bucketPeriodForMeasure(item.measureId, evalDate);
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
      evaluationPeriod: period,
      status,
      evidence,
    });
    // Idempotent case upsert — gated by segment applicability (#183 E11.3): an out-of-cohort
    // (subject, measure) does NOT create/upsert a case. The outcome above is ALWAYS persisted
    // (CQL stays the sole compliance authority — ADR-008). Empty/absent segments ⇒ all applicable.
    if (deps.caseStore && isApplicable(item.employee, item.measureId, deps.segments ?? [])) {
      const upserted = await deps.caseStore.upsertFromOutcome({
        runId: run.id,
        subjectId: item.employee.externalId,
        measureId: item.measureId,
        evaluationPeriod: period,
        outcomeStatus: status,
      });
      // Audit the case transition (Fable H1 — the population pipeline previously wrote NO case audit
      // events, violating the "every state change writes audit_event" hard rule). Idempotent
      // re-confirms (UNCHANGED) and no-ops (null — respected human closure / already-terminal) write
      // nothing, so a nightly run records real transitions only, not one event per still-open case.
      if (deps.events && upserted) {
        const eventType = CASE_EVENT_FOR[upserted.disposition];
        if (eventType) {
          await deps.events.appendAudit({
            eventType,
            entityType: "case",
            entityId: upserted.id,
            actor: planned.triggeredBy,
            refRunId: run.id,
            refCaseId: upserted.id,
            refMeasureVersionId: item.measureId,
            payload: {
              disposition: upserted.disposition,
              outcomeStatus: status,
              status: upserted.status,
              subjectId: item.employee.externalId,
              measureId: item.measureId,
              evaluationPeriod: period,
              runId: run.id,
            },
          });
        }
      }
    }
    if (status === "COMPLIANT") compliant++;
    else if (NON_COMPLIANT.has(status)) nonCompliant++;
  }

  const terminalStatus = failures > 0 ? "PARTIAL_FAILURE" : "COMPLETED";
  await deps.runStore.finalizeRun(run.id, terminalStatus);
  // Audit the run's terminal state (Fable H1). The highest-volume state change in the system now
  // leaves a ledger record; run audit packets and the run timeline were previously near-empty.
  if (deps.events) {
    await deps.events
      .appendAudit({
        eventType: "RUN_COMPLETED",
        entityType: "run",
        entityId: run.id,
        actor: planned.triggeredBy,
        refRunId: run.id,
        refCaseId: null,
        refMeasureVersionId: null,
        payload: {
          scopeType,
          scopeLabel,
          status: terminalStatus,
          totalEvaluated: items.length,
          compliant,
          nonCompliant,
          failures,
          measuresExecuted: measureIds,
        },
      })
      .catch(() => {
        /* audit is best-effort at the run boundary — never fail an otherwise-complete run on a ledger write */
      });
  }
  // Materialize the quality-over-time snapshot for this run's month (#E16) — AFTER finalize and
  // best-effort, so a snapshot failure can never fail an otherwise-complete run. materializeRun skips
  // non-population scopes (EMPLOYEE/SITE/CASE) and seed:scale runs internally; the scale tenant folds
  // in via the bounded GROUP-BY, never the 120k per-subject rows.
  if (deps.qualitySnapshots && deps.events) {
    await materializeRun(run.id, {
      runStore: deps.runStore,
      outcomeStore: deps.outcomeStore,
      qualitySnapshots: deps.qualitySnapshots,
      events: deps.events,
    }).catch((err) => {
      void deps.runStore
        .appendLog(run.id, "WARN", `Quality snapshot materialization failed: ${String((err as Error)?.message ?? err)}`)
        .catch(() => {});
    });
  }
  return {
    runId: run.id,
    scopeType,
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

/** Plan + finish in one call — the synchronous manual run (MEASURE/EMPLOYEE, and the rerun path). */
export async function executeManualRun(deps: RunPipelineDeps, req: ManualRunRequest): Promise<ManualRunResponse> {
  return finishManualRun(deps, await planManualRun(deps, req));
}

/**
 * Background completion for an async run: run `finishManualRun`, but if it REJECTS after the client
 * already got `201 RUNNING` (e.g. recordOutcome / case upsert / finalize throws — failures outside
 * the per-subject engine try/catch), finalize the run FAILED so it never sticks RUNNING (which the
 * page would poll forever). Never throws — safe to hand to ctx.waitUntil.
 */
export async function finishOrFail(deps: RunPipelineDeps, planned: PlannedRun): Promise<void> {
  try {
    await finishManualRun(deps, planned);
  } catch (err) {
    try {
      await deps.runStore.appendLog(planned.run.id, "ERROR", `Run failed: ${String((err as Error)?.message ?? err)}`);
      await deps.runStore.finalizeRun(planned.run.id, "FAILED");
    } catch {
      /* best effort — the host's waitUntil also logs the original rejection */
    }
  }
}

/** Build the ManualRunRequest that reruns a prior run's scope (reusing its evaluation period). */
export function rerunRequest(prior: {
  scopeType: RunScopeType;
  scopeId: string | null;
  requestedScope: Record<string, unknown>;
}): ManualRunRequest {
  const scope = prior.requestedScope;
  return {
    scopeType: prior.scopeType,
    measureId: (scope.measureId as string | undefined) ?? prior.scopeId ?? undefined,
    employeeExternalId: scope.employeeExternalId as string | undefined,
    site: scope.site as string | undefined,
    evaluationDate: scope.evaluationDate as string | undefined, // reuse the period → idempotent cases
    triggeredBy: "rerun",
  };
}

/** Rerun an existing run's scope as a new run (synchronous; the route routes async scopes via waitUntil). */
export async function executeRerun(deps: RunPipelineDeps, runId: string): Promise<ManualRunResponse> {
  const prior = await deps.runStore.getRun(runId);
  if (!prior) throw new InvalidRunRequestError(`Unknown run: ${runId}`);
  return executeManualRun(deps, rerunRequest(prior));
}

function pruneUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
