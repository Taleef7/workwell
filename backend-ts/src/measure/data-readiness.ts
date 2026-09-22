/**
 * Data readiness (#108) — TS port of DataReadinessService.computeReadiness. For a measure's
 * `requiredDataElements`, resolves each spec label → a canonical element → its source mapping, then
 * reports per-element mapping status + source freshness + (for clinical elements) the missing-data
 * rate observed in outcomes. Aggregates blockers (UNMAPPED/ERROR) and warnings (stale/missingness)
 * into an overall READY / READY_WITH_WARNINGS / NOT_READY status.
 *
 * Data sources are the V012 static seed (admin-data: listDataMappings + sourceFreshness) — the same
 * reference data the Java migration seeds; missingness comes from the persisted outcomes.
 */
import type { MeasureRecord } from "../stores/measure-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import { listDataMappings, sourceFreshness, type DataElementMapping } from "../admin/admin-data.ts";

export interface RequiredElementReadiness {
  canonicalElement: string;
  label: string;
  sourceId: string | null;
  mappingStatus: string;
  freshnessStatus: string;
  missingnessRate: number;
  sampleMissingEmployees: string[];
}
export interface DataReadinessResponse {
  overallStatus: string;
  requiredElements: RequiredElementReadiness[];
  blockers: string[];
  warnings: string[];
}

// Longest-match-first: specific phrases before general keywords (DataReadinessService.LABEL_TO_CANONICAL).
// NOTE: the generic "program enrollment"/"enrollment" phrases are NOT in this table — enrollment is
// resolved by MEASURE CONTEXT instead (see resolveCanonical), because the same generic spec label
// means a different source per measure. The flat Java table mapped them all to hearingConservation,
// which falsely certified the hearing-conservation source for the HEDIS wellness measures.
const LABEL_TO_CANONICAL: ReadonlyArray<[string, string]> = [
  ["last audiogram date", "procedure.audiogram"],
  ["last tb screening date", "procedure.tbScreen"],
  ["last surveillance exam date", "procedure.hazwoperExam"],
  ["last flu vaccine date", "procedure.fluVaccine"],
  ["contraindication status", "waiver.flu"],
  ["exemption status", "waiver.medical"],
  ["current season", "policy.fluSeason"],
  ["audiogram", "procedure.audiogram"],
  ["tb screening", "procedure.tbScreen"],
  ["surveillance exam", "procedure.hazwoperExam"],
  ["flu vaccine", "procedure.fluVaccine"],
  ["contraindication", "waiver.flu"],
  ["exemption", "waiver.medical"],
  ["season", "policy.fluSeason"],
  ["role", "employee.role"],
  ["site", "employee.site"],
];

// The program-enrollment source canonical per measure (the OSHA programs are seeded in V012; the
// HEDIS wellness measures have no enrollment source, so they fall through to a measure-specific
// canonical that isn't in the seed → honestly reported UNMAPPED rather than mis-certified).
const MEASURE_ENROLLMENT_CANONICAL: Record<string, string> = {
  audiogram: "programEnrollment.hearingConservation",
  hazwoper: "programEnrollment.hazwoper",
  tb_surveillance: "programEnrollment.tbScreening",
  flu_vaccine: "programEnrollment.clinicalFacing",
};

function resolveCanonical(label: string, measureId: string): string | null {
  const lower = label.toLowerCase().trim();
  // Enrollment is measure-specific: don't certify one program's source for another's generic label.
  if (lower.includes("enrollment")) return MEASURE_ENROLLMENT_CANONICAL[measureId] ?? `programEnrollment.${measureId}`;
  for (const [phrase, canonical] of LABEL_TO_CANONICAL) {
    if (lower.includes(phrase)) return canonical;
  }
  return null;
}

const isClinicalElement = (canonical: string | null): boolean =>
  canonical != null && (canonical.startsWith("procedure.") || canonical.startsWith("policy."));

