/**
 * Admin dashboard data (#108 admin) — the read surface + simple toggles the `/admin` page
 * loads, ported from the Java admin services. Integration health, scheduler settings, the
 * audit viewer (over the persisted audit_events), terminology mappings, data-element mappings,
 * and outreach templates are served faithfully or from the documented demo seeds; subsystems
 * not yet ported (waivers, outreach_delivery_log persistence, mapping/template/waiver CRUD,
 * demo-reset) return their empty shape so the dashboard renders without errors.
 */
import type { AuditEventRow } from "../stores/case-event-store.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { isWebChartConfigured, type DataSourceEnv } from "../engine/ingress/data-source.ts";
import { DEPLOYMENT_PROFILE, type SubjectTerm } from "../config/deployment-profile.ts";

// ---- integration health ---------------------------------------------------------
/**
 * One tile on the admin page's integration health card. Every field is read from configuration or
 * from what a run recorded (#627): until then the list was a hardcoded array whose "last sync" was the
 * container's boot time, and a Manual Sync button restamped it and wrote "Manual sync completed"
 * without contacting anything. There is no sync to trigger, so there is no button.
 */
export interface IntegrationHealth {
  integration: string;
  displayName: string;
  /** `healthy` (in-process, running), `configured`, `not-configured` or `simulated`. */
  status: string;
  /** When the integration last did something real (WebChart: the newest run's fetch); otherwise null. */
  lastSyncAt: string | null;
  detail: string;
  config: Record<string, unknown>;
}

export interface IntegrationEnv extends DataSourceEnv {
  OPENAI_API_KEY?: string;
}

/** The newest run's fetch from the WebChart tenant, read from its `RUN_COMPLETED` audit payload. */
export interface WebChartFetch {
  at: string;
  host: string;
  fetchedCount: number;
  degradedCount: number;
  status: string;
}

/**
 * How many recent `RUN_COMPLETED` events the WebChart tile looks through. Only population runs fetch;
 * single-subject reruns also complete, so the window is wide, and the tile says what it scanned.
 */
export const WEBCHART_RUNS_SCANNED = 200;

/** The newest `RUN_COMPLETED` row that fetched from WebChart (rows newest-first), or null. */
export function lastWebChartFetch(rows: readonly AuditEventRow[]): WebChartFetch | null {
  for (const row of rows) {
    const t = row.payload.liveTenant as Partial<WebChartFetch> | undefined;
    if (!t || typeof t !== "object" || typeof t.host !== "string") continue;
    return {
      at: row.occurredAt,
      host: t.host,
      fetchedCount: Number(t.fetchedCount ?? 0),
      degradedCount: Number(t.degradedCount ?? 0),
      status: String(t.status ?? "UNKNOWN"),
    };
  }
  return null;
}

/**
 * The tenant's host, from the base URL alone. Not `webChartConfigFromEnv`: that also parses the private
 * key and throws on a malformed one, which would take down the page an operator opens to diagnose it.
 */
