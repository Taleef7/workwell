/**
 * Which CQL defines an official outcome records as `evidence_json.cqlFacts` (#875): per measure and
 * logic, the defines whose values say what the measure found for a patient ("the result and its date").
 *
 * **CQL decides everything clinical.** Each name here is a define in the measure's own main library,
 * and its value is recorded as CQL computed it (`renderCqlValue` in the executor package). Nothing in
 * TypeScript picks the newest reading, decides adult or adolescent, or chooses which of a resource's
 * dates is "the" date. The one date column the report fills comes only from `dateDefine`, a define the
 * ELM declares as a single Date or DateTime (a test reads each vendored bundle and holds that).
 *
 * A logic with no entry records nothing, and the report says its logic exposes no such define. CMS125
 * is one: CMS's 2026 logic reads that a mammogram was performed and exposes no define with its date.
 *
 * Bump `CQL_FACTS_SPEC_VERSION` when an entry's names change, so a row says which list it was recorded
 * under. Official rows are never reused across runs today (`incremental-eval.ts`); reusing one would
 * need the version in the fingerprint.
 */
export const CQL_FACTS_SPEC_VERSION = 1;

/**
 * The executor's `DefineValue`, restated so this module (read by the report as well as the adapter)
 * stays outside the executor package's import allowlist (`fqm-isolation.test.ts`).
 */
export interface DefineValue {
  define: string;
  value: string | null;
}

export interface FactsSpec {
  /** The main library the names belong to. Nothing is recorded when the artifact's library differs. */
  library: string;
  /** Defines whose value is evidence for the rates in `exposedRates`: a value present is something found. */
  evidence: readonly string[];
  /** Recorded and shown, never counted as evidence: what the patient's place in the measure rests on. */
  context?: readonly string[];
  /** The define whose single CQL Date or DateTime value is the evidence date. Must be one of `evidence`. */
  dateDefine?: string;
  /** CQL's own answer that nothing was found (CMS122). Recorded; its value `true` is NONE_FOUND. */
  noneFoundDefine?: string;
  /** The rates (0-based, in the artifact's group order) the evidence speaks to; every rate when absent. */
  exposedRates?: readonly number[];
}

export type LogicKind = "official" | "derived";

const CMS2_SCREENINGS = [
  "Most Recent Adolescent Depression Screening",
  "Most Recent Adult Depression Screening",
  "Follow Up Intervention for Positive Adolescent Depression Screening",
  "Follow Up Intervention for Positive Adult Depression Screening",
];
const CMS130_SCREENINGS = [
  "Fecal Occult Blood Test Performed",
  "Stool DNA with FIT Test Performed",
  "Flexible Sigmoidoscopy Performed",
  "CT Colonography Performed",
  "Colonoscopy Performed",
];
const CMS165_READINGS = [
  "Most Recent Blood Pressure Day",
  "Lowest Systolic Reading on Most Recent Blood Pressure Day",
  "Lowest Diastolic Reading on Most Recent Blood Pressure Day",
];
const CMS137_INITIATION = {
  context: ["First SUD Episode During Measurement Period"],
  evidence: ["Treatment Initiation With Non Medication Intervention Dates", "Treatment Initiation With Medication Order Dates"],
  // Initiation only: no define names the engagement treatments, so the Engagement rate is not exposed.
  exposedRates: [0],
};

const FACTS: Readonly<Record<string, Partial<Record<LogicKind, FactsSpec>>>> = {
  cms122: {
    official: {
      library: "CMS122FHIRDiabetesAssessGT9Pct",
      evidence: ["Most Recent Glycemic Status Date", "Lowest Glycemic Status Assessment Reading on Most Recent Day"],
      dateDefine: "Most Recent Glycemic Status Date",
      noneFoundDefine: "Has No Record Of Glycemic Status Assessment",
    },
    derived: {
      library: "WorkWellCMS122Translation2027",
      // "Most Recent Glycemic Status Assessment" is the one the 2027 Numerator reads; the lowest numerical
      // reading on the most recent day may be a different observation. Both are shown, each by name.
      evidence: [
        "Most Recent Glycemic Status Date",
        "Most Recent Glycemic Status Assessment",
        "Lowest Glycemic Status Assessment With Numerical Result On Most Recent Day",
      ],
      dateDefine: "Most Recent Glycemic Status Date",
      noneFoundDefine: "Has No Record Of Glycemic Status Assessment",
    },
  },
  cms165: {
    official: { library: "CMS165FHIRControllingHighBP", evidence: CMS165_READINGS, dateDefine: "Most Recent Blood Pressure Day" },
    derived: { library: "WorkWellCMS165Translation2027", evidence: CMS165_READINGS, dateDefine: "Most Recent Blood Pressure Day" },
  },
  cms2: {
    official: { library: "CMS2FHIRPCSDepScreenAndFollowUp", evidence: CMS2_SCREENINGS },
    derived: {
      library: "WorkWellCMS2Translation2027",
      evidence: [
        ...CMS2_SCREENINGS,
        "Most Recent Adolescent Depression Screening Positive and Depression Management Active",
        "Most Recent Adolescent Depression Screening Positive and Depression Medication Active",
        "Most Recent Adult Depression Screening Positive and Depression Management Active",
        "Most Recent Adult Depression Screening Positive and Depression Medication Active",
      ],
    },
  },
  cms130: {
    official: { library: "CMS130FHIRColorectalCancerScrn", evidence: CMS130_SCREENINGS },
    derived: { library: "WorkWellCMS130Translation2027", evidence: CMS130_SCREENINGS },
  },
  cms137: {
    official: { library: "CMS137FHIRSUDTxInitEngagement", ...CMS137_INITIATION },
    derived: { library: "WorkWellCMS137Translation2027", ...CMS137_INITIATION },
  },
};

