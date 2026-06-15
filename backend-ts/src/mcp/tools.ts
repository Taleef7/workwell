/**
 * MCP read-only tools (#108) — TS port of the 13 tools in McpServerConfig. Each tool is a
 * pure handler over the existing stores + read models; the JSON-RPC transport (routes/mcp.ts)
 * and the role gate + per-call audit (dispatch.ts) wrap them. Read-only: no tool mutates state.
 *
 * Two tools (get_measure_traceability, list_data_quality_gaps) depend on services not yet
 * ported to backend-ts (MeasureTraceabilityService / DataReadinessService); they are registered
 * so tools/list is complete but return a faithful NOT_IMPLEMENTED error rather than fake data.
 */
import type { CaseStore } from "../stores/case-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import type { RunStore } from "../stores/run-store.ts";
import type { MeasureStore, MeasureRecord } from "../stores/measure-store.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { employeeById } from "../engine/synthetic/employee-catalog.ts";
import { toCaseDetail } from "../case/case-detail-read-model.ts";
import { toCaseSummary } from "../case/case-read-models.ts";
import { toRunSummary, toRunListItem } from "../run/read-models.ts";
import { toMeasureDetail } from "../measure/measure-read-models.ts";
import { generateTraceability } from "../measure/measure-traceability.ts";
import { computeDataReadiness } from "../measure/data-readiness.ts";
import type { JsonRecord } from "./tool-audit.ts";

export interface McpToolDeps {
  caseStore: CaseStore;
  outcomeStore: OutcomeStore;
  runStore: RunStore;
  measureStore: MeasureStore;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonRecord;
  /** Allowed Spring authorities; the transport gate already restricts to ADMIN/CASE_MANAGER/MCP_CLIENT. */
  roles: string[];
  sensitivity: "restricted" | "internal" | "unclassified";
  handler: (args: JsonRecord, deps: McpToolDeps) => Promise<unknown>;
}

const CM = "ROLE_CASE_MANAGER";
const ADMIN = "ROLE_ADMIN";
const AUTHOR = "ROLE_AUTHOR";
const APPROVER = "ROLE_APPROVER";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

/** A returned (not thrown) structured error — mirrors Java safeError; audited as success. */
export function safeError(code: string, message: string): JsonRecord {
  return { error: true, code, message };
}

class ToolArgError extends Error {}

function requireString(args: JsonRecord, key: string): string {
  const v = args[key];
  if (v === null || v === undefined || String(v).trim() === "") {
    throw new ToolArgError(`Missing required argument: ${key}`);
  }
  return String(v);
}

function measureVersionOf(measureId: string): string {
  const lib = MEASURES[measureId]?.library ?? "";
  const dash = lib.lastIndexOf("-");
  return dash >= 0 ? lib.slice(dash + 1) : "";
}

/** The measure filter the client actually supplied (measureId or measureName), or null if none. */
function measureFilterRef(args: JsonRecord): string | null {
  const id = args.measureId != null ? String(args.measureId).trim() : "";
  if (id) return id;
  const name = args.measureName != null ? String(args.measureName).trim() : "";
  return name || null;
}

/** Resolve a measure record from measureId (slug) or measureName (case-insensitive); null if unresolved. */
async function resolveMeasure(deps: McpToolDeps, args: JsonRecord): Promise<MeasureRecord | null> {
  const rawId = args.measureId != null ? String(args.measureId).trim() : "";
  if (rawId) return deps.measureStore.getLatest(rawId);
  const rawName = args.measureName != null ? String(args.measureName).trim() : "";
  if (rawName) {
    const all = await deps.measureStore.listLatest();
    return all.find((m) => m.name.toLowerCase() === rawName.toLowerCase()) ?? null;
  }
  return null;
}

/** Map the MCP status filter to concrete case statuses (open default; closed = RESOLVED/CLOSED; all = any). */
function caseStatusesFor(raw: string): string[] | undefined {
  switch (raw.toLowerCase()) {
    case "all":
      return undefined;
    case "closed":
      return ["RESOLVED", "CLOSED"];
    case "open":
    case "":
      return ["OPEN"];
    default:
      return [raw.toUpperCase()];
  }
}

const OUTCOME_KEYS = ["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"] as const;
const NON_COMPLIANT = ["DUE_SOON", "OVERDUE", "MISSING_DATA"];

