/**
 * Official eCQM measure-definition reference (E14 / #186). A sourced, structured transcription of an
 * officially published measure spec, used to diff WorkWell's authored (simplified) measure against it.
 * Descriptive only — never affects a compliance outcome (ADR-008). PR-1 is a STRUCTURAL diff; executing
 * the official CQL for an OUTCOME diff is PR-2 (deferred behind the E3.2 ValueSetResolver seam).
 */
export type Population = "IPP" | "DENOM" | "DENEX" | "NUMER" | "NUMEX";

/** How WorkWell's authored measure handles an official criterion. */
export type Coverage = "COVERED" | "SIMPLIFIED" | "OMITTED";

export interface OfficialValueSet {
  name: string;
  oid: string;
  /** Grouping tag used for the value-set fidelity view, e.g. "Diabetes", "HbA1c", "Hospice". */
  concept: string;
}

export interface OfficialCriterion {
  population: Population;
  /** Stable id, e.g. "age-18-75". */
  key: string;
  /** The official logic in plain terms (sourced). */
  description: string;
  /** OIDs this criterion references (subset of the measure's value sets). */
  valueSetOids: string[];
  /** How WorkWell's authored measure handles it (curated, sourced judgement). */
  coverage: Coverage;
  /** Grounded explanation of the coverage classification. */
  note: string;
}

/** Whether WorkWell's authored measure represents an official value-set concept. */
export interface WorkwellValueSetCoverage {
  concept: string;
  represented: boolean;
  /** The WorkWell (local) value set that represents it, if any. */
  workwellValueSet?: string;
  note: string;
}

export interface OfficialMeasureReference {
  /** WorkWell registry id this references, e.g. "cms122". */
  measureId: string;
  ecqmId: string;
  title: string;
  version: string;
  steward: string;
  scoring: string;
  /** Short, measure-specific example of what WorkWell omits — used in the fidelity headline. */
  omissionSummary?: string;
  provenance: { sourceUrl: string; frozenCodesUrl?: string; retrieved: string };
  criteria: OfficialCriterion[];
  valueSets: OfficialValueSet[];
  workwellValueSetCoverage: WorkwellValueSetCoverage[];
}