export function factsSpecFor(measureId: string, kind: LogicKind): FactsSpec | undefined {
  return FACTS[measureId]?.[kind];
}

/** Every measure and logic with an entry, for the test that reads each one against its vendored bundle. */
export function factsSpecEntries(): Array<{ measureId: string; kind: LogicKind; spec: FactsSpec }> {
  return Object.entries(FACTS).flatMap(([measureId, byKind]) =>
    (Object.entries(byKind) as Array<[LogicKind, FactsSpec]>).map(([kind, spec]) => ({ measureId, kind, spec })),
  );
}

/** The defines a calculation is asked to record under `spec`, each once, in the order they are shown. */
export function recordedDefines(spec: FactsSpec): string[] {
  // Context first: CMS137's episode reads before the treatment dates that follow it.
  return [...new Set([...(spec.context ?? []), ...spec.evidence, ...(spec.noneFoundDefine ? [spec.noneFoundDefine] : [])])];
}

/** `evidence_json.cqlFacts`: the recorded defines with a value, in spec order. */
export interface CqlFacts {
  spec: number;
  values: Array<{ define: string; value: string }>;
}

type Rate = ReadonlyArray<{ populationType: string; result: boolean }>;

/**
 * The measure scores this patient on this rate: in its initial population and denominator, and in
 * neither its denominator exclusions nor its exceptions. The one test both the recording and the
 * report's `NOT_APPLICABLE` read, so the two cannot disagree about who has facts.
 */
export function isScoredRate(rate: { ipp: boolean; denom: boolean; denex: boolean; denexcep: boolean }): boolean {
  return rate.ipp && rate.denom && !rate.denex && !rate.denexcep;
}

/**
 * The evidence as an AI surface is given it: without `cqlFacts`. The facts are chart values (dates,
 * readings, codings), and no AI client is handed new chart data without an owner decision
 * (`AI_GUARDRAILS` §6): the OpenAI explain prompt and MCP `get_case` read evidence through this. Staff
 * screens and the report read the facts as they are.
 */
export function withoutCqlFacts<T>(evidence: T): T {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || !Object.prototype.hasOwnProperty.call(evidence, "cqlFacts")) {
    return evidence;
  }
  const { cqlFacts: _facts, ...rest } = evidence as Record<string, unknown>;
  return rest as T;
}

/** A persisted `cqlFacts`, or null when the value is not one (a hand-edited or foreign row). */
export function readCqlFacts(value: unknown): CqlFacts | null {
  if (!value || typeof value !== "object") return null;
  const { spec, values } = value as { spec?: unknown; values?: unknown };
  if (typeof spec !== "number" || !Array.isArray(values)) return null;
  const read: CqlFacts["values"] = [];
  for (const entry of values) {
    const { define, value: text } = (entry ?? {}) as { define?: unknown; value?: unknown };
    if (typeof define !== "string" || typeof text !== "string") return null;
    read.push({ define, value: text });
  }
  return { spec, values: read };
}

/**
 * The facts to persist for one subject, or none.
 *
 * Recorded only for a patient the measure scores on at least one rate (`isScoredRate`). Everyone else's
 * values would describe a measure that does not apply to them. A scored patient with nothing found
 * still gets `values: []`, so a report can tell "the run looked and CQL found nothing" from "the run did
 * not record facts".
 */
export function cqlFactsFor(rates: readonly Rate[], defineValues: readonly DefineValue[] | undefined): CqlFacts | undefined {
  if (!defineValues) return undefined;
  const scored = rates.some((rate) => {
    const flag = (code: string) => rate.find((p) => p.populationType === code)?.result === true;
    return isScoredRate({
      ipp: flag("initial-population"),
      denom: flag("denominator"),
      denex: flag("denominator-exclusion"),
      denexcep: flag("denominator-exception"),
    });
  });
  if (!scored) return undefined;
  return {
    spec: CQL_FACTS_SPEC_VERSION,
    values: defineValues.flatMap(({ define, value }) => (value === null ? [] : [{ define, value }])),
  };
}