// ---- tool handlers -----------------------------------------------------------

async function getCase(args: JsonRecord, deps: McpToolDeps): Promise<unknown> {
  const caseId = requireString(args, "caseId");
  if (!UUID_RE.test(caseId)) return safeError("INVALID_ARGUMENT", "caseId must be a valid UUID");
  const c = await deps.caseStore.getCase(caseId);
  if (!c) throw new ToolArgError(`Case not found: ${caseId}`);
  const outcomes = await deps.outcomeStore.listOutcomes(c.lastRunId);
  const outcome = outcomes.find((o) => o.subjectId === c.employeeId && o.measureId === c.measureId) ?? null;
  const detail = toCaseDetail(c, outcome);
  const evidence = detail.evidenceJson ?? {};
  const whyFlagged = (evidence as JsonRecord).why_flagged ?? {};
  return { ...detail, evidence_payload: evidence, why_flagged: whyFlagged };
}

async function listCases(args: JsonRecord, deps: McpToolDeps): Promise<unknown> {
  const status = args.status != null && String(args.status).trim() ? String(args.status).trim() : "open";
  // A supplied-but-unresolved measure filter must NOT silently drop to "all cases" (would leak
  // unrelated restricted cases) — error instead. Java throws "Measure not found"; we return safeError.
  const ref = measureFilterRef(args);
  const measure = ref ? await resolveMeasure(deps, args) : null;
  if (ref && !measure) return safeError("MEASURE_NOT_FOUND", `Measure not found: ${ref}`);
  const rows = await deps.caseStore.listCases({ statuses: caseStatusesFor(status), measureId: measure?.measureId, limit: 100000, offset: 0 });
  const results = rows.map((c) => {
    const s = toCaseSummary(c);
    return {
      case_id: s.caseId,
      employee_id: s.employeeId,
      employee_name: s.employeeName,
      site: s.site,
      measure_name: s.measureName,
      measure_version: s.measureVersion,
      measure_version_id: s.measureVersionId,
      evaluation_period: s.evaluationPeriod,
      status: s.status,
      priority: s.priority,
      assignee: s.assignee ?? "",
      current_outcome_status: s.currentOutcomeStatus,
      last_run_id: s.lastRunId,
      updated_at: s.updatedAt,
    };
  });
  return { results, returned: results.length, filters: { status, measureId: measure?.measureId ?? "" } };
}

async function getRunSummary(args: JsonRecord, deps: McpToolDeps): Promise<unknown> {
  const rawRunId = args.runId != null && String(args.runId).trim() ? String(args.runId).trim() : null;
  if (rawRunId && !UUID_RE.test(rawRunId)) return safeError("INVALID_ARGUMENT", "runId must be a valid UUID");
  const run = rawRunId ? await deps.runStore.getRun(rawRunId) : (await deps.runStore.listRuns(1))[0] ?? null;
  if (!run) throw new ToolArgError(rawRunId ? `Run not found: ${rawRunId}` : "No runs found");
  const outcomes = await deps.outcomeStore.listOutcomes(run.id);
  const totalCases = await deps.caseStore.countByLastRun(run.id);
  const s = toRunSummary(run, outcomes, totalCases);
  return {
    run_id: s.runId,
    scope: s.scopeType,
    total_cases: s.totalCases,
    compliant_count: s.compliantCount,
    non_compliant_count: s.nonCompliantCount,
    pass_rate: s.passRate,
    duration: s.durationMs,
    outcome_counts: s.outcomeCounts,
    started_at: s.startedAt,
    completed_at: s.completedAt,
  };
}

async function listMeasures(args: JsonRecord, deps: McpToolDeps): Promise<unknown> {
  const status = args.status != null && String(args.status).trim() ? String(args.status).trim() : "Active";
  const records = (await deps.measureStore.listLatest()).filter((m) => m.status.toLowerCase() === status.toLowerCase());
  records.sort((a, b) => a.name.localeCompare(b.name));
  const results = records.map((r) => ({
    measureId: r.measureId,
    measureName: r.name,
    policyRef: r.policyRef,
    version: r.version,
    status: r.status,
    compileStatus: r.compileStatus,
    testFixtureCount: r.spec.testFixtures?.length ?? 0,
    valueSetCount: 0, // value-set governance not ported
    lastUpdated: r.activatedAt ?? r.createdAt ?? r.updatedAt,
  }));
  return { results, returned: results.length, status };
}