function webChartHost(env: IntegrationEnv): string {
  const baseUrl = (env.WORKWELL_WEBCHART_BASE_URL ?? "").trim();
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Integration health, derived. `fhir`, `mcp`, `ai` and `hris` keep their ids because the data-mapping
 * views key on `fhir`/`hris` (`validateDataMappings`, `sourceFreshness`).
 */
export function listIntegrations(
  env: IntegrationEnv = {},
  lastFetch: WebChartFetch | null = null,
  subjectTerm: SubjectTerm = DEPLOYMENT_PROFILE.subjectTerm,
): IntegrationHealth[] {
  const plural = subjectTerm === "patient" ? "patients" : "employees";
  const webchart = isWebChartConfigured(env);
  const host = webchart ? webChartHost(env) : null;
  // A fetch recorded against another host (the tenant was changed since) is not this tenant's.
  const fetch = webchart && lastFetch && lastFetch.host === host ? lastFetch : null;
  const aiConfigured = !!env.OPENAI_API_KEY?.trim();
  const fetchLine = fetch
    ? `The newest run to fetch from it read ${fetch.fetchedCount} ${plural}, ${fetch.degradedCount} degraded, and ${fetch.status === "FAILED" ? "failed" : "completed"}.`
    : `None of the last ${WEBCHART_RUNS_SCANNED} runs fetched from it.`;
  return [
    {
      integration: "webchart",
      displayName: "WebChart",
      status: webchart ? "configured" : "not-configured",
      lastSyncAt: fetch ? fetch.at : null,
      detail: webchart
        ? `Tenant ${host}. ${fetchLine}`
        : `Not connected: this deployment evaluates synthetic ${plural}.`,
      config: {},
    },
    {
      integration: "fhir",
      displayName: "Measure evaluation",
      status: "healthy",
      lastSyncAt: null,
      // A configured tenant's subjects are appended to the synthetic directory, not swapped for it.
      detail: `The CQL engine runs in this process, over synthetic ${plural}${webchart ? ` and the WebChart feed (${host})` : ""}.`,
      config: {},
    },
    {
      integration: "hris",
      displayName: subjectTerm === "patient" ? "Patient directory" : "Employee directory",
      status: webchart ? "configured" : "simulated",
      lastSyncAt: null,
      detail: webchart ? `Synthetic ${plural}, plus ${plural} from WebChart (${host}).` : `Synthetic ${plural}; no live directory.`,
      config: {},
    },
    {
      integration: "mcp",
      displayName: "MCP server",
      status: "healthy",
      lastSyncAt: null,
      detail: "Read-only MCP tools, served by this process over /sse.",
      config: {},
    },
    {
      integration: "ai",
      displayName: "AI services",
      status: aiConfigured ? "configured" : "not-configured",
      lastSyncAt: null,
      // Whether the key is set, not whether OpenAI answers: nothing probes it, and each AI surface
      // falls back to deterministic text when the model does not answer.
      detail: aiConfigured
        ? "OPENAI_API_KEY is set. Each AI surface falls back to deterministic text if the model does not answer."
        : "OPENAI_API_KEY is not set, so AI surfaces serve deterministic fallbacks only.",
      config: {},
    },
  ];
}

// Terminology mappings moved to value-set governance (#108): they are now persisted in the
// terminology_mappings table (demo rows seeded by value-set-seed.ts) and served from the
// ValueSetStore via /api/admin/terminology-mappings (list + create). See value-set-governance.ts.

// ---- data-element mappings (data readiness source map) -----------------------
// Faithful port of the V012__data_readiness seed (15 mappings × 2 active sources). The granular
// canonicals (procedure.audiogram, waiver.medical, employee.role, …) are what DataReadinessService
// resolves spec labels to — the earlier 4-row stub used coarse canonicals that never matched.
export interface DataElementMapping {
  id: string;
  sourceId: string;
  sourceDisplayName: string;
  sourceType: string;
  canonicalElement: string;
  sourceField: string;
  fhirResourceType: string | null;
  fhirPath: string | null;
  codeSystem: string | null;
  mappingStatus: string;
  lastValidatedAt: string | null;
  notes: string | null;
}

/** Integration-source metadata for the mapping rows (V012 integration_sources seed). */
const SOURCE_META: Record<string, { displayName: string; sourceType: string }> = {
  hris: { displayName: "HRIS", sourceType: "INTERNAL" },
  fhir: { displayName: "FHIR Repository", sourceType: "FHIR_R4" },
};

interface MappingSeed {
  canonicalElement: string;
  sourceId: "hris" | "fhir";
  sourceField: string;
  fhirResourceType?: string;
  fhirPath?: string;
  notes: string;
}
const MAPPING_SEED: MappingSeed[] = [
  { canonicalElement: "employee.role", sourceId: "hris", sourceField: "employee_role", notes: "Employee job role; used for eligibility filtering across all measures" },
  { canonicalElement: "employee.site", sourceId: "hris", sourceField: "employee_site", notes: "Employee work site; used for site-level eligibility filters" },
  { canonicalElement: "programEnrollment.hearingConservation", sourceId: "hris", sourceField: "program_enrollments[hearing_conservation]", notes: "Audiogram eligibility flag" },
  { canonicalElement: "programEnrollment.hazwoper", sourceId: "hris", sourceField: "program_enrollments[hazwoper]", notes: "HAZWOPER surveillance eligibility flag" },
  { canonicalElement: "programEnrollment.tbScreening", sourceId: "hris", sourceField: "program_enrollments[tb_screening]", notes: "TB screening eligibility flag" },
  { canonicalElement: "programEnrollment.clinicalFacing", sourceId: "hris", sourceField: "program_enrollments[clinical_facing]", notes: "Flu vaccine eligibility flag" },
  { canonicalElement: "waiver.hearingConservation", sourceId: "hris", sourceField: "waivers[hearing_conservation]", notes: "Active hearing conservation waiver" },
  { canonicalElement: "waiver.medical", sourceId: "hris", sourceField: "waivers[medical]", notes: "Active medical exemption (TB, HAZWOPER)" },
  { canonicalElement: "waiver.flu", sourceId: "hris", sourceField: "waivers[flu]", notes: "Flu vaccine contraindication flag" },
  { canonicalElement: "procedure.audiogram", sourceId: "fhir", sourceField: "Procedure.performedDateTime", fhirResourceType: "Procedure", fhirPath: "Procedure.where(code in audiogram-vs).performedDateTime", notes: "Most recent audiogram procedure date" },
  { canonicalElement: "procedure.hazwoperExam", sourceId: "fhir", sourceField: "Procedure.performedDateTime", fhirResourceType: "Procedure", fhirPath: "Procedure.where(code in hazwoper-vs).performedDateTime", notes: "Most recent HAZWOPER medical surveillance exam date" },
  { canonicalElement: "procedure.tbScreen", sourceId: "fhir", sourceField: "Procedure.performedDateTime", fhirResourceType: "Procedure", fhirPath: "Procedure.where(code in tb-vs).performedDateTime", notes: "Most recent TB screening date" },
  { canonicalElement: "procedure.fluVaccine", sourceId: "fhir", sourceField: "Immunization.occurrenceDateTime", fhirResourceType: "Immunization", fhirPath: "Immunization.where(vaccineCode in flu-vs).occurrenceDateTime", notes: "Current season flu vaccine date" },
  { canonicalElement: "policy.fluSeason", sourceId: "hris", sourceField: "flu_season_config", notes: "Current flu season start/end window from site policy config" },
];

function toMapping(seed: MappingSeed, lastValidatedAt: string | null, status = "MAPPED"): DataElementMapping {
  const meta = SOURCE_META[seed.sourceId]!;
  return {
    id: `dm-${seed.canonicalElement}`,
    sourceId: seed.sourceId,
    sourceDisplayName: meta.displayName,
    sourceType: meta.sourceType,
    canonicalElement: seed.canonicalElement,
    sourceField: seed.sourceField,
    fhirResourceType: seed.fhirResourceType ?? null,
    fhirPath: seed.fhirPath ?? null,
    codeSystem: null,
    mappingStatus: status,
    lastValidatedAt,
    notes: seed.notes,
  };
}

/** GET /api/admin/data-mappings — the seeded source map (V012), ordered source then canonical. */
export const listDataMappings = (): DataElementMapping[] =>
  MAPPING_SEED.map((s) => toMapping(s, null)).sort((a, b) => (a.sourceId === b.sourceId ? a.canonicalElement.localeCompare(b.canonicalElement) : a.sourceId.localeCompare(b.sourceId)));

/**
 * POST /api/admin/data-mappings/validate — port of DataReadinessService.validateMappings, which marked
 * a DEGRADED source's mappings STALE. The mapped sources (`fhir`, `hris`) are in-process and never
 * degraded (#627 removed the static list that could have said otherwise), so the seed's status stands.
 * Stamps last_validated_at = now. (Static seed → computed view, not a persisted mutation.)
 */
export function validateDataMappings(): DataElementMapping[] {
  const now = new Date().toISOString();
  return listDataMappings().map((m) => ({ ...m, lastValidatedAt: now }));
}

/**
 * Freshness for a mapping source (DataReadinessService.computeFreshness). The in-process sources
 * (`fhir`, `hris`) are read live on every request, never synced, so they are always FRESH; anything
 * else has no freshness to report.
 */
export function sourceFreshness(sourceId: string): string {
  return sourceId === "fhir" || sourceId === "hris" ? "FRESH" : "UNKNOWN";
}

// Outreach templates moved to admin write CRUD (#108): persisted in the outreach_templates table
// (V007 demo seed), served + created/updated via the OutreachTemplateStore + admin/outreach-templates.ts.

// ---- audit viewer (over the persisted audit_events) -------------------------
export interface AdminAuditRow {
  occurredAt: string;
  eventType: string;
  scope: string;
  caseId: string | null;
  runId: string | null;
  measureName: string | null;
  employeeExternalId: string | null;
  actor: string | null;
  detail: string | null;
}

/**
 * The admin audit "scope" the page filters on: CASE_VIEWED is `access`, everything else is
 * `mutation` (Java AuditQueryService — access review vs action history). NOT a per-entity scope.
 */
export const auditScopeOf = (eventType: string): "access" | "mutation" => (eventType === "CASE_VIEWED" ? "access" : "mutation");

// ---- outreach delivery log (M3) ---------------------------------------------
// No dedicated outreach_delivery_log table on the demo stack; every per-case send writes a
// CASE_OUTREACH_SENT audit event whose payload.action carries recipient/subject/provider/status.
// We derive the admin "Recent outreach" view from those events (newest-first, already bounded).
export interface DeliveryLogEntry {
  id: string;
  caseId: string | null;
  toAddress: string;
  subject: string;
  provider: string;
  status: string;
  sentAt: string | null;
  errorDetail: string | null;
  measureName: string | null;
}

export function toDeliveryLog(events: AuditEventRow[], limit: number): DeliveryLogEntry[] {
  const measureName = (vid: string) => MEASURES[vid.replace(/-v[\d.]+$/, "")]?.name ?? null;
  return events.slice(0, limit).map((e, i) => {
    const action = (e.payload.action ?? {}) as Record<string, unknown>;
    return {
      // index-suffixed so two sends on the same case at the same instant don't collide on the React key
      id: `${e.refCaseId ?? "outreach"}-${e.occurredAt}-${i}`,
      caseId: e.refCaseId,
      toAddress: String(action.toAddress ?? "—"),
      subject: String(action.subject ?? action.templateName ?? "Outreach"),
      provider: String(action.deliveryProvider ?? "simulated"),
      status: String(action.emailDeliveryStatus ?? action.deliveryStatus ?? "SIMULATED"),
      sentAt: typeof action.sentAt === "string" ? action.sentAt : e.occurredAt,
      errorDetail: typeof action.errorDetail === "string" ? action.errorDetail : null,
      measureName: e.refMeasureVersionId ? measureName(e.refMeasureVersionId) : null,
    };
  });
}

export function toAdminAuditRows(events: AuditEventRow[], caseEmployee: Map<string, string>, scope: string, limit: number): AdminAuditRow[] {
  // scope: "access" → CASE_VIEWED; "mutation"/"mutations" → everything else; "all"/blank → no filter.
  const raw = scope?.trim().toLowerCase();
  const wanted = raw === "access" ? "access" : raw === "mutation" || raw === "mutations" ? "mutation" : null;
  const measureName = (vid: string) => MEASURES[vid.replace(/-v[\d.]+$/, "")]?.name ?? null;
  // `events` arrives newest-first (recentAuditEvents ORDER BY occurred_at DESC) — no reverse/copy needed.
  return events
    .map((e) => ({
      occurredAt: e.occurredAt,
      eventType: e.eventType,
      scope: auditScopeOf(e.eventType),
      caseId: e.refCaseId,
      runId: e.refRunId,
      measureName: e.refMeasureVersionId ? measureName(e.refMeasureVersionId) : null,
      employeeExternalId:
        (e.payload.subjectId as string | undefined) ??
        (e.payload.employeeId as string | undefined) ??
        (e.refCaseId ? caseEmployee.get(e.refCaseId) ?? null : null),
      actor: e.actor,
      // Pretty-printed so the admin audit viewer's <pre> renders a readable tree, not a single-line blob.
      detail: JSON.stringify(e.payload, null, 2),
    }))
    .filter((r) => !wanted || r.scope === wanted)
    .slice(0, limit);
}
