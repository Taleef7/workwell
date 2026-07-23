/**
 * Manual-run / rerun pipeline (#107) — the run WRITE path in TS. Resolves a scoped run
 * to (employee × measure) work items via the seeded distribution, evaluates each through
 * the JVM-free CQL engine, persists the run + outcomes, and returns the frontend's
 * `ManualRunResponse`. Port of the Java run-service orchestration (the structured CQL path).
 *
 * Supports the manual scopes MEASURE (one measure × all employees), EMPLOYEE (all runnable
 * measures × one employee), ALL_PROGRAMS (all runnable measures × all employees), and SITE
 * (all runnable measures × one site's employees). The route schedules wide scopes — plus a configured
 * live WebChart MEASURE population — through waitUntil; direct callers retain synchronous completion.
 * CASE reruns go through rerun-to-verify in the cases module, not this path.
 *
 * Invariant preserved: one employee's evaluation failure does not abort the run — it is
 * persisted as MISSING_DATA with the error in evidence (matches the Java runtime invariant).
 */
import type { RunStore } from "../stores/run-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import type { CaseStore, CaseRecord } from "../stores/case-store.ts";
import { ACTIVE_CASE_STATUSES } from "../case/case-logic.ts";
import type { EvaluateMeasureBinding } from "../engine/evaluate-measure.ts";
import { isApplicable } from "../segment/segment-applicability.ts";
import type { HydratedSegment } from "../stores/segment-store.ts";
import { EMPLOYEES, employeeById, type EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";
import { deriveExamConfig, type TargetOutcome } from "../engine/synthetic/exam-config.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import type { FhirBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import {
  ROSTER_ELIGIBLE_MEASURES,
  parseEnrollmentRoster,
  stampEnrollment,
  type EnrollmentRoster,
} from "../engine/ingress/enrollment/roster.ts";
import {
  isWebChartConfigured,
  webChartConfigFromEnv,
  webChartDataSource,
  type DataSourceEnv,
} from "../engine/ingress/data-source.ts";
import { httpWebChartClient, type WebChartClient } from "../engine/ingress/webchart/webchart-client.ts";
import { profileForId, replaceLiveDirectory } from "../engine/ingress/webchart/live-directory.ts";
import { seededDistribution, seededTargetFor } from "./distribution.ts";
import { bucketPeriodForMeasure } from "./compliance-period.ts";
import type { QualitySnapshotStore } from "../stores/quality-snapshot-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import { materializeRun } from "../quality/materialize-run.ts";
import {
  alertForTerminalRun,
  emitAlert,
  resolveAlertChannels,
  type AlertChannel,
} from "./alert-channel.ts";

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
  /**
   * The AUTHENTICATED actor for audit attribution (from the auth middleware), kept SEPARATE from the
   * run's `triggeredBy` trigger-label. `triggeredBy` is caller-influenced (and a trigger *type*, not a
   * user), so audit rows must never derive their actor from it — matches the invariant "public API actor
   * identity always comes from the auth middleware; caller-supplied actor fields are ignored" (Codex P1).
   * A scheduled run passes `"scheduler"`; absent (tests / offline tools) ⇒ `"system"`.
   */
  actor?: string;
  /**
   * Alert fan-out for FAILED / PARTIAL_FAILURE terminals (#264). Default = console-only
   * (`WORKWELL_ALERT` structured line). Routes/scheduler pass `resolveAlertChannels(env)` so an
   * optional webhook fires when `WORKWELL_ALERT_WEBHOOK_URL` is set. Emission is best-effort.
   */
  alertChannels?: readonly AlertChannel[];
  /** Runtime WebChart configuration. The existing isWebChartConfigured predicate is the only selector. */
  webChartEnv?: WebChartRunEnv;
  /** Verified client seam for tests/offline callers; production uses httpWebChartClient. */
  webChartClient?: WebChartClient;
}

export interface WebChartRunEnv extends DataSourceEnv {
  WORKWELL_WEBCHART_ENROLLMENT_JSON?: string;
}

/** Thrown for scopes not served by this path (CASE — handled by rerun-to-verify in the cases module). */
export class UnsupportedScopeError extends Error {
  constructor(message: string, readonly status = 501) {
    super(message);
  }
}
/** Thrown for a malformed request (unknown measure/employee, missing field). */
export class InvalidRunRequestError extends Error {}

const NON_COMPLIANT = new Set(["DUE_SOON", "OVERDUE", "MISSING_DATA"]);
const RUNNABLE_MEASURE_IDS = Object.keys(MEASURES);

