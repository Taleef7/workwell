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

// ---- integration health (DATA_MODEL §3.13 seeded ids: fhir/mcp/ai/hris) ------
export interface IntegrationHealth {
  integration: string;
  displayName: string;
  status: string;
  lastSyncAt: string | null;
  detail: string;
  config: Record<string, unknown>;
}

const INTEGRATIONS: IntegrationHealth[] = [
  { integration: "fhir", displayName: "FHIR Repository", status: "healthy", lastSyncAt: null, detail: "In-process CQL/FHIR evaluation (synthetic adapter).", config: {} },
  { integration: "mcp", displayName: "MCP Server", status: "healthy", lastSyncAt: null, detail: "Read-only MCP tools over /sse.", config: {} },
  { integration: "ai", displayName: "AI Services", status: "healthy", lastSyncAt: null, detail: "OpenAI-backed draft/explain surfaces with deterministic fallback.", config: {} },
  { integration: "hris", displayName: "HRIS Sync", status: "simulated", lastSyncAt: null, detail: "Synthetic employee directory (no live HRIS).", config: {} },
];
const INTEGRATION_IDS = new Set(INTEGRATIONS.map((i) => i.integration));

export const listIntegrations = (): IntegrationHealth[] => INTEGRATIONS.map((i) => ({ ...i }));

/**
 * Manual sync — whitelisted to {fhir,mcp,ai,hris}; null when unknown (→404). The update is
 * PERSISTED into INTEGRATIONS so the page's subsequent GET /api/admin/integrations reload
 * reflects the new lastSyncAt/detail (the frontend discards the POST body and refetches).
 */
export function syncIntegration(integration: string): IntegrationHealth | null {
  const entry = INTEGRATIONS.find((i) => i.integration === integration);
  if (!entry) return null;
  entry.lastSyncAt = new Date().toISOString();
  entry.detail = `Manual sync completed (${entry.status}).`;
  return { ...entry };
}

// ---- scheduler (in-process toggle; resets on restart — demo settings) --------
export interface SchedulerStatus {
  enabled: boolean;
  cron: string;
  nextFireAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string;
}
let schedulerEnabled = false;
const CRON = "0 0 6 * * *";
export const schedulerStatus = (): SchedulerStatus => ({ enabled: schedulerEnabled, cron: CRON, nextFireAt: null, lastRunAt: null, lastRunStatus: "unknown" });
export function setSchedulerEnabled(enabled: boolean): SchedulerStatus {
  schedulerEnabled = enabled;
  return schedulerStatus();
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
 * POST /api/admin/data-mappings/validate — port of DataReadinessService.validateMappings: a source
 * whose integration health is DEGRADED marks its mappings STALE; HEALTHY restores MAPPED; otherwise
 * unchanged. Stamps last_validated_at = now. (Static seed → computed view, not a persisted mutation.)
 */
export function validateDataMappings(): DataElementMapping[] {
  const now = new Date().toISOString();
  const sourceStatus = (sourceId: string): string => {
    const ih = INTEGRATIONS.find((i) => i.integration === sourceId);
    if (!ih) return "UNKNOWN";
    return ih.status === "healthy" ? "HEALTHY" : ih.status === "degraded" ? "DEGRADED" : "UNKNOWN";
  };
  return listDataMappings().map((m) => {
    const status = sourceStatus(m.sourceId) === "DEGRADED" ? "STALE" : m.mappingStatus;
    return { ...m, mappingStatus: status, lastValidatedAt: now };
  });
}

/** Freshness for a source from its integration-health last sync (DataReadinessService.computeFreshness). */
export function sourceFreshness(sourceId: string): string {
  const ih = INTEGRATIONS.find((i) => i.integration === sourceId);
  if (!ih) return "UNKNOWN";
  if (ih.lastSyncAt == null) return sourceId === "hris" || sourceId === "fhir" ? "FRESH" : "UNKNOWN";
  const hoursAgo = (Date.now() - new Date(ih.lastSyncAt).getTime()) / 3_600_000;
  if (hoursAgo <= 24) return "FRESH";
  if (hoursAgo <= 168) return "STALE";
  return "VERY_STALE";
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

export function toAdminAuditRows(events: AuditEventRow[], caseEmployee: Map<string, string>, scope: string, limit: number): AdminAuditRow[] {
  // scope: "access" → CASE_VIEWED; "mutation"/"mutations" → everything else; "all"/blank → no filter.
  const raw = scope?.trim().toLowerCase();
  const wanted = raw === "access" ? "access" : raw === "mutation" || raw === "mutations" ? "mutation" : null;
  const measureName = (vid: string) => MEASURES[vid.replace(/-v[\d.]+$/, "")]?.name ?? null;
  return events
    .slice()
    .reverse() // newest-first for the viewer
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
      detail: JSON.stringify(e.payload),
    }))
    .filter((r) => !wanted || r.scope === wanted)
    .slice(0, limit);
}