async function getMeasureVersion(args: JsonRecord, deps: McpToolDeps): Promise<unknown> {
  const rawId = args.measureId != null ? String(args.measureId).trim() : "";
  if (!rawId && !(args.measureName != null && String(args.measureName).trim())) {
    throw new ToolArgError("measureId or measureName is required");
  }
  const rec = await resolveMeasure(deps, args);
  if (!rec) throw new ToolArgError("Measure not found");
  const detail = toMeasureDetail(rec);
  const cqlText = detail.cqlText ?? "";
  return {
    measureId: detail.id,
    measureName: detail.name,
    policyRef: detail.policyRef,
    version: detail.version,
    lifecycleStatus: detail.status,
    compileStatus: detail.compileStatus,
    specJson: {
      description: detail.description,
      eligibilityCriteria: detail.eligibilityCriteria,
      exclusions: detail.exclusions,
      complianceWindow: detail.complianceWindow,
      requiredDataElements: detail.requiredDataElements,
    },
    cqlText: cqlText.length <= 500 ? cqlText : cqlText.slice(0, 500),
    attachedValueSets: [],
    testFixtureCount: detail.testFixtures.length,
    valueSetCount: 0,
  };
}

async function listRuns(args: JsonRecord, deps: McpToolDeps): Promise<unknown> {
  const measureId = args.measureId != null && String(args.measureId).trim() ? String(args.measureId).trim() : null;
  let limit = 10;
  if (args.limit != null) {
    const n = Number(String(args.limit).trim());
    if (!Number.isFinite(n)) return safeError("INVALID_ARGUMENT", "limit must be a numeric value");
    if (n <= 0) return safeError("INVALID_ARGUMENT", "limit must be a positive number");
    limit = Math.min(Math.trunc(n), 200);
  }
  let runs = await deps.runStore.listRuns(100000);
  if (measureId) runs = runs.filter((r) => r.scopeId === measureId);
  runs = runs.slice(0, limit);
  const results = await Promise.all(
    runs.map(async (run) => {
      const outcomes = await deps.outcomeStore.listOutcomes(run.id);
      const item = toRunListItem(run, outcomes);
      const counts: Record<string, number> = Object.fromEntries(OUTCOME_KEYS.map((k) => [k, 0]));
      for (const o of outcomes) if (o.status in counts) counts[o.status] = (counts[o.status] ?? 0) + 1;
      const complianceRate = item.totalEvaluated === 0 ? 0 : Math.round((1000 * (counts.COMPLIANT ?? 0)) / item.totalEvaluated) / 10;
      return {
        run_id: run.id,
        measure_name: item.measureName,
        measure_version: measureVersionOf(run.scopeId ?? ""),
        status: run.status,
        scope_type: run.scopeType,
        trigger_type: item.triggerType,
        started_at: run.startedAt,
        completed_at: run.completedAt,
        duration_ms: item.durationMs,
        total_evaluated: item.totalEvaluated,
        compliance_rate: complianceRate,
        outcome_counts: counts,
      };
    }),
  );
  return { results, returned: results.length, measureId: measureId ?? "", limit };
}

async function explainOutcome(args: JsonRecord, deps: McpToolDeps): Promise<unknown> {
  const caseId = requireString(args, "caseId");
  if (!UUID_RE.test(caseId)) return safeError("INVALID_ARGUMENT", "caseId must be a valid UUID");
  const c = await deps.caseStore.getCase(caseId);
  if (!c) throw new ToolArgError(`Case not found: ${caseId}`);
  const outcomes = await deps.outcomeStore.listOutcomes(c.lastRunId);
  const outcome = outcomes.find((o) => o.subjectId === c.employeeId && o.measureId === c.measureId) ?? null;
  const detail = toCaseDetail(c, outcome);
  const wf = ((detail.evidenceJson ?? {}) as JsonRecord).why_flagged as JsonRecord | undefined;
  const val = (k: string, fb: string): string => (wf && wf[k] != null ? String(wf[k]) : fb);
  const explanation =
    `${detail.employeeName} was flagged as ${detail.currentOutcomeStatus} for the ${detail.measureName} measure. ` +
    `Their last qualifying exam was ${val("last_exam_date", "unknown date")} (${val("days_overdue", "unknown")} days ago), ` +
    `which exceeds the ${val("compliance_window_days", "unknown")}-day compliance window. ` +
    `Role eligibility: ${val("role_eligible", "unknown")}. Site eligibility: ${val("site_eligible", "unknown")}. ` +
    `Waiver status: ${val("waiver_status", "unknown")}.`;
  return {
    case_id: caseId,
    employee_name: detail.employeeName,
    measure_name: detail.measureName,
    status: detail.currentOutcomeStatus,
    explanation,
    why_flagged: wf ?? {},
  };
}

