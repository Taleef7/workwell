/**
 * MeasureStore contract (#107 measures authoring) — the persisted measure catalog +
 * versions. Seeded from MEASURE_CATALOG on first use; create/lifecycle mutate these rows
 * so the reads (list/detail/versions/activation-readiness) reflect them. One latest version
 * per measure for now (version cloning is a later slice).
 *
 * A `MeasureRecord` denormalizes a measure + its latest version into one row (tags/spec are
 * parsed JS values, not the JSON TEXT/JSONB the adapters store).
 */
import type { MeasureSpec } from "../measure/measure-catalog.ts";

export interface MeasureRecord {
  measureId: string;
  name: string;
  policyRef: string;
  owner: string;
  tags: string[];
  versionId: string;
  version: string;
  status: string;
  spec: MeasureSpec;
  cqlText: string;
  compileStatus: string;
  changeSummary: string | null;
  approvedBy: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SeedMeasureInput {
  measureId: string;
  name: string;
  policyRef: string;
  owner: string;
  tags: string[];
  versionId: string;
  version: string;
  status: string;
  spec: MeasureSpec;
  cqlText: string;
  compileStatus: string;
  createdAt: string;
  changeSummary: string;
}

export interface CreateMeasureInput {
  name: string;
  policyRef: string;
  owner: string;
}

/** A lifecycle status change on a version (+ optional approver / activation stamp). */
export interface StatusChange {
  status: string;
  approvedBy?: string | null;
  /** When true, stamp activated_at = now (the Approved→Active transition). */
  activate?: boolean;
}

export interface MeasureStore {
  isEmpty(): Promise<boolean>;
  /** Seed one measure + its version (used to load MEASURE_CATALOG into an empty store). */
  seedMeasure(input: SeedMeasureInput): Promise<void>;
  /** Latest version per measure (the catalog list / detail source). */
  listLatest(): Promise<MeasureRecord[]>;
  getLatest(measureId: string): Promise<MeasureRecord | null>;
  /** A specific measure version by its version id (the auditor measure-version packet); null if unknown. */
  getByVersionId(versionId: string): Promise<MeasureRecord | null>;
  /** All versions for a measure, newest-first (the version history). */
  listVersions(measureId: string): Promise<MeasureRecord[]>;
  /** Create a new measure with an empty Draft v1.0 version (POST /api/measures). */
  createMeasure(input: CreateMeasureInput): Promise<MeasureRecord>;
  /** Apply a lifecycle status change to a version; touches the measure's updated_at. */
  setVersionStatus(measureId: string, versionId: string, change: StatusChange): Promise<MeasureRecord | null>;
  /**
   * Replace the latest version's `spec_json` (Studio Spec/Tests edits), optionally updating the
   * measure's policy_ref. Touches the measure's updated_at. Returns the updated record, or null
   * when the measure is unknown. (osha_reference_id is not modeled on the TS floor — see route.)
   */
  updateSpec(measureId: string, spec: MeasureSpec, policyRef?: string): Promise<MeasureRecord | null>;
  /**
   * Replace the latest version's `cql_text` (Studio CQL edit), optionally setting compile_status
   * (the compile endpoint). Touches the measure's updated_at. Null when the measure is unknown.
   */
  updateCql(measureId: string, cqlText: string, compileStatus?: string): Promise<MeasureRecord | null>;
}
