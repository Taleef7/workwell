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
const LABEL_TO_CANONICAL: ReadonlyArray<[string, string]> = [
  ["last audiogram date", "procedure.audiogram"],
  ["last tb screening date", "procedure.tbScreen"],
  ["last surveillance exam date", "procedure.hazwoperExam"],
  ["last flu vaccine date", "procedure.fluVaccine"],
  ["contraindication status", "waiver.flu"],
  ["exemption status", "waiver.medical"],
  ["program enrollment", "programEnrollment.hearingConservation"],
  ["current season", "policy.fluSeason"],
  ["audiogram", "procedure.audiogram"],
  ["tb screening", "procedure.tbScreen"],
  ["surveillance exam", "procedure.hazwoperExam"],
  ["flu vaccine", "procedure.fluVaccine"],
  ["contraindication", "waiver.flu"],
  ["exemption", "waiver.medical"],
  ["enrollment", "programEnrollment.hearingConservation"],
  ["season", "policy.fluSeason"],
  ["role", "employee.role"],
  ["site", "employee.site"],
];

function resolveCanonical(label: string): string | null {
  const lower = label.toLowerCase().trim();
  for (const [phrase, canonical] of LABEL_TO_CANONICAL) {
    if (lower.includes(phrase)) return canonical;
  }
  return null;
}

const isClinicalElement = (canonical: string | null): boolean =>
  canonical != null && (canonical.startsWith("procedure.") || canonical.startsWith("policy."));

export interface DataReadinessDeps {
  outcomes: OutcomeStore;
}

export async function computeDataReadiness(deps: DataReadinessDeps, measure: MeasureRecord): Promise<DataReadinessResponse> {
  const specElements = measure.spec.requiredDataElements ?? [];
  const canonicalToMapping = new Map<string, DataElementMapping>();
  for (const dm of listDataMappings()) canonicalToMapping.set(dm.canonicalElement, dm);

  // Missingness from this measure's outcomes (rate + up to 3 sample subjects with MISSING_DATA).
  const outcomes = await deps.outcomes.listOutcomesForMeasure(measure.measureId);
  const total = outcomes.length;
  const missing = outcomes.filter((o) => o.status === "MISSING_DATA");
  const missingnessRate = total === 0 ? 0 : missing.length / total;
  const sampleMissing = [...new Set(missing.map((o) => o.subjectId))].sort().slice(0, 3);

  const requiredElements: RequiredElementReadiness[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  for (const label of specElements) {
    const canonical = resolveCanonical(label);
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

  if (missingnessRate > 0.05) {
    warnings.push(`${Math.round(missingnessRate * 100)}% of evaluated employees have missing data outcomes for this measure.`);
  }

  const overallStatus = blockers.length > 0 ? "NOT_READY" : warnings.length > 0 ? "READY_WITH_WARNINGS" : "READY";
  return { overallStatus, requiredElements, blockers, warnings };
}
