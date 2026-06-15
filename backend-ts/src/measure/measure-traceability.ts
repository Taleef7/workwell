/**
 * Measure traceability (#107) — TS port of MeasureTraceabilityService.generate. Builds the
 * policy→spec→CQL→runtime-evidence matrix (rows) + governance gaps for a measure version, purely
 * from the persisted measure record (spec + CQL text + compile status + policy ref). CQL defines
 * are parsed with the same `define "Name":` regex the Java side uses; rows map each policy
 * requirement to the best-matching define + the runtime `why_flagged` evidence keys it produces.
 *
 * Attached value sets (value-set governance, #108) are passed in by the caller (resolved from
 * the ValueSetStore for the measure version); each row carries them and the value-set gap fires
 * only when none are attached — matching the Java side.
 */
import type { MeasureRecord } from "../stores/measure-store.ts";

export interface ValueSetRef {
  name: string;
  oid: string;
  version: string;
}
export interface TestFixtureRef {
  fixtureName: string;
  expectedOutcome: string;
}
export interface TraceabilityRow {
  policyCitation: string;
  policyRequirement: string;
  specField: string;
  specValue: string;
  cqlDefine: string;
  cqlSnippet: string;
  valueSets: ValueSetRef[];
  requiredDataElements: string[];
  testFixtures: TestFixtureRef[];
  runtimeEvidenceKeys: string[];
}
export interface TraceabilityGap {
  severity: string;
  message: string;
}
export interface TraceabilityResponse {
  measureId: string;
  measureVersionId: string;
  measureName: string;
  version: string;
  rows: TraceabilityRow[];
  gaps: TraceabilityGap[];
}

interface CqlDefine {
  name: string;
  snippet: string;
}

const DEFINE_RE = /define\s+"([^"]+)"\s*:/gim;

/** Parse `define "Name":` occurrences + a ~200-char snippet up to the next define (Java parity). */
function parseCqlDefines(cqlText: string): CqlDefine[] {
  if (!cqlText || !cqlText.trim()) return [];
  const starts: number[] = [];
  const names: string[] = [];
  for (const m of cqlText.matchAll(DEFINE_RE)) {
    starts.push(m.index ?? 0);
    names.push(m[1]!);
  }
  return names.map((name, i) => {
    const start = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]! : cqlText.length;
    const snippet = cqlText.slice(start, Math.min(start + 200, end)).trim();
    return { name, snippet };
  });
}

