import { SUBJECT } from "@/lib/terminology";

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
  // Evaluated and outside the measure's own initial population (ADR-078/079) — a result, not a gap.
  | "OUT_OF_POPULATION"
  | "NA"
  // The E11.3 segment-applicability overlay (backend roster-read-model): a measure that doesn't apply to
  // a subject's cohort. Distinct from NA ("not evaluated"); rendered de-emphasized like NA (ComplianceChip).
  | "NOT_APPLICABLE";

export interface RosterColumn {
  measureId: string;
  name: string;
  complianceClass: "PERMANENT" | "RECURRING";
}

/** Who closed the case behind a cell CQL still counts, and when (#569). Display only. */
export interface StaffClosure {
  closedBy: string;
  closedAt: string | null;
  closedReason: string | null;
}

export interface RosterCell {
  status: DisplayState;
  method: string;
  evidenceRef?: { runId: string; outcomeId: string };
  /** The canonical bucket the display state was derived from, and the outcome's cycle (#569). */
  canonical?: string;
  evaluationPeriod?: string;
  /**
   * Present only when a person closed this subject's case for this measure IN THIS CYCLE and the
   * winning run still counts the patient as a gap (#569). `status` is unchanged, so every chip count
   * and the status filter are unaffected — this says a person decided not to work the gap, which the
   * grid has to show, because otherwise the patient is on the Overdue list and on nobody's work list
   * with nothing on screen saying why.
   */
  staffClosure?: StaffClosure;
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
  availablePanels?: PanelId[];
  columns: RosterColumn[];
  rows: RosterRow[];
  /**
   * Rows the server withheld because the measure in scope does not describe those patients
   * (ADR-078/079). Only ever non-zero when one measure is in scope. Rendered beside the count, so a
   * shorter list is explained rather than merely shorter.
   */
  notInPopulation?: number;
}

// Panel selector options (labels mirror the UW "Vaccine Compliance" panels + our OSHA/wellness split).
export const PANEL_OPTIONS: ReadonlyArray<{ id: PanelId; label: string }> = [
  { id: "immunizations", label: "Immunizations" },
  { id: "osha", label: "OSHA Surveillance" },
  { id: "wellness", label: SUBJECT.singular === "patient" ? "Quality measures" : "Wellness & eCQM" }
];
