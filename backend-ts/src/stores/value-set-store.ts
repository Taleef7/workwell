/**
 * ValueSetStore contract (#108 value-set governance) — the value-set registry, the
 * measure↔value-set links, and the terminology mappings. Mirrors the canonical
 * value_sets (V001 + V013), measure_value_set_links (V001), and terminology_mappings (V013)
 * tables. Codes + code-systems are parsed JS values here (the adapters persist them as JSON
 * TEXT on the floor / JSONB+text[] on the ceiling).
 *
 * Backs ValueSetGovernanceService + the catalog value-set methods of MeasureService:
 *   - resolve-check / diff / detail (governance panel + activation gate)
 *   - list / create / attach / detach (Studio Value Sets tab)
 *   - listByVersion (Studio detail + case-detail linked value sets)
 *   - terminology mapping list / create (Admin → Terminology Mappings)
 */

/** One concept code inside a value set's expansion. */
export interface CodeEntry {
  code: string;
  display: string;
  system: string;
}

/** A value-set row with its parsed codes (codes_json) + code systems. */
export interface ValueSetRecord {
  id: string;
  oid: string;
  name: string;
  version: string | null;
  lastResolvedAt: string | null;
  canonicalUrl: string;
  source: string;
  /** Governance lifecycle status (DRAFT/ACTIVE/…) — value_sets.status. */
  governanceStatus: string;
  /** RESOLVED | UNRESOLVED | EMPTY | ERROR | UNKNOWN — value_sets.resolution_status. */
  resolutionStatus: string;
  resolutionError: string;
  expansionHash: string;
  codeSystems: string[];
  codes: CodeEntry[];
}

/** Seed/ensure a value set by stable id (the demo seed; ValueSetGovernanceService.ensureValueSet). */
export interface SeedValueSetInput {
  id: string;
  oid: string;
  name: string;
  version: string;
  codes: CodeEntry[];
  /** Defaults applied by the seed: resolution_status=RESOLVED, status=ACTIVE, source="WorkWell Demo". */
}

export interface TerminologyMappingRecord {
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

export interface CreateTerminologyMappingInput {
  id: string;
  localCode: string;
  localDisplay: string | null;
  localSystem: string;
  standardCode: string;
  standardDisplay: string | null;
  standardSystem: string;
  mappingStatus: string;
  mappingConfidence: number | null;
  notes: string | null;
}

export interface ValueSetStore {
  /** True when no value sets exist yet (the demo-seed guard). */
  isEmpty(): Promise<boolean>;
  /** Upsert a value set by id; sets resolution_status=RESOLVED, status=ACTIVE (demo seed). */
  seedValueSet(input: SeedValueSetInput): Promise<void>;
  /**
   * Replace ONLY a value set's codes (+ derived code_systems), preserving all governance metadata
   * (status, version, name, resolution_status, last_resolved_at). No-op if the id is unknown. Used by the
   * additive immunization-code backfill so it never resets operator-managed metadata. */
  setCodes(id: string, codes: CodeEntry[]): Promise<void>;
  /** Link a measure version to a value set; no-op if already linked (ON CONFLICT DO NOTHING). */
  link(measureVersionId: string, valueSetId: string): Promise<void>;
  /** Remove a measure-version↔value-set link (detach). */
  unlink(measureVersionId: string, valueSetId: string): Promise<void>;
  /** Every value set, ordered name ASC, oid ASC (the Studio catalog). */
  listAll(): Promise<ValueSetRecord[]>;
  /** One value set with codes; null if unknown. */
  getById(id: string): Promise<ValueSetRecord | null>;
  /** Create an empty (no-codes) value set; returns the new id. */
  create(oid: string, name: string, version: string | null): Promise<string>;
  /** Value sets linked to a measure version, ordered name ASC, oid ASC. */
  listByVersion(measureVersionId: string): Promise<ValueSetRecord[]>;
  /** Measures (id+name+version) attached to any of the given value-set ids — diff impact. */
  affectedMeasures(valueSetIds: string[]): Promise<Array<{ measureId: string; measureName: string; version: string }>>;

  /** All terminology mappings, ordered status ASC, local_system ASC, local_code ASC. */
  listTerminologyMappings(): Promise<TerminologyMappingRecord[]>;
  /** Insert a terminology mapping; returns the stored record. */
  createTerminologyMapping(input: CreateTerminologyMappingInput): Promise<TerminologyMappingRecord>;
}
