// Frontend mirror of the backend segment shapes (the API is untyped JSON). See backend
// backend-ts/src/stores/segment-store.ts. Segments configure applicability only (ADR-016).
export type OverrideMode = "INCLUDE" | "EXCLUDE";
export type ConditionAttr = "role" | "site";
export type ConditionOp = "equals" | "contains" | "in";

export interface SegmentCondition {
  attr: ConditionAttr;
  op: ConditionOp;
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
export interface Segment {
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
/** The editable body POSTed/PUT to /api/segments. */
export interface SegmentDraft {
  name: string;
  description: string;
  enabled: boolean;
  rule: SegmentRule;
  measureIds: string[];
  overrides: SegmentOverride[];
}
/** A directory hit from GET /api/employees/search. */
export interface DirectoryEmployee {
  externalId: string;
  name: string;
  role: string;
  site: string;
}
