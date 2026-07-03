/**
 * Roster status vocabulary (E10.5). Maps a measure outcome's canonical bucket + evidence +
 * complianceClass to a UI display state + a plain-English method string. The persisted status is
 * unchanged (the 5 canonical buckets, ADR-008); DECLINED / IN_PROGRESS are read-time refinements
 * (NA is decided by the read model when a subject has no outcome for a measure).
 */
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { deriveWhyFlagged, expressionResults } from "../case/case-detail-read-model.ts";

export type DisplayState =
  | "COMPLIANT" | "DUE_SOON" | "OVERDUE" | "MISSING_DATA" | "EXCLUDED" | "DECLINED" | "IN_PROGRESS" | "NA" | "NOT_APPLICABLE";

export interface Cell {
  status: DisplayState;
  method: string;
}

/** Derive the display state + method for one (canonical status, evidence) of a measure. */
export function deriveCell(canonicalStatus: string, evidence: unknown, measureId: string, evaluationPeriod: string): Cell {
  const ers = expressionResults(evidence);
  const get = (re: RegExp): unknown => ers.find((r) => re.test(r.define))?.result;
  const binding = MEASURE_BINDINGS[measureId];
  const refused = get(/refus/i) === true;

  if (canonicalStatus === "EXCLUDED") return { status: "EXCLUDED", method: "Contraindication / exemption on file" };
  // Deliberately class-agnostic: a documented refusal displays DECLINED for PERMANENT (the vaccine
  // panel) AND for RECURRING `adult_immunization` (which keeps the case open, never excludes — see
  // MEASURES.md). The canonical bucket is unchanged; only the display is.
  //
  // But DECLINED must NOT mask a canonically COMPLIANT outcome (Fable M12): `Refused` is independent of
  // `Outcome Status`, so a subject vaccinated AFTER an earlier documented refusal (the CM success story)
  // is genuinely COMPLIANT — showing DECLINED would misrepresent the authoritative bucket and drop them
  // from a `?status=COMPLIANT` filter. So apply DECLINED only when the canonical bucket is non-compliant.
  if (refused && canonicalStatus !== "COMPLIANT") return { status: "DECLINED", method: "Declination on file" };

  if (binding?.complianceClass === "PERMANENT") {
    const dc = get(/^dose count$/i);
    const doseCount = typeof dc === "number" ? dc : 0;
    const required = binding.series?.requiredDoses ?? 2;
    if (canonicalStatus === "COMPLIANT") {
      // Titer-proves-immunity (E11.2a): when compliance is reached via a positive titer rather than a
      // complete dose series, show the immunity path instead of a contradictory "0 valid dose(s)".
      if (doseCount < required && get(/^has positive titer$/i) === true) {
        return { status: "COMPLIANT", method: "Immune (positive titer)" };
      }
      return { status: "COMPLIANT", method: `${doseCount} valid dose(s)` };
    }
    if (doseCount > 0 && doseCount < required) return { status: "IN_PROGRESS", method: `${doseCount} of ${required} doses on file` };
    // doseCount === 0 (no doses) — or, defensively, a count that isn't a passing series — report it honestly.
    return { status: "MISSING_DATA", method: doseCount > 0 ? `${doseCount} dose(s) on file` : "No doses on file" };
  }

  // RECURRING (recency): reuse the case-detail why_flagged derivation for last-exam/days.
  const wf = deriveWhyFlagged(evidence, measureId, evaluationPeriod, canonicalStatus);
  const last = wf.last_exam_date;
  switch (canonicalStatus) {
    case "COMPLIANT":
      return { status: "COMPLIANT", method: last ? `Last completed ${last}` : "Compliant" };
    case "DUE_SOON":
      return { status: "DUE_SOON", method: last ? `Due soon — last ${last}` : "Due soon" };
    case "OVERDUE":
      return {
        status: "OVERDUE",
        method: last ? `Overdue — last ${last} (${wf.days_overdue ?? 0}d over)` : "Overdue — no record on file",
      };
    default:
      return { status: "MISSING_DATA", method: "No record on file" };
  }
}
