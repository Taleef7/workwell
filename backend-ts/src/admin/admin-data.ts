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

// ---- terminology mappings (DATA_MODEL §3.4a demo seeds) ----------------------
export interface TerminologyMapping {
  id: string;
  localCode: string;
  localDisplay: string | null;
  localSystem: string;
  standardCode: string;
  standardDisplay: string | null;
  standardSystem: string;
  mappingStatus: string;
  mappingConfidence: number | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  notes: string | null;
}
const CPT = "http://www.ama-assn.org/go/cpt";
const CVX = "http://hl7.org/fhir/sid/cvx";
export const listTerminologyMappings = (): TerminologyMapping[] => [
  { id: "tm-1", localCode: "LOCAL-AUD-002", localDisplay: "Annual audiogram evaluation", localSystem: "urn:workwell:demo", standardCode: "92557", standardDisplay: "Comprehensive audiometry evaluation", standardSystem: CPT, mappingStatus: "APPROVED", mappingConfidence: 0.98, reviewedBy: "admin@workwell.dev", reviewedAt: "2026-05-12T00:00:00.000Z", notes: null },
  { id: "tm-2", localCode: "LOCAL-TB-001", localDisplay: "PPD skin test placement", localSystem: "urn:workwell:demo", standardCode: "86580", standardDisplay: "Intradermal skin test", standardSystem: CPT, mappingStatus: "APPROVED", mappingConfidence: 0.95, reviewedBy: "admin@workwell.dev", reviewedAt: "2026-05-12T00:00:00.000Z", notes: null },
  { id: "tm-3", localCode: "LOCAL-FLU-001", localDisplay: "Flu vaccine administered", localSystem: "urn:workwell:demo", standardCode: "141", standardDisplay: "Influenza seasonal injectable", standardSystem: CVX, mappingStatus: "APPROVED", mappingConfidence: 0.97, reviewedBy: "admin@workwell.dev", reviewedAt: "2026-05-12T00:00:00.000Z", notes: null },
  { id: "tm-4", localCode: "LOCAL-HAZ-001", localDisplay: "HAZWOPER medical surveillance exam", localSystem: "urn:workwell:demo", standardCode: "hazwoper-exam", standardDisplay: "HAZWOPER Surveillance Exams", standardSystem: "urn:workwell:vs:hazwoper-exams", mappingStatus: "REVIEWED", mappingConfidence: 0.8, reviewedBy: "admin@workwell.dev", reviewedAt: "2026-05-20T00:00:00.000Z", notes: "Internal code; no public standard." },
  { id: "tm-5", localCode: "LOCAL-TB-002", localDisplay: "TB IGRA blood test", localSystem: "urn:workwell:demo", standardCode: "86480", standardDisplay: "Tuberculosis test, cell-mediated immunity", standardSystem: CPT, mappingStatus: "PROPOSED", mappingConfidence: 0.7, reviewedBy: null, reviewedAt: null, notes: "Awaiting review." },
];

// ---- data-element mappings (data readiness source map) -----------------------
export interface DataElementMapping {
  id: string;
  sourceId: string;
  sourceDisplayName: string;
  canonicalElement: string;
  sourceField: string;
  mappingStatus: string;
  lastValidatedAt: string | null;
  notes: string | null;
}
export const listDataMappings = (): DataElementMapping[] => [
  { id: "dm-1", sourceId: "hris", sourceDisplayName: "HRIS Sync", canonicalElement: "Employee.role", sourceField: "job_title", mappingStatus: "MAPPED", lastValidatedAt: "2026-06-01T00:00:00.000Z", notes: null },
  { id: "dm-2", sourceId: "hris", sourceDisplayName: "HRIS Sync", canonicalElement: "Employee.site", sourceField: "location", mappingStatus: "MAPPED", lastValidatedAt: "2026-06-01T00:00:00.000Z", notes: null },
  { id: "dm-3", sourceId: "fhir", sourceDisplayName: "FHIR Repository", canonicalElement: "Procedure.performed", sourceField: "performedDateTime", mappingStatus: "MAPPED", lastValidatedAt: "2026-06-01T00:00:00.000Z", notes: null },
  { id: "dm-4", sourceId: "fhir", sourceDisplayName: "FHIR Repository", canonicalElement: "Immunization.occurrence", sourceField: "occurrenceDateTime", mappingStatus: "MAPPED", lastValidatedAt: "2026-06-01T00:00:00.000Z", notes: null },
];

// ---- outreach templates (built-in default) ----------------------------------
export interface OutreachTemplate {
  id: string;
  name: string;
  subject: string;
  bodyText: string;
  type: string;
  active: boolean;
}
const DEFAULT_TEMPLATE: OutreachTemplate = {
  id: "default-template",
  name: "Default Template",
  subject: "Outreach Reminder for {{measureName}}",
  bodyText: "Hello {{employeeName}}, please complete required follow-up for {{measureName}}.",
  type: "OUTREACH",
  active: true,
};
export const listOutreachTemplates = (): OutreachTemplate[] => [{ ...DEFAULT_TEMPLATE }];
export function findOutreachTemplate(id: string): OutreachTemplate | null {
  return id === DEFAULT_TEMPLATE.id ? { ...DEFAULT_TEMPLATE } : null;
}

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