interface WorkItem {
  employee: EmployeeProfile;
  measureId: string;
  target?: TargetOutcome;
  liveBundle?: unknown;
}

export interface LivePopulationDescriptor {
  host: string;
  pageSize: number;
  enrollmentJson: string | undefined;
}

interface LiveTenantMetadata {
  host: string;
  fetchedCount: number;
  degradedCount: number;
  durationMs: number;
  status: "COMPLETED" | "FAILED";
}

class LivePopulationPreparationError extends Error {
  constructor(message: string, readonly liveTenant: LiveTenantMetadata) {
    super(message);
  }
}

const WEBCHART_PAGE_SIZE = 100;

const RUN_SCOPE_TYPES: readonly RunScopeType[] = ["ALL_PROGRAMS", "MEASURE", "SITE", "EMPLOYEE", "CASE"];

/** Resolve a scoped request into the (employee × measure) work items + run metadata. */
function resolveScope(req: ManualRunRequest, employees: readonly EmployeeProfile[]) {
  // The body is unvalidated JSON cast to ManualRunRequest, so scopeType can be anything at
  // runtime. A value that is not a scope at all is a CLIENT error (400) — only a real scope
  // this path declines to serve (CASE, below) is a 501.
  if (!RUN_SCOPE_TYPES.includes(req.scopeType))
    throw new InvalidRunRequestError(
      `Unknown scopeType: ${JSON.stringify(req.scopeType)}. Expected one of ${RUN_SCOPE_TYPES.join(", ")}.`,
    );
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
      // CASE is a real scope, served by rerun-to-verify (cases module) rather than here —
      // genuinely "not implemented on this path" (501). Non-scopes were rejected above.
      throw new UnsupportedScopeError(`Scope ${req.scopeType} is not served by the manual-run path.`);
  }
}

/** ALL_PROGRAMS / SITE fan out to hundreds–thousands of evaluations (~1 min) — too long for a
 *  synchronous request, so the route runs them in the background (ctx.waitUntil) and the page polls.
 *  A configured WebChart MEASURE is also scheduled because its remote population load must not block
 *  the foreground response. Static MEASURE and EMPLOYEE stay synchronous (≤ a few seconds). */
export const ASYNC_SCOPES: ReadonlySet<RunScopeType> = new Set(["ALL_PROGRAMS", "SITE"]);

/** A created + RUNNING run with its resolved work items — the fast first half of a manual run. */
export interface PlannedRun {
  run: { id: string };
  items: WorkItem[];
  measureIds: string[];
  scopeLabel: string;
  scopeType: RunScopeType;
  evalDate: string;
  livePopulation?: LivePopulationDescriptor;
}

