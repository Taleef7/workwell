/**
 * E14 (#186) standards fidelity diff — assemble a documented comparison of WorkWell's authored measure
 * against an official eCQM reference. PURE: no DB, no fs, no engine. STRUCTURAL/DEFINITIONAL — it does NOT
 * execute the official CQL and does NOT diff outcomes (that is PR-2). Never affects a compliance outcome.
 */
import type { Coverage, OfficialMeasureReference, Population } from "./reference-types.ts";

/**
 * A deliberate DTO copy of an OfficialCriterion for the fidelity wire contract — decouples the
 * report's public shape from the reference's internal shape, so the near-duplication is intentional.
 */
export interface CriterionFidelity {
  population: Population;
  key: string;
  description: string;
  coverage: Coverage;
  note: string;
  valueSetOids: string[];
}

export interface ValueSetFidelity {
  name: string;
  oid: string;
  concept: string;
  /** Does WorkWell's authored measure represent this official value-set concept? */
  workwellRepresented: boolean;
  workwellValueSet?: string;
  note: string;
}

export interface FidelityReport {
  measureId: string;
  ecqmId: string;
  title: string;
  version: string;
  steward: string;
  provenance: OfficialMeasureReference["provenance"];
  criteria: CriterionFidelity[];
  valueSets: ValueSetFidelity[];
  summary: {
    covered: number;
    simplified: number;
    omitted: number;
    officialValueSetCount: number;
    workwellValueSetCount: number;
    headline: string;
  };
  disclaimer: string;
}

const DISCLAIMER =
  "Structural/definitional fidelity diff: WorkWell's authored (simplified) measure vs the official eCQM " +
  "specification. It does not execute the official CQL or diff evaluated outcomes (deferred to E14 PR-2). " +
  "CQL Outcome Status remains the sole compliance authority (ADR-008).";

export function computeFidelity(ref: OfficialMeasureReference): FidelityReport {
  const criteria: CriterionFidelity[] = ref.criteria.map((c) => ({
    population: c.population,
    key: c.key,
    description: c.description,
    coverage: c.coverage,
    note: c.note,
    valueSetOids: c.valueSetOids,
  }));

  // Value-set fidelity: join each official value set to its concept's WorkWell coverage.
  const coverageByConcept = new Map(ref.workwellValueSetCoverage.map((w) => [w.concept, w]));
  const valueSets: ValueSetFidelity[] = ref.valueSets.map((vs) => {
    const w = coverageByConcept.get(vs.concept);
    return {
      name: vs.name,
      oid: vs.oid,
      concept: vs.concept,
      workwellRepresented: w?.represented ?? false,
      workwellValueSet: w?.workwellValueSet,
      note: w?.note ?? "No WorkWell value set represents this concept.",
    };
  });

  const covered = criteria.filter((c) => c.coverage === "COVERED").length;
  const simplified = criteria.filter((c) => c.coverage === "SIMPLIFIED").length;
  const omitted = criteria.filter((c) => c.coverage === "OMITTED").length;
  const workwellValueSetCount = new Set(
    ref.workwellValueSetCoverage.filter((w) => w.represented && w.workwellValueSet).map((w) => w.workwellValueSet!),
  ).size;
  const officialValueSetCount = ref.valueSets.length;

  // The omission example is measure-specific data (omissionSummary), not baked into this generic
  // function — included as a parenthetical only when present, so the headline stays grammatical without it.
  const omitClause = ref.omissionSummary ? ` (e.g. ${ref.omissionSummary})` : "";
  const headline =
    `WorkWell's authored ${ref.measureId} covers ${covered} and simplifies ${simplified} of ${criteria.length} ` +
    `official ${ref.ecqmId} criteria, omitting ${omitted}${omitClause}; ` +
    `it references ${workwellValueSetCount} local value sets vs ${officialValueSetCount} official VSAC value sets.`;

  return {
    measureId: ref.measureId,
    ecqmId: ref.ecqmId,
    title: ref.title,
    version: ref.version,
    steward: ref.steward,
    provenance: ref.provenance,
    criteria,
    valueSets,
    summary: { covered, simplified, omitted, officialValueSetCount, workwellValueSetCount, headline },
    disclaimer: DISCLAIMER,
  };
}