export interface DataReadinessDeps {
  outcomes: Pick<OutcomeStore, "listLatestPopulationRuns" | "listOutcomesWithRun">;
}

export async function computeDataReadiness(deps: DataReadinessDeps, measure: MeasureRecord): Promise<DataReadinessResponse> {
  const specElements = measure.spec.requiredDataElements ?? [];
  const canonicalToMapping = new Map<string, DataElementMapping>();
  for (const dm of listDataMappings()) canonicalToMapping.set(dm.canonicalElement, dm);

  // Missingness from this measure's LATEST population run (rate + up to 3 sample subjects with
  // MISSING_DATA). excludeScale: data-readiness reports on the live roster; the generated scale tenant
  // is excluded in SQL (E13 PR-2).
  //
  // #664: this read every outcome row for the measure across every retained run, evidence included —
  // on the pilot ~17 nightlies × 20,000 rows on a request thread, and one of the two reads open when the
  // API stopped answering. The run is named from the runs table first (ADR-087's read), then only its
  // rows are fetched, so the cost is one run whatever the history. It is also the more correct answer:
  // readiness describes the data as it is now, not averaged over months of superseded runs.
  //
  // A subject the measure's own logic put OUTSIDE its population (ADR-079) is persisted as MISSING_DATA
  // but is not missing anything, so it is out of both the numerator and the denominator — counted in,
  // it reported most of the pilot's roster as missing data on every measure with an age or sex gate.
  const [winner] = await deps.outcomes.listLatestPopulationRuns([measure.measureId], { excludeScale: true });
  const rows = winner
    ? await deps.outcomes.listOutcomesWithRun({ measureId: measure.measureId, runIds: [winner.runId], excludeScale: true })
    : [];
  const outcomes = rows.filter((o) => o.outOfPopulation !== true);
  const total = outcomes.length;
  const missing = outcomes.filter((o) => o.status === "MISSING_DATA");
  const missingnessRate = total === 0 ? 0 : missing.length / total;
  const sampleMissing = [...new Set(missing.map((o) => o.subjectId))].sort().slice(0, 3);

  const requiredElements: RequiredElementReadiness[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  for (const label of specElements) {
    const canonical = resolveCanonical(label, measure.measureId);
    const mapping = canonical != null ? canonicalToMapping.get(canonical) ?? null : null;
    const mappingStatus = mapping ? mapping.mappingStatus : "UNMAPPED";
    const sourceId = mapping ? mapping.sourceId : null;
    const freshnessStatus = sourceId ? sourceFreshness(sourceId) : "UNKNOWN";
    const clinical = isClinicalElement(canonical);

    requiredElements.push({
      canonicalElement: canonical ?? label.toLowerCase().replace(/ /g, "."),
      label,
      sourceId,
      mappingStatus,
      freshnessStatus,
      missingnessRate: clinical ? missingnessRate : 0,
      sampleMissingEmployees: clinical ? sampleMissing : [],
    });

    if (mappingStatus === "UNMAPPED") blockers.push(`Required element '${label}' has no source mapping.`);
    else if (mappingStatus === "ERROR") blockers.push(`Required element '${label}' mapping is in ERROR state.`);
    else if (mappingStatus === "STALE" || freshnessStatus === "STALE" || freshnessStatus === "VERY_STALE") {
      warnings.push(`Source data for '${label}' may be stale.`);
    }
  }

  // No completed population run means the missing-data rate is UNKNOWN, not zero. Reported as 0% with
  // no warning it read as clean data and could return READY for a measure nobody has run (#664 review).
  if (!winner) {
    warnings.push("No completed population run for this measure yet, so its missing-data rate is unknown.");
  } else if (missingnessRate > 0.05) {
    warnings.push(`${Math.round(missingnessRate * 100)}% of evaluated employees have missing data outcomes for this measure.`);
  }

  const overallStatus = blockers.length > 0 ? "NOT_READY" : warnings.length > 0 ? "READY_WITH_WARNINGS" : "READY";
  return { overallStatus, requiredElements, blockers, warnings };
}