/** Create the run (RUNNING) + resolve work items, without evaluating — fast, safe to await inline. */
export async function planManualRun(deps: RunPipelineDeps, req: ManualRunRequest): Promise<PlannedRun> {
  const employees = deps.employees ?? EMPLOYEES;
  const evalDate = req.evaluationDate ?? new Date().toISOString().slice(0, 10);
  const webChartEnv = deps.webChartEnv ?? {};
  const webChartConfigured = isWebChartConfigured(webChartEnv);
  if (webChartConfigured && req.scopeType === "SITE" && req.site?.trim() === "WebChart") {
    throw new UnsupportedScopeError("SITE=WebChart is not supported until partial-site runs can preserve the latest population.");
  }
  if (webChartConfigured && req.scopeType === "EMPLOYEE" && req.employeeExternalId?.startsWith("wc|")) {
    throw new UnsupportedScopeError(
      "Live WebChart EMPLOYEE rerun-to-verify is not supported until fetch-one-patient is available.",
      409,
    );
  }
  const { items, measureIds, scopeId, scopeLabel } = resolveScope(req, employees);
  const cfg = webChartConfigured ? webChartConfigFromEnv(webChartEnv) : undefined;
  const livePopulation = cfg && (req.scopeType === "ALL_PROGRAMS" || req.scopeType === "MEASURE")
    ? {
        host: new URL(cfg.baseUrl).host,
        pageSize: WEBCHART_PAGE_SIZE,
        enrollmentJson: webChartEnv.WORKWELL_WEBCHART_ENROLLMENT_JSON,
      }
    : undefined;

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
  return { run, items, measureIds, scopeLabel, scopeType: req.scopeType, evalDate, ...(livePopulation ? { livePopulation } : {}) };
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

/** The immediate RUNNING response for an async wide or configured-live run — the page polls to terminal. */
export function runningResponse(planned: PlannedRun): ManualRunResponse {
  const livePending = planned.livePopulation ? " Live population count pending (WebChart)." : "";
  return {
    runId: planned.run.id,
    scopeType: planned.scopeType,
    scopeLabel: planned.scopeLabel,
    status: "RUNNING",
    activeMeasuresExecuted: planned.measureIds.length,
    totalEvaluated: planned.items.length,
    compliant: 0,
    nonCompliant: 0,
    message: `Running ${planned.items.length} evaluation(s) in the background — refresh for results.${livePending}`,
    measuresExecuted: planned.measureIds.map((id) => MEASURES[id]!.name),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function patientIdOf(bundle: unknown): string | undefined {
  if (!isObject(bundle) || bundle.resourceType !== "Bundle" || !Array.isArray(bundle.entry)) return undefined;
  for (const entry of bundle.entry) {
    const resource = isObject(entry) ? entry.resource : undefined;
    if (isObject(resource) && resource.resourceType === "Patient" && typeof resource.id === "string" && resource.id) {
      return resource.id;
    }
  }
  return undefined;
}

function isDegradedBundle(bundle: unknown): boolean {
  if (!isObject(bundle) || !Array.isArray(bundle.entry)) return false;
  return bundle.entry.some((entry) => {
    const resource = isObject(entry) ? entry.resource : undefined;
    return isObject(resource) && resource.resourceType === "OperationOutcome";
  });
}

function explicitEnrollmentRoster(raw: string): EnrollmentRoster {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid WORKWELL_WEBCHART_ENROLLMENT_JSON: ${String((error as Error)?.message ?? error)}`);
  }
  if (!isObject(parsed)) throw new Error("Invalid WORKWELL_WEBCHART_ENROLLMENT_JSON: expected an object");
  for (const [subjectId, measures] of Object.entries(parsed)) {
    if (!Array.isArray(measures) || measures.some((measure) => typeof measure !== "string")) {
      throw new Error(`Invalid WORKWELL_WEBCHART_ENROLLMENT_JSON: '${subjectId}' must map to an array of measure ids`);
    }
  }
  return parseEnrollmentRoster(parsed);
}

function enrollmentRosterFor(ids: readonly string[], explicitJson: string | undefined): EnrollmentRoster {
  if (explicitJson !== undefined) return explicitEnrollmentRoster(explicitJson);
  return new Map(ids.map((id) => [id, ROSTER_ELIGIBLE_MEASURES]));
}

async function prepareLivePopulation(
  deps: RunPipelineDeps,
  planned: PlannedRun,
): Promise<{ items: WorkItem[]; roster: EnrollmentRoster; metadata: LiveTenantMetadata }> {
  const descriptor = planned.livePopulation!;
  const started = Date.now();
  let fetchedCount = 0;
  let degradedCount = 0;
  try {
    const env = deps.webChartEnv ?? {};
    const cfg = webChartConfigFromEnv(env);
    if (!cfg) throw new Error("WebChart became unconfigured before background preparation");
    // Validate explicit policy before starting remote work; malformed policy never broadens enrollment.
    const explicitRoster = descriptor.enrollmentJson === undefined
      ? undefined
      : explicitEnrollmentRoster(descriptor.enrollmentJson);
    const client = deps.webChartClient ?? httpWebChartClient(cfg, {
      pageSize: descriptor.pageSize,
      // This run supersedes the latest population read model. A truncated Patient list would erase
      // every subject on the missing pages, so later-page transport failures are fatal here. The
      // read-only live CLI keeps the transport's lenient default.
      failOnPartialPage: true,
    });
    const bundles = await webChartDataSource(cfg, client).loadBundles();
    fetchedCount = bundles.length;
    degradedCount = bundles.filter(isDegradedBundle).length;
    const patientIds = bundles.map(patientIdOf).filter((id): id is string => id !== undefined);
    if (patientIds.length === 0) {
      throw new Error("WebChart returned zero usable Patient bundles");
    }
    replaceLiveDirectory(bundles);
    const roster = explicitRoster ?? enrollmentRosterFor(patientIds, undefined);
    const items: WorkItem[] = [];
    for (const bundle of bundles) {
      const patientId = patientIdOf(bundle);
      if (!patientId) continue;
      const employee = profileForId(`wc|${patientId}`);
      if (!employee) continue;
      for (const measureId of planned.measureIds) items.push({ employee, measureId, liveBundle: bundle });
    }
    return {
      items,
      roster,
      metadata: {
        host: descriptor.host,
        fetchedCount,
        degradedCount,
        durationMs: Date.now() - started,
        status: "COMPLETED",
      },
    };
  } catch (error) {
    throw new LivePopulationPreparationError(
      String((error as Error)?.message ?? error),
      {
        host: descriptor.host,
        fetchedCount,
        degradedCount,
        durationMs: Date.now() - started,
        status: "FAILED",
      },
    );
  }
}

/** Evaluate the planned work items, persist outcomes + cases, finalize the run — the slow half. */
export async function finishManualRun(deps: RunPipelineDeps, planned: PlannedRun): Promise<ManualRunResponse> {
  const { run, measureIds, scopeLabel, scopeType, evalDate } = planned;
  let items = planned.items;
  let liveRoster: EnrollmentRoster | undefined;
  let liveTenant: LiveTenantMetadata | undefined;
  if (planned.livePopulation) {
    const prepared = await prepareLivePopulation(deps, planned);
    items = [...items, ...prepared.items];
    liveRoster = prepared.roster;
    liveTenant = prepared.metadata;
    await deps.runStore.appendLog(
      run.id,
      "INFO",
      `WebChart ${liveTenant.host}: fetched ${liveTenant.fetchedCount} subject(s), ${liveTenant.degradedCount} degraded, ${liveTenant.durationMs}ms`,
    );
  }
  // Audit actor = the authenticated user (never the caller-influenced triggeredBy label; Codex P1).
  const auditActor = deps.actor ?? "system";
  let compliant = 0;
  let nonCompliant = 0;
  let failures = 0;

  // Active cases that exist at run start, keyed `subject|measure|period` (Codex P2). An out-of-cohort
  // EXCLUDED outcome must be able to CLOSE/UPDATE an EXISTING active case (a fresh waiver on someone who
  // left the cohort should still excuse their open case) — but must NOT CREATE one (that would re-pollute
  // the excluded lists the segment gate keeps clear). So EXCLUDED bypasses applicability only when its
  // (subject, measure, current-period) key is already active here. COMPLIANT needs no such check (it is a
  // `planCaseUpsert` no-op with no existing case). A read failure just leaves EXCLUDED gated (safe).
  const activeCaseKeys = new Set<string>();
  if (deps.caseStore) {
    for (const measureId of new Set(measureIds)) {
      try {
        for (const c of await deps.caseStore.listCases({ measureId, statuses: [...ACTIVE_CASE_STATUSES], limit: 100000 })) {
          activeCaseKeys.add(`${c.employeeId}|${c.measureId}|${c.evaluationPeriod}`);
        }
      } catch {
        /* a read failure only means EXCLUDED stays applicability-gated — never abort the run */
      }
    }
  }

  for (const item of items) {
    const bundle = item.liveBundle !== undefined
      ? stampEnrollment(item.liveBundle as FhirBundle, item.measureId, liveRoster!, { evaluationDate: evalDate })
      : buildSyntheticBundle(
          item.employee,
          deriveExamConfig(MEASURE_BINDINGS[item.measureId]!, item.target!),
          evalDate,
        );
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
    // Idempotent case upsert — segment applicability (#183 E11.3) gates case CREATION only: an
    // out-of-cohort (subject, measure) does NOT open a case. Two bypasses that only ever CLOSE/UPDATE an
    // existing case (never create) run even out-of-cohort, so a subject who leaves a cohort still has
    // their open case resolved (Fable M11 / Codex P2): (1) COMPLIANT — a `planCaseUpsert` no-op when no
    // case exists, so always safe; (2) EXCLUDED — but ONLY when an active case already exists for its
    // (subject, measure, period) key (a fresh waiver excuses an existing open case), because EXCLUDED
    // with NO existing case would INSERT a new EXCLUDED case and re-pollute the gate. The outcome above
    // is ALWAYS persisted (CQL is the sole compliance authority — ADR-008). Empty/absent segments ⇒ all.
    const closeOnly =
      status === "COMPLIANT" ||
      (status === "EXCLUDED" && activeCaseKeys.has(`${item.employee.externalId}|${item.measureId}|${period}`));
    // Live WebChart subjects are display-applicable (their roster cells show real chips) but must NOT
    // open cases: rerun-to-verify returns a non-mutating 409 for `wc|` subjects until fetch-one-patient
    // lands, so a created wc case would be un-closeable. Case ELIGIBILITY is therefore separated from
    // display APPLICABILITY here — the outcome is still persisted (CQL stays authoritative, ADR-008),
    // only the case upsert is skipped. (Before the baseline covered the WebChart site this was an
    // accidental side-effect of the NOT_APPLICABLE overlay; making it explicit keeps the documented
    // "no live cases by default" behavior once the site is covered.) Codex P2 (#325).
    const isLiveWebChartSubject = item.employee.externalId.startsWith("wc|");
    if (deps.caseStore && !isLiveWebChartSubject && (closeOnly || isApplicable(item.employee, item.measureId, deps.segments ?? []))) {
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
      //
      // Best-effort at the run boundary (Codex P1): the disposition is only known AFTER the upsert, so
      // we cannot write the audit row first (the canonical recordCaseEvent audit-before-mutate order) —
      // and a pre-read-and-plan in the pipeline would race the store's own re-plan under concurrent
      // runs, auditing a disposition that didn't happen. So we audit after the mutation but never let a
      // transient audit_events failure throw: an unhandled reject here would abort the loop, skip
      // finalizeRun, and leave the run stuck RUNNING (sync path 500) or marked FAILED (async) AFTER the
      // case was already mutated. Instead we log the ledger gap (mirrors the RUN_COMPLETED + quality
      // snapshot best-effort writes below) so an otherwise-complete run still finalizes.
      if (deps.events && upserted) {
        const eventType = CASE_EVENT_FOR[upserted.disposition];
        if (eventType) {
          await deps.events
            .appendAudit({
              eventType,
              entityType: "case",
              entityId: upserted.id,
              actor: auditActor,
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
            })
            .catch((err) => {
              void deps.runStore
                .appendLog(
                  run.id,
                  "WARN",
                  `Case audit (${eventType} ${upserted.id}) failed — ledger gap: ${String((err as Error)?.message ?? err)}`,
                )
                .catch(() => {});
            });
        }
      }
    }
    if (status === "COMPLIANT") compliant++;
    else if (NON_COMPLIANT.has(status)) nonCompliant++;
  }

  // Close prior-cycle OPEN/IN_PROGRESS cases (Fable M10). At a compliance-cycle rollover a
  // still-non-compliant subject gets a NEW case under the new period; the previous period's case would
  // otherwise linger OPEN — hidden from the current-cycle worklist but surfaced by `?status=open`,
  // campaigns (no period filter → double outreach), CSV exports, and MCP list_noncompliant. Java needed
  // migration V022 to close ~5,019 of exactly these. Scoped to the (subject, measure) pairs this run
  // actually evaluated, so a SITE/EMPLOYEE run never touches out-of-scope cases. Best-effort + audited
  // (system closure, closed_by NULL — a rolled-over cycle, not a human decision); a failure only logs a
  // ledger-gap WARN and never aborts the run.
  if (deps.caseStore && deps.events) {
    const nowIso = new Date().toISOString();
    for (const measureId of measureIds) {
      const currentPeriod = bucketPeriodForMeasure(measureId, evalDate);
      const evaluated = new Set(items.filter((i) => i.measureId === measureId).map((i) => i.employee.externalId));
      let openCases: CaseRecord[];
      try {
        openCases = await deps.caseStore.listCases({ measureId, statuses: [...ACTIVE_CASE_STATUSES], limit: 100000 });
      } catch {
        continue; // a read failure here must never abort an otherwise-complete run
      }
      const currentPeriodMs = Date.parse(currentPeriod);
      for (const c of openCases) {
        if (!evaluated.has(c.employeeId)) continue;
        // Close ONLY strictly-OLDER cycles, never the same or a newer one (Codex P2): a backdated /
        // historical rerun has an older `currentPeriod`, so a plain `period !== currentPeriod` check
        // would wrongly resolve today's actionable case as CYCLE_ROLLED_OVER. Compare cycle order; a
        // non-date-parseable period (defensive) yields NaN and is left untouched.
        const casePeriodMs = Date.parse(c.evaluationPeriod);
        if (!(casePeriodMs < currentPeriodMs)) continue;
        const closed = await deps.caseStore
          .patchCase(c.id, { status: "RESOLVED", closedAt: nowIso, closedReason: "CYCLE_ROLLED_OVER", closedBy: null })
          .catch(() => null);
        if (!closed) continue;
        await deps.events
          .appendAudit({
            eventType: "CASE_RESOLVED",
            entityType: "case",
            entityId: c.id,
            actor: auditActor,
            refRunId: run.id,
            refCaseId: c.id,
            refMeasureVersionId: measureId,
            payload: {
              reason: "CYCLE_ROLLED_OVER",
              priorPeriod: c.evaluationPeriod,
              currentPeriod,
              subjectId: c.employeeId,
              measureId,
              runId: run.id,
            },
          })
          .catch((err) => {
            void deps.runStore
              .appendLog(run.id, "WARN", `Rollover close audit (CASE_RESOLVED ${c.id}) failed — ledger gap: ${String((err as Error)?.message ?? err)}`)
              .catch(() => {});
          });
      }
    }
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
        actor: auditActor,
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
          ...(liveTenant ? { liveTenant } : {}),
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
  // Observability (#264): alert exactly once on FAILED/PARTIAL_FAILURE; COMPLETED is silent.
  // Best-effort — emitAlert never rejects, but we still await so the console line is ordered after
  // finalize in logs. Default channels = console-only when the caller did not inject any.
  const runMessage =
    `Evaluated ${items.length} subject(s) across ${measureIds.length} measure(s).` +
    (failures > 0 ? ` ${failures} evaluation failure(s).` : "");
  const alert = alertForTerminalRun({
    status: terminalStatus,
    runId: run.id,
    scopeType,
    scopeLabel,
    totalEvaluated: items.length,
    failures,
    message: runMessage,
  });
  if (alert) {
    await emitAlert(deps.alertChannels ?? resolveAlertChannels({}), alert);
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
    message: runMessage,
    measuresExecuted: measureIds.map((id) => MEASURES[id]!.name),
  };
}

async function failPlannedRun(deps: RunPipelineDeps, planned: PlannedRun, err: unknown): Promise<void> {
  const errMsg = String((err as Error)?.message ?? err);
  const liveTenant = err instanceof LivePopulationPreparationError ? err.liveTenant : undefined;
  const liveSuffix = liveTenant
    ? ` [WebChart ${liveTenant.host}; fetched=${liveTenant.fetchedCount}; degraded=${liveTenant.degradedCount}; durationMs=${liveTenant.durationMs}]`
    : "";
  await deps.runStore.appendLog(planned.run.id, "ERROR", `Run failed: ${errMsg}${liveSuffix}`).catch(() => {});
  if (liveTenant && deps.events) {
    await deps.events
      .appendAudit({
        eventType: "RUN_COMPLETED",
        entityType: "run",
        entityId: planned.run.id,
        actor: deps.actor ?? "system",
        refRunId: planned.run.id,
        refCaseId: null,
        refMeasureVersionId: null,
        payload: {
          scopeType: planned.scopeType,
          scopeLabel: planned.scopeLabel,
          status: "FAILED",
          totalEvaluated: 0,
          compliant: 0,
          nonCompliant: 0,
          failures: 0,
          measuresExecuted: planned.measureIds,
          liveTenant,
          error: errMsg,
        },
      })
      .catch(() => {
        /* terminal audit is best-effort at this boundary; FAILED finalization must still be attempted */
      });
  }
  await deps.runStore.finalizeRun(planned.run.id, "FAILED").catch(() => {
    /* best effort — the host's waitUntil also logs the original rejection */
  });
  // Observability (#264): a hard FAILED (outside per-subject isolation) must not be silent.
  // Best-effort — never rethrow from the alert path.
  const alert = alertForTerminalRun({
    status: "FAILED",
    runId: planned.run.id,
    scopeType: planned.scopeType,
    scopeLabel: planned.scopeLabel,
    totalEvaluated: 0,
    failures: 0,
    message: `Run failed: ${errMsg}${liveTenant ? ` (WebChart ${liveTenant.host})` : ""}`,
  });
  if (alert) {
    await emitAlert(deps.alertChannels ?? resolveAlertChannels({}), alert);
  }
}

/** Plan + finish in one call — the synchronous manual run (MEASURE/EMPLOYEE, and the rerun path). */
export async function executeManualRun(deps: RunPipelineDeps, req: ManualRunRequest): Promise<ManualRunResponse> {
  const planned = await planManualRun(deps, req);
  try {
    return await finishManualRun(deps, planned);
  } catch (err) {
    // Hosts without waitUntil use this synchronous path. A configured population preparation error
    // happens before outcomes are written; finalize it exactly like the background path, then retain
    // the synchronous caller's existing rejected-promise contract.
    if (err instanceof LivePopulationPreparationError) await failPlannedRun(deps, planned, err);
    throw err;
  }
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
    await failPlannedRun(deps, planned, err);
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