async function getEmployee(args: JsonRecord, deps: McpToolDeps): Promise<unknown> {
  const externalId = requireString(args, "employeeExternalId");
  const emp = employeeById(externalId);
  if (!emp) return safeError("EMPLOYEE_NOT_FOUND", `Employee not found: ${externalId}`);
  const outcomes = await deps.outcomeStore.listOutcomesForEmployee(externalId, 5);
  const latestOutcomes = outcomes.map((o) => ({
    measureName: MEASURES[o.measureId]?.name ?? o.measureId,
    version: measureVersionOf(o.measureId),
    status: o.status,
    evaluationPeriod: o.evaluationPeriod,
    evaluatedAt: o.evaluatedAt,
  }));
  return { employeeExternalId: emp.externalId, name: emp.name, role: emp.role, site: emp.site, active: true, latestOutcomes };
}

async function checkCompliance(args: JsonRecord, deps: McpToolDeps): Promise<unknown> {
  const externalId = requireString(args, "employeeExternalId");
  const measureName = requireString(args, "measureName");
  const mode = args.mode != null ? String(args.mode) : "latest";
  if (mode !== "latest" && mode !== "preview") return safeError("INVALID_ARGUMENT", "mode must be 'latest' or 'preview'");
  const rec = await resolveMeasure(deps, { measureName });
  const outcomes = rec ? (await deps.outcomeStore.listOutcomesForEmployee(externalId, 100000)).filter((o) => o.measureId === rec.measureId) : [];
  const latest = outcomes[0] ?? null; // newest-first
  if (!rec || !latest) {
    return {
      employeeExternalId: externalId,
      measureName,
      status: "NO_OUTCOME",
      source: mode,
      complianceDecisionSource: "cql_outcome",
      decisionAvailable: false,
      message: "No outcome found. Run a measure evaluation first.",
    };
  }
  const openCases = await deps.caseStore.listCases({ statuses: ["OPEN"], measureId: rec.measureId, limit: 100000, offset: 0 });
  const openCase = openCases.find((c) => c.employeeId === externalId && c.evaluationPeriod === latest.evaluationPeriod) ?? null;
  return {
    status: latest.status,
    evaluationPeriod: latest.evaluationPeriod,
    evaluatedAt: latest.evaluatedAt,
    measureName: rec.name,
    measureVersion: measureVersionOf(rec.measureId),
    caseId: openCase?.id ?? null,
    employeeExternalId: externalId,
    source: mode,
    complianceDecisionSource: "cql_outcome",
    decisionAvailable: true,
  };
}

async function listNoncompliant(args: JsonRecord, deps: McpToolDeps): Promise<unknown> {
  let limit = 25;
  if (args.limit != null) {
    const n = Number(String(args.limit).trim());
    if (!Number.isFinite(n)) return safeError("INVALID_ARGUMENT", "limit must be a numeric value");
    limit = Math.max(1, Math.min(100, Math.trunc(n)));
  }
  const measureNameFilter = args.measureName != null ? String(args.measureName).trim() : "";
  const siteFilter = args.site != null ? String(args.site).trim() : "";
  const statusFilter = args.status != null ? String(args.status).trim() : "";
  if (statusFilter && !NON_COMPLIANT.includes(statusFilter)) {
    return safeError("INVALID_ARGUMENT", "status must be one of: DUE_SOON, OVERDUE, MISSING_DATA");
  }
  const measure = measureNameFilter ? await resolveMeasure(deps, { measureName: measureNameFilter }) : null;
  // Same leak guard as list_cases: an unresolved measure filter must error, not return all cases.
  if (measureNameFilter && !measure) return safeError("MEASURE_NOT_FOUND", `Measure not found: ${measureNameFilter}`);
  let rows = await deps.caseStore.listCases({ statuses: ["OPEN"], measureId: measure?.measureId, limit: 100000, offset: 0 });
  rows = rows.filter((c) => NON_COMPLIANT.includes(c.currentOutcomeStatus));
  if (statusFilter) rows = rows.filter((c) => c.currentOutcomeStatus === statusFilter);
  if (siteFilter) rows = rows.filter((c) => (employeeById(c.employeeId)?.site ?? "").toLowerCase() === siteFilter.toLowerCase());
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  rows = rows.slice(0, limit);
  const results = rows.map((c) => {
    const emp = employeeById(c.employeeId);
    return {
      caseId: c.id,
      employeeExternalId: c.employeeId,
      employeeName: emp?.name ?? c.employeeId,
      site: emp?.site ?? null,
      measureName: MEASURES[c.measureId]?.name ?? c.measureId,
      measureVersion: measureVersionOf(c.measureId),
      evaluationPeriod: c.evaluationPeriod,
      outcomeStatus: c.currentOutcomeStatus,
      priority: c.priority,
      nextAction: c.nextAction ?? null,
      assignee: c.assignee,
      updatedAt: c.updatedAt,
    };
  });
  return {
    results,
    returned: results.length,
    limit,
    filters: { measureName: measureNameFilter, site: siteFilter, status: statusFilter },
  };
}

