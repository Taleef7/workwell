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
import type { EvaluateMeasureBinding, MeasureOutcome } from "@work-well/measure-engine";
import { OFFICIAL_LOGIC_VERSION_PREFIX, type RoutedEngine } from "../wiring/executor-router.ts";
import { isApplicable } from "../segment/segment-applicability.ts";
import type { HydratedSegment } from "../stores/segment-store.ts";
import { employeeById, type EmployeeProfile, EVALUABLE_EMPLOYEES, EVALUATION_EXCLUDED_TENANTS } from "../engine/synthetic/employee-catalog.ts";
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
import type { EvalStateStore } from "../stores/eval-state-store.ts";
import type { ValueSetStore } from "../stores/value-set-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import { materializeRun } from "../quality/materialize-run.ts";
import { IncrementalCache } from "./incremental/incremental-eval.ts";
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
  /**
   * The measure engine. Every caller passes `routedEngineForEnv(env)`, which is the authored engine
   * ITSELF while `WORKWELL_OFFICIAL_MEASURES` is unset — so the optional `logicVersionFor` below is
   * absent on every environment today. When a measure IS routed to the official artifact, that method
   * is how the incremental cache learns the logic it caches is no longer WorkWell's authored ELM
   * (#263/ADR-035 + roadmap §7.4 PR-8); reading it off the engine rather than taking it as a separate
   * dep is what makes the two structurally unable to disagree.
   */
  engine: EvaluateMeasureBinding & Pick<RoutedEngine, "logicVersionFor" | "evaluateBatch">;
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
  /**
   * Incremental-evaluation cache (#263). When `incremental` is true AND `evalState` is present, the loop
   * reuses a prior CQL outcome for a subject whose data + logic are unchanged and whose status can't have
   * moved (copy-forward), instead of re-running the ~68 ms CQL. Inert-unless-configured
   * (`WORKWELL_INCREMENTAL_EVAL`): both absent/false ⇒ the loop is byte-identical to today. Descriptive
   * only — the CQL engine still authors every status it's asked for (ADR-008).
   */
  evalState?: EvalStateStore;
  incremental?: boolean;
  /**
   * #263 — whether the runtime value-set resolver is active (`isVsacConfigured(env)`). Feeds
   * `logic_version` so a VSAC toggle/re-import invalidates reuse. Default undefined ⇒ false (demo path).
   */
  expansionActive?: boolean;
  /** #263 — value-set store, read once to fold `expansion_hash` into `logic_version` (only when `expansionActive`). */
  valueSets?: Pick<ValueSetStore, "listAll">;
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

/**
 * The FHIR bundle a work item is evaluated against — extracted so the measure-major pre-pass and the
 * per-item loop cannot build it two subtly different ways. Deterministic in its inputs, which is what
 * makes building it twice for a batched measure merely wasteful rather than a source of divergence.
 */
