// TS mirror of the GET /api/compliance/roster contract (backend-ts/src/compliance/*). Kept in sync by
// hand; the read model owns the vocabulary — the UI renders these strings verbatim (ADR-008).
export type PanelId = "immunizations" | "osha" | "wellness";

export type DisplayState =
  | "COMPLIANT"
  | "DUE_SOON"
  | "OVERDUE"
  | "MISSING_DATA"
  | "EXCLUDED"
  | "DECLINED"
  | "IN_PROGRESS"
  | "NA"
  // The E11.3 segment-applicability overlay (backend roster-read-model): a measure that doesn't apply to
  // a subject's cohort. Distinct from NA ("not evaluated"); rendered de-emphasized like NA (ComplianceChip).
  | "NOT_APPLICABLE";

export interface RosterColumn {
  measureId: string;
  name: string;
  complianceClass: "PERMANENT" | "RECURRING";
}

export interface RosterCell {
  status: DisplayState;
  method: string;
  evidenceRef?: { runId: string; outcomeId: string };
}

export interface RosterRow {
  subject: { externalId: string; name: string; role: string; site: string; tenantId: string; tenantName: string };
  cells: Record<string, RosterCell>;
}

// GET /api/tenants — the WebChart systems for the multi-tenant selector (E13 PR-1).
export interface TenantOption {
  id: string;
  name: string;
}

export interface Roster {
  panel: PanelId;
  columns: RosterColumn[];
  rows: RosterRow[];
}

// Panel selector options (labels mirror the UW "Vaccine Compliance" panels + our OSHA/wellness split).
export const PANEL_OPTIONS: ReadonlyArray<{ id: PanelId; label: string }> = [
  { id: "immunizations", label: "Immunizations" },
  { id: "osha", label: "OSHA Surveillance" },
  { id: "wellness", label: "Wellness & eCQM" }
];