/** First define whose name contains any of the keywords (case-insensitive), in keyword priority order. */
function findDefineByKeywords(defines: CqlDefine[], ...keywords: string[]): CqlDefine | null {
  for (const kw of keywords) {
    const hit = defines.find((d) => d.name.toLowerCase().includes(kw.toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

export function generateTraceability(measure: MeasureRecord, attachedValueSets: ValueSetRef[] = []): TraceabilityResponse {
  const spec = measure.spec;
  const defines = parseCqlDefines(measure.cqlText ?? "");
  const valueSets: ValueSetRef[] = attachedValueSets;
  const policyCitation = measure.policyRef ?? "";
  const requiredDataElements = spec.requiredDataElements ?? [];
  const fixtures: TestFixtureRef[] = (spec.testFixtures ?? []).map((f) => ({ fixtureName: f.fixtureName, expectedOutcome: f.expectedOutcome }));
  const complianceWindow = spec.complianceWindow ?? "";
  const eligibility = spec.eligibilityCriteria ?? { roleFilter: "", siteFilter: "", programEnrollmentText: "" };

  const rows: TraceabilityRow[] = [];

  // Row: eligibility
  const enrollmentText = eligibility.programEnrollmentText ?? "";
  const roleFilter = eligibility.roleFilter ?? "";
  const siteFilter = eligibility.siteFilter ?? "";
  const eligibilitySpecValue =
    (enrollmentText || "") +
    (roleFilter ? `; roles: ${roleFilter}` : "") +
    (siteFilter ? `; sites: ${siteFilter}` : "");
  const eligibilityDefine = findDefineByKeywords(defines, "program", "enrolled", "initial population", "eligib");
  rows.push({
    policyCitation,
    policyRequirement: "Population eligibility for program",
    specField: "eligibilityCriteria",
    specValue: eligibilitySpecValue,
    cqlDefine: eligibilityDefine?.name ?? "",
    cqlSnippet: eligibilityDefine?.snippet ?? "",
    valueSets,
    requiredDataElements,
    testFixtures: fixtures,
    runtimeEvidenceKeys: ["role_eligible", "site_eligible"],
  });

  // Row: exclusion (first exclusion with a label/criteria)
  const exclusions = spec.exclusions ?? [];
  if (exclusions.length > 0) {
    const exclusionLabel = exclusions.map((e) => e.label).find((l) => l) ?? "exclusion";
    const exclusionCriteria = exclusions.map((e) => e.criteriaText).find((c) => c) ?? "";
    const exclusionDefine = findDefineByKeywords(defines, "waiver", "exempt", "exclusion");
    rows.push({
      policyCitation,
      policyRequirement: `Exclusion: ${exclusionLabel}`,
      specField: "exclusions",
      specValue: exclusionCriteria,
      cqlDefine: exclusionDefine?.name ?? "",
      cqlSnippet: exclusionDefine?.snippet ?? "",
      valueSets,
      requiredDataElements: [],
      testFixtures: [],
      runtimeEvidenceKeys: ["waiver_status"],
    });
  }

  // Row: compliance window / recency check
  const recencyDefine = findDefineByKeywords(defines, "most recent", "last", "days since", "date");
  const daysDefine = findDefineByKeywords(defines, "days since", "days over");
  const outcomeDefine = findDefineByKeywords(defines, "outcome status", "outcome");
  rows.push({
    policyCitation,
    policyRequirement: `Compliance window: ${complianceWindow || "see spec"}`,
    specField: "complianceWindow",
    specValue: complianceWindow,
    cqlDefine: recencyDefine?.name ?? outcomeDefine?.name ?? "",
    cqlSnippet: recencyDefine?.snippet ?? outcomeDefine?.snippet ?? "",
    valueSets,
    requiredDataElements,
    testFixtures: fixtures,
    runtimeEvidenceKeys: ["last_exam_date", "compliance_window_days", "days_overdue", "outcome_status"],
  });

  // Row: days/age calculation if a distinct days-define exists
  if (daysDefine && daysDefine.name !== recencyDefine?.name) {
    rows.push({
      policyCitation,
      policyRequirement: "Days elapsed since last exam",
      specField: "complianceWindow",
      specValue: `Threshold: ${complianceWindow}`,
      cqlDefine: daysDefine.name,
      cqlSnippet: daysDefine.snippet,
      valueSets: [],
      requiredDataElements: ["Procedure.performedDateTime"],
      testFixtures: [],
      runtimeEvidenceKeys: ["days_overdue", "compliance_window_days"],
    });
  }

  return {
    measureId: measure.measureId,
    measureVersionId: measure.versionId,
    measureName: measure.name,
    version: measure.version,
    rows,
    gaps: buildGaps(measure, defines, fixtures, valueSets),
  };
}

function buildGaps(measure: MeasureRecord, defines: CqlDefine[], fixtures: TestFixtureRef[], valueSets: ValueSetRef[]): TraceabilityGap[] {
  const gaps: TraceabilityGap[] = [];

  if (!measure.policyRef || !measure.policyRef.trim()) {
    gaps.push({ severity: "WARN", message: "No policy citation set. Add a policy reference in the Spec tab." });
  }

  const cs = measure.compileStatus;
  if (!cs || (cs.toUpperCase() !== "COMPILED" && cs.toUpperCase() !== "WARNINGS")) {
    gaps.push({ severity: "ERROR", message: `CQL compile status is ${cs ?? "UNKNOWN"}. CQL must be compiled before activation.` });
  }

  if (fixtures.length === 0) {
    gaps.push({ severity: "WARN", message: "No test fixtures defined. Add at least one test fixture covering each expected outcome." });
  } else {
    if (!fixtures.some((f) => f.expectedOutcome?.toUpperCase() === "MISSING_DATA")) {
      gaps.push({ severity: "WARN", message: "No test fixture covers MISSING_DATA outcome. Consider adding one for traceability completeness." });
    }
    if (!fixtures.some((f) => f.expectedOutcome?.toUpperCase() === "EXCLUDED")) {
      gaps.push({ severity: "WARN", message: "No test fixture covers EXCLUDED outcome. Consider adding one for traceability completeness." });
    }
  }

  if (valueSets.length === 0) {
    gaps.push({ severity: "WARN", message: "No value sets attached to this measure version. Attach value sets referenced in the CQL." });
  }

  if (defines.length === 0 && measure.cqlText && measure.cqlText.trim()) {
    gaps.push({ severity: "WARN", message: 'No CQL defines found. Ensure CQL uses define "Name": syntax.' });
  }

  return gaps;
}