function bundleFor(item: WorkItem, liveRoster: EnrollmentRoster | undefined, evalDate: string): unknown {
  return item.liveBundle !== undefined
    ? stampEnrollment(item.liveBundle as FhirBundle, item.measureId, liveRoster!, { evaluationDate: evalDate })
    : buildSyntheticBundle(item.employee, deriveExamConfig(MEASURE_BINDINGS[item.measureId]!, item.target!), evalDate);
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
      if (EVALUATION_EXCLUDED_TENANTS.has(employee.tenantId)) {
        // Directory-only tenant (see employee-catalog): the subject is visible but not evaluable yet.
        throw new InvalidRunRequestError(
          `Employee '${id}' belongs to tenant '${employee.tenantId}', which is directory-only until its measure set is wired (ROADMAP MM-1).`,
        );
      }
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
  const employees = deps.employees ?? EVALUABLE_EMPLOYEES;
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
  let skipped = 0; // #263: subjects whose prior outcome was copied forward (evaluation skipped)

  // #263 incremental cache — inert unless BOTH the flag and the store are present (byte-identical
  // otherwise). Scope = this live-tenant pipeline only; the scale path is not wired. When value-set
  // expansion is active (VSAC/resolver on), build a url/oid → expansion_hash map once so logic_version
  // reflects value-set membership too (review #3 / Codex P1); on the demo path it stays undefined.
  let vsExpansionHashes: Map<string, string> | undefined;
  if (deps.incremental && deps.evalState && deps.expansionActive && deps.valueSets) {
    vsExpansionHashes = new Map();
    try {
      for (const vs of await deps.valueSets.listAll()) {
        if (vs.expansionHash) {
          if (vs.canonicalUrl) vsExpansionHashes.set(vs.canonicalUrl, vs.expansionHash);
          if (vs.oid) vsExpansionHashes.set(vs.oid, vs.expansionHash);
        }
      }
    } catch {
      /* a value-set read failure just means no hashes folded — logic_version falls back to ELM-only */
    }
  }
  const incremental =
    deps.incremental && deps.evalState
      ? new IncrementalCache({
          evalState: deps.evalState,
          outcomes: deps.outcomeStore,
          evalDate,
          expansionActive: deps.expansionActive,
          valueSetExpansionHashes: vsExpansionHashes,
          // Bound to THIS run's engine, so a measure routed to the official artifact cannot be
          // fingerprinted with the authored ELM's hash and have authored outcomes copied forward
          // (roadmap §7.4 PR-8). Absent on the authored engine ⇒ unchanged behavior.
          engineLogicVersion: (measureId) => deps.engine.logicVersionFor?.(measureId),
        })
      : undefined;

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

  // Roadmap §7.4 PR-8 — measure-major batching, as a PRE-PASS rather than a rewrite of the loop below.
  //
  // fqm-execution parses an artifact's ELM per CALL, so an officially-routed measure was paying one parse
  // of a 2.4 MB bundle PER SUBJECT. `engine.evaluateBatch` resolves `undefined` for anything it cannot
  // batch — every measure today — in which case nothing here runs and the loop is the code that ships now.
  //
  // A pre-pass, because the loop carries outcome persistence, the incremental commit, the case upsert, its
  // audit event and the counters, all order-dependent. Restructuring it measure-major would hold every
  // measure's bundles in memory at once (150 subjects × 14 measures) to benefit the measures that are
  // routed, of which there are currently none. This holds ONE measure's bundles and drops them.
  //
  // Bundles are therefore built twice for a batched measure — here and in the loop, where the incremental
  // fingerprint needs one. Deterministic and cheap beside an ELM parse; noted rather than optimised.
  //
  // No interaction with the incremental cache today: ADR-040 §6 means an official-routed measure is never
  // reused, so this cannot evaluate a subject the cache would have skipped. If that policy is lifted, the
  // pre-pass would evaluate some subjects whose result then goes unused — wasteful, never wrong.
  const prefetched = new Map<string, MeasureOutcome>();
  const batchFailure = new Map<string, Error>();
  /**
   * Per-measure initial-population membership, as REPORTED by whichever path produced each outcome
   * (ADR-043). Read after the evaluation loop, never during it.
   *
   * Read at the END of the roster, not in the batch pre-pass. The first version concluded inside the
   * pre-pass off `prefetched` alone, and Codex (#354) showed that reads an INCOMPLETE roster: a subject
   * the executor omits is re-evaluated individually LATER in the loop below, so a batch of two out-of-IPP
   * outcomes plus one omission warned even when the omitted subject landed squarely in the population,
   * and one out-of-IPP outcome plus two omissions stayed silent because the sample failed its own `> 1`
   * guard. Membership is a property of the finished roster, so it is decided where the roster is finished.
   *
   * Membership is recorded for EVERY measure but only ever READ for an officially-routed one — see
   * `emptyIppMeasures` below for why that gate is not optional. An absent `inInitialPopulation` still
   * means UNKNOWN rather than "out of population": the field is optional on `MeasureOutcome`, so absence
   * is absence of evidence.
   */
  const ippByMeasure = new Map<string, boolean[]>();
  if (deps.engine.evaluateBatch) {
    for (const measureId of new Set(items.map((i) => i.measureId))) {
      const forMeasure = items.filter((i) => i.measureId === measureId);
      let batched = false;
      try {
        // The subject list is a FACTORY, not an array, so a measure with no batch path costs nothing.
        // Passed eagerly, this would build every measure's bundles — 14 measures × N subjects — and
        // discard 13/14 of them the moment official routing is on for one measure (review #3).
        const results = await deps.engine.evaluateBatch(
          measureId,
          () =>
            forMeasure.map((item) => ({
              subjectId: item.employee.externalId,
              patientBundle: bundleFor(item, liveRoster, evalDate),
            })),
          evalDate,
        );
        if (!results) continue; // not batchable — the loop evaluates it per subject, unchanged
        batched = true;
        for (const item of forMeasure) {
          const outcome = results.get(item.employee.externalId);
          if (outcome) prefetched.set(`${item.employee.externalId}|${measureId}`, outcome);
        }
      } catch (err) {
        // Never abort the run (runtime invariant). The failure is recorded against the MEASURE and
        // re-thrown per subject in the loop, so it lands in the existing per-subject isolation —
        // MISSING_DATA carrying this message, `failures++`, run PARTIAL_FAILURE, and therefore the #264
        // alert. That is the loud outcome the batch retrieve check exists to produce, and it costs no new
        // failure channel. Other measures are unaffected. Normalized to an Error so the loop can test
        // PRESENCE rather than truthiness — a rejection with a falsy value would otherwise be stored and
        // then silently ignored, disabling the very refusal this exists for (review #4).
        batchFailure.set(measureId, err instanceof Error ? err : new Error(String(err)));
        await deps.runStore
          .appendLog(run.id, "ERROR", `${measureId}: official batch evaluation failed — ${String((err as Error)?.message ?? err)}`)
          .catch(() => {});
      }
      // OUTSIDE the try, and best-effort. Inside it, a transient `run_logs` write failure would be
      // caught above and recorded as a batch failure — turning a successful evaluation, whose results are
      // already in `prefetched`, into a whole measure's worth of MISSING_DATA. An observability write must
      // never author an outcome (review #2); the same reason the case-audit and quality-snapshot writes in
      // this file are best-effort.
      if (batched) {
        await deps.runStore
          .appendLog(run.id, "INFO", `${measureId}: ${forMeasure.length} subject(s) evaluated in one official batch`)
          .catch(() => {});
      }
    }
  }

  for (const item of items) {
    const bundle = bundleFor(item, liveRoster, evalDate);
    // The engine still evaluates compliance AS-OF `evalDate` (today / the run's date) so the
    // day-math is current, but the persisted evaluation_period is bucketed to the measure's
    // current compliance CYCLE (#150 H1). That decoupling is what keeps a nightly rerun
    // idempotent: same (employee, measure, cycle) key → case upsert, not a fresh cohort.
    const period = bucketPeriodForMeasure(item.measureId, evalDate);
    let status: string;
    let evidence: unknown;
    // #263: ask the incremental cache whether this subject can be reused (data + logic unchanged and the
    // status can't have moved). A REUSE copies the prior CQL outcome forward with date-corrected evidence
    // and skips the ~68 ms evaluation; anything else (or the cache disabled) is a full evaluation. The
    // cache never authors a status — it only decides whether to re-ask the engine (ADR-008).
    const plan = incremental
      ? await incremental
          .plan(item.measureId, item.employee.externalId, period, bundle)
          .catch((err) => {
            // A plan failure (eval_state / getOutcomeById read error) safely falls back to a full
            // evaluation, but must not be silent — an under-performing incremental run would otherwise be
            // invisible (review #2). Best-effort WARN, mirroring the commit path below.
            void deps.runStore
              .appendLog(run.id, "WARN", `eval_state plan failed (${item.employee.externalId}/${item.measureId}) — full re-eval: ${String((err as Error)?.message ?? err)}`)
              .catch(() => {});
            return null;
          })
      : null;
    let evaluatedNow = true; // false ⇒ copied forward; true ⇒ a real (or attempted) CQL evaluation
    let evaluationFailed = false;
    // A failed batch outranks a cache hit. Unreachable today — ADR-040 §6 means an official-routed
    // measure is never reused, so a measure that could fail a batch never produces a `reuse` plan — but
    // the ordering is the difference between "wasteful" and "wrong" if that policy is lifted: a reused
    // subject would otherwise never see the refusal, and a profile/terminology misconfiguration would go
    // partially silent, which is precisely what the refusal exists to prevent (review #5).
    const batchFailed = batchFailure.has(item.measureId);
    if (plan?.action === "reuse" && !batchFailed) {
      status = plan.status;
      evidence = plan.evidence;
      evaluatedNow = false;
      skipped++;
    } else {
      try {
        // A measure whose whole roster was evaluated in one official batch above is read from there. A
        // batch that FAILED re-throws here, once per subject, so a batch-level refusal (notably "nothing
        // was retrieved for anybody") reaches exactly the isolation a single subject's failure does.
        if (batchFailed) throw batchFailure.get(item.measureId)!;
        const result =
          prefetched.get(`${item.employee.externalId}|${item.measureId}`) ??
          (await deps.engine.evaluate({ measureId: item.measureId, patientBundle: bundle, evaluationDate: evalDate }));
        status = result.outcome;
        evidence = result.evidence;
        // ADR-043 — record membership from the FINAL outcome, whichever path produced it (batch prefetch
        // or the individual fallback on this line). Reading it here rather than in the pre-pass is what
        // makes the roster complete before it is judged. A failed evaluation lands in `catch` below and
        // contributes nothing, which is right: an engine error is not evidence about the population. A
        // copy-forward reuse also contributes nothing (unreachable today — ADR-040 §6 keeps an
        // official-routed measure out of the cache — but if that policy is lifted it degrades to silence,
        // not to a false alarm).
        if (result.inInitialPopulation !== undefined) {
          const seen = ippByMeasure.get(item.measureId);
          if (seen) seen.push(result.inInitialPopulation);
          else ippByMeasure.set(item.measureId, [result.inInitialPopulation]);
        }
      } catch (err) {
        // One subject's failure must not abort the run (runtime invariant): persist it as
        // MISSING_DATA with the error, but flag the run PARTIAL_FAILURE so it isn't reported
        // as fully successful.
        status = "MISSING_DATA";
        evidence = { evaluationError: "engine failure", message: String((err as Error)?.message ?? err) };
        failures++;
        evaluationFailed = true;
      }
    }
    const recorded = await deps.outcomeStore.recordOutcome({
      runId: run.id,
      subjectId: item.employee.externalId,
      measureId: item.measureId,
      evaluationPeriod: period,
      status,
      evidence,
    });
    // #263: cache the fingerprint of a SUCCESSFUL real evaluation so a future run can reuse it. Never
    // cache an engine-failure MISSING_DATA (we must not copy an error forward), and never re-cache a
    // reuse (its fingerprint is already stored, pointing at the original evaluation). Best-effort — a
    // cache-write failure must not fail an otherwise-complete run.
    if (incremental && plan?.action === "evaluate" && evaluatedNow && !evaluationFailed) {
      await incremental
        .commit(item.measureId, item.employee.externalId, period, status, recorded.id, evidence, plan)
        .catch((err) =>
          deps.runStore
            .appendLog(run.id, "WARN", `eval_state commit failed (${item.employee.externalId}/${item.measureId}): ${String((err as Error)?.message ?? err)}`)
            .catch(() => {}),
        );
    }
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
    // OPEN cases: rerun-to-verify returns a non-mutating 409 for `wc|` subjects until fetch-one-patient
    // lands, so a newly-created wc case would be un-closeable. Case CREATION eligibility is therefore
    // separated from display APPLICABILITY — the `!isLiveWebChartSubject` guard sits ONLY on the
    // create-capable `isApplicable` branch, not on `closeOnly`. The close-only bypass (COMPLIANT — a
    // no-op when no case exists; EXCLUDED — only when an active case already exists) still runs for a
    // `wc|` subject, so an existing wc case (e.g. one an owner opened by adding WebChart to a group)
    // can still be RESOLVED by a later COMPLIANT/EXCLUDED run rather than being stranded active forever
    // (rerun-to-verify can't close it either). Neither close-only branch can create a wc case. The
    // outcome is always persisted regardless (CQL stays authoritative, ADR-008). Codex P2 (#325).
    const isLiveWebChartSubject = item.employee.externalId.startsWith("wc|");
    if (deps.caseStore && (closeOnly || (!isLiveWebChartSubject && isApplicable(item.employee, item.measureId, deps.segments ?? [])))) {
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

  // A whole roster out of the initial population, SURFACED (ADR-043) — now that the roster is complete.
  //
  // The hazard ADR-042 consequence 5 could only assert in prose: a live WebChart tenant whose Patients
  // carry no `us-core-sex` has every subject fall out of official CMS125's IPP, the run completes, and the
  // roster reads exactly like a legitimately ineligible cohort. Measured, and NOT catchable by PR-8f's
  // retrieve refusal — official CMS125 matched 236 LOINC Observations on real WebChart data and still put
  // all 56 subjects out of the IPP, so `retrieveSignal` was true throughout.
  //
  // A WARN, deliberately NOT a failure. The first version refused inside the adapter, and review showed
  // that converts a VALID result into corruption: for a site-scoped CMS125 run over an all-male cohort,
  // zero-in-IPP is the correct answer, and a batch failure would replace every subject's
  // `official.populationResults` evidence — the blob MeasureReport/QRDA read (ADR-031) — with an
  // `evaluationError`, mark the run PARTIAL_FAILURE, and fire the #264 alert. A zero-denominator
  // MeasureReport is a legitimate reportable artifact, not an engine failure. Decisively, cohort
  // composition VARIES BY RUN, so "stop routing this measure" is not a remedy an operator can apply.
  //
  // The two causes — data missing an element the IPP reads, versus nobody qualifying — are
  // indistinguishable from here, and a check that cannot tell them apart must not destroy the benign one.
  // Enforcement lives at the FLIP gate (`devdb-official-eval.test.ts` + DEPLOY.md §"Flipping a measure to
  // official execution"), where a human compares against the authored engine over known data; runtime's
  // job is only to stop being silent.
  //
  // `> 1` because for ONE subject "not in the initial population" is an ordinary correct answer —
  // `/simulate` on somebody outside the age band.
  //
  // **Gated on OFFICIAL ROUTING, and that gate is load-bearing.** An earlier version of this ran for every
  // measure, on the stated basis that "the authored engine never sets `inInitialPopulation`" so authored
  // measures could never trigger it. That premise is FALSE: `deriveInInitialPopulation`
  // (`engine/cql/cql-execution-engine.ts`) emits the field for every measure with a boolean
  // `Initial Population` define, which is all 16 of ours. Ungated, an authored measure whose evaluated
  // cohort happens to sit entirely outside its own IPP would be told that nobody entered the *official*
  // initial population and pointed at the `us-core-sex` extension — for a measure with no official
  // artifact, not named in `WORKWELL_OFFICIAL_MEASURES`, and nothing to do with WebChart. It did not fire
  // today only because the synthetic roster happens to put somebody in every measure's IPP, which is a
  // property of the fixture, not an invariant. An official-specific message needs an official-specific
  // trigger.
  //
  // The signal is the engine's own declared identity (ADR-040): `logicVersionFor` returns
  // `official-fqm:<version>:<artifactSha>:<terminologySha>` for a routed measure and the authored ELM
  // hash (or nothing) otherwise. Asking the engine what it ran beats re-reading the env here.
  //
  // De-duped for the same reason the batch pre-pass de-dupes `measureIds` — a repeated id would otherwise
  // name the same measure twice in the run message.
  const emptyIppMeasures = [...new Set(measureIds)].filter((measureId) => {
    if (!deps.engine.logicVersionFor?.(measureId)?.startsWith(OFFICIAL_LOGIC_VERSION_PREFIX)) return false;
    const seen = ippByMeasure.get(measureId);
    return seen !== undefined && seen.length > 1 && !seen.some(Boolean);
  });
  for (const measureId of emptyIppMeasures) {
    // Best-effort, like every other observability write in this file: an observability write must never
    // author an outcome or abort an otherwise-complete run.
    await deps.runStore
      .appendLog(
        run.id,
        "WARN",
        `${measureId}: not one of ${ippByMeasure.get(measureId)!.length} subjects entered the official ` +
          `initial population. Either this cohort genuinely has nobody eligible, or the data lacks a ` +
          `structural element the measure's initial population reads — for a WebChart source see ` +
          `docs/WEBCHART_FHIR_MAPPING.md §3.1. The us-core-sex extension WAS the known case and is now ` +
          `derived (ADR-057), so look instead at: a source that sends no Patient.gender at all, a cohort ` +
          `with no qualifying encounter in the period, or a genuinely ineligible one. Outcomes are ` +
          `reported as computed.`,
      )
      .catch(() => {});
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
          // #263 accounting (issue acceptance criterion): evaluated vs skipped-unchanged. Only present
          // when the incremental cache was active, so a normal run's payload is unchanged.
          ...(incremental ? { evaluated: items.length - skipped, skippedUnchanged: skipped } : {}),
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
  // The ADR-043 warning is echoed into the run MESSAGE as well as `run_logs`.
  //
  // **How far that actually reaches, stated exactly, because the first version overclaimed it** (Codex
  // #354). This message is returned on the SYNCHRONOUS response only. A run that goes through
  // `scheduleAsyncRun` — every ALL_PROGRAMS and SITE run, and a MEASURE run on a WebChart-configured
  // stack, which is precisely the configuration this warning exists for — answers the POST with the
  // RUNNING response and discards this one. `RunRecord` has no message column and neither `RunListItem`
  // nor `RunSummary` carries a message, so the polling UI shows only `COMPLETED`.
  //
  // For those runs the warning lives in `run_logs`, which IS reachable — `GET /api/runs/:id/logs`, and
  // the runs page fetches it for the selected run — but as a timeline entry an operator has to open,
  // not on the run list. Persisting it onto the run (so the list can show it) needs a `runs` column,
  // and schema is owner-owned; recorded as a follow-up rather than smuggled into this PR.
  const runMessage =
    `Evaluated ${items.length} subject(s) across ${measureIds.length} measure(s).` +
    (incremental ? ` ${items.length - skipped} re-evaluated, ${skipped} reused-unchanged (#263).` : "") +
    (failures > 0 ? ` ${failures} evaluation failure(s).` : "") +
    (emptyIppMeasures.length > 0
      ? ` WARNING: nobody entered the official initial population for ${emptyIppMeasures.join(", ")} — ` +
        `either this cohort has nobody eligible, or the data lacks an element the measure reads (ADR-043).`
      : "");
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
