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
