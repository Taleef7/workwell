/**
 * SegmentStore port (#183 E11.3) — persistence for risk-group segments. A segment maps a cohort
 * (rule_json predicate + per-employee overrides) to an applicable rule-set (measure ids). The
 * port + both adapters (floor + ceiling) back the /api/segments CRUD route and the applicability
 * overlay. Applicability gates case creation + roster display only — never compliance (ADR-016).
 */
export type OverrideMode = "INCLUDE" | "EXCLUDE";

export interface SegmentCondition {
  attr: "role" | "site";
  op: "equals" | "contains" | "in";
  value: string | string[];
}

export interface SegmentRule {
  match: "ANY" | "ALL";
  conditions: SegmentCondition[];
}

export interface SegmentOverride {
  externalId: string;
  mode: OverrideMode;
}

export interface HydratedSegment {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  rule: SegmentRule;
  measureIds: string[];
  overrides: SegmentOverride[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSegmentInput {
  name: string;
  description?: string;
  enabled?: boolean;
  rule: SegmentRule;
  measureIds: string[];
  overrides?: SegmentOverride[];
}

export interface UpdateSegmentPatch {
  name?: string;
  description?: string;
  enabled?: boolean;
  rule?: SegmentRule;
}

export interface SegmentStore {
  /** All segments, hydrated with measures + overrides, ordered by name ASC. */
  listSegments(): Promise<HydratedSegment[]>;
  getSegment(id: string): Promise<HydratedSegment | null>;
  createSegment(input: CreateSegmentInput): Promise<HydratedSegment>;
  /** Patch name/description/enabled/rule (bumps updated_at). null if id unknown. */
  updateSegment(id: string, patch: UpdateSegmentPatch): Promise<HydratedSegment | null>;
  /** Delete the segment and its measures + overrides. No-op if id unknown. */
  deleteSegment(id: string): Promise<void>;
  /** Replace the applicable rule-set (delete-then-insert). */
  setMeasures(id: string, measureIds: string[]): Promise<void>;
  /** Replace the overrides (delete-then-insert). */
  setOverrides(id: string, overrides: SegmentOverride[]): Promise<void>;
}