async function explainRule(args: JsonRecord, deps: McpToolDeps): Promise<unknown> {
  if (!(args.measureId != null && String(args.measureId).trim()) && !(args.measureName != null && String(args.measureName).trim())) {
    return safeError("INVALID_ARGUMENT", "measureId or measureName is required");
  }
  const rec = await resolveMeasure(deps, args);
  if (!rec) return safeError("MEASURE_NOT_FOUND", "Measure not found");
  const detail = toMeasureDetail(rec);
  const cqlText = detail.cqlText ?? "";
  const cqlDefines = [...cqlText.matchAll(/define\s+"([^"]+)"\s*:/gi)].map((m) => m[1]!);
  return {
    measureName: detail.name,
    policyRef: detail.policyRef,
    description: detail.description,
    eligibility: detail.eligibilityCriteria,
    exclusions: detail.exclusions,
    complianceWindow: detail.complianceWindow,
    requiredDataElements: detail.requiredDataElements,
    cqlDefines,
    attachedValueSets: [],
    source: "deterministic_metadata",
  };
}

async function getMeasureTraceability(args: JsonRecord, deps: McpToolDeps): Promise<unknown> {
  if (!(args.measureId != null && String(args.measureId).trim()) && !(args.measureName != null && String(args.measureName).trim())) {
    return safeError("INVALID_ARGUMENT", "measureId or measureName is required");
  }
  const rec = await resolveMeasure(deps, args);
  if (!rec) return safeError("MEASURE_NOT_FOUND", "Measure not found");
  return generateTraceability(rec);
}

async function listDataQualityGaps(args: JsonRecord, deps: McpToolDeps): Promise<unknown> {
  if (!(args.measureId != null && String(args.measureId).trim()) && !(args.measureName != null && String(args.measureName).trim())) {
    return safeError("INVALID_ARGUMENT", "measureId or measureName is required");
  }
  const rec = await resolveMeasure(deps, args);
  if (!rec) return safeError("MEASURE_NOT_FOUND", "Measure not found");
  const readiness = await computeDataReadiness({ outcomes: deps.outcomeStore }, rec);
  return {
    measureId: rec.measureId,
    overallStatus: readiness.overallStatus,
    blockers: readiness.blockers,
    warnings: readiness.warnings,
    elementReadiness: readiness.requiredElements,
  };
}

// ---- registry ----------------------------------------------------------------

export const MCP_TOOLS: McpTool[] = [
  {
    name: "get_case",
    description: "Get full case detail by caseId",
    inputSchema: { type: "object", properties: { caseId: { type: "string" } }, required: ["caseId"] },
    roles: [CM, ADMIN],
    sensitivity: "restricted",
    handler: getCase,
  },
  {
    name: "list_cases",
    description: "List case summaries with optional status and measure filter (measureId or measureName)",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["open", "closed", "all"] }, measureId: { type: "string" }, measureName: { type: "string" } } },
    roles: [CM, ADMIN],
    sensitivity: "restricted",
    handler: listCases,
  },
  {
    name: "get_run_summary",
    description: "Get run metadata and outcome counts by runId. If runId is omitted, returns latest run.",
    inputSchema: { type: "object", properties: { runId: { type: "string" } } },
    roles: [CM, ADMIN],
    sensitivity: "internal",
    handler: getRunSummary,
  },
  {
    name: "list_measures",
    description: "List measures with optional lifecycle-status filter",
    inputSchema: { type: "object", properties: { status: { type: "string" } } },
    roles: [AUTHOR, APPROVER, CM, ADMIN],
    sensitivity: "internal",
    handler: listMeasures,
  },
  {
    name: "get_measure_version",
    description: "Get latest active measure detail by measureId or measureName",
    inputSchema: { type: "object", properties: { measureId: { type: "string" }, measureName: { type: "string" } } },
    roles: [AUTHOR, APPROVER, CM, ADMIN],
    sensitivity: "restricted",
    handler: getMeasureVersion,
  },
  {
    name: "list_runs",
    description: "List run summaries with optional measure filter",
    inputSchema: { type: "object", properties: { measureId: { type: "string" }, limit: { type: "number" } } },
    roles: [CM, ADMIN],
    sensitivity: "internal",
    handler: listRuns,
  },
  {
    name: "explain_outcome",
    description: "Explain why a case was flagged using deterministic evidence fields",
    inputSchema: { type: "object", properties: { caseId: { type: "string" } }, required: ["caseId"] },
    roles: [CM, ADMIN],
    sensitivity: "restricted",
    handler: explainOutcome,
  },
  {
    name: "get_employee",
    description: "Get employee summary and latest compliance outcomes by employeeExternalId",
    inputSchema: { type: "object", properties: { employeeExternalId: { type: "string" } }, required: ["employeeExternalId"] },
    roles: [CM, ADMIN],
    sensitivity: "restricted",
    handler: getEmployee,
  },
  {
    name: "check_compliance",
    description:
      "Return latest or preview compliance status for an employee/measure. mode=latest retrieves the persisted outcome; mode=preview returns the same data labeled as preview (no official records created). AI is never used.",
    inputSchema: {
      type: "object",
      properties: { employeeExternalId: { type: "string" }, measureName: { type: "string" }, evaluationDate: { type: "string" }, mode: { type: "string", enum: ["latest", "preview"] } },
      required: ["employeeExternalId", "measureName"],
    },
    roles: [CM, ADMIN],
    sensitivity: "restricted",
    handler: checkCompliance,
  },
  {
    name: "list_noncompliant",
    description: "List non-compliant open cases filtered by measureName, site, and outcome status. Default limit 25, max 100.",
    inputSchema: { type: "object", properties: { measureName: { type: "string" }, site: { type: "string" }, status: { type: "string", enum: ["DUE_SOON", "OVERDUE", "MISSING_DATA"] }, limit: { type: "number" } } },
    roles: [CM, ADMIN],
    sensitivity: "restricted",
    handler: listNoncompliant,
  },
  {
    name: "explain_rule",
    description:
      "Explain measure rule logic from deterministic measure metadata: policy ref, description, eligibility, compliance window, required data elements, CQL defines, and value sets. Does not use AI.",
    inputSchema: { type: "object", properties: { measureName: { type: "string" }, measureId: { type: "string" } }, required: [] },
    roles: [AUTHOR, APPROVER, CM, ADMIN],
    sensitivity: "internal",
    handler: explainRule,
  },
  {
    name: "get_measure_traceability",
    description: "Return policy-to-evidence traceability matrix rows and gaps for a measure. Uses the same backend as the traceability endpoint.",
    inputSchema: { type: "object", properties: { measureName: { type: "string" }, measureId: { type: "string" } } },
    roles: [AUTHOR, APPROVER, CM, ADMIN],
    sensitivity: "internal",
    handler: getMeasureTraceability,
  },
  {
    name: "list_data_quality_gaps",
    description: "Return data readiness gaps and blockers for a measure. Uses the data readiness backend service.",
    inputSchema: { type: "object", properties: { measureName: { type: "string" }, measureId: { type: "string" } } },
    roles: [AUTHOR, APPROVER, CM, ADMIN],
    sensitivity: "internal",
    handler: listDataQualityGaps,
  },
];

export const MCP_TOOLS_BY_NAME: Record<string, McpTool> = Object.fromEntries(MCP_TOOLS.map((t) => [t.name, t]));

export { ToolArgError };
