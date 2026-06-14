/**
 * Case disposition logic (#107) — pure port of the routing in
 * com.workwell.caseflow.CaseFlowService: an outcome maps to a case disposition,
 * a priority, and a next-action hint.
 */
import { MEASURES } from "../engine/cql/measure-registry.ts";

export type CaseDisposition = "OPEN" | "EXCLUDED" | "RESOLVE";

/** EXCLUDED → an excluded case; DUE_SOON/OVERDUE/MISSING_DATA → an open case; else resolve. */
export function dispositionFor(outcomeStatus: string): CaseDisposition {
  if (outcomeStatus === "EXCLUDED") return "EXCLUDED";
  if (outcomeStatus === "OVERDUE" || outcomeStatus === "DUE_SOON" || outcomeStatus === "MISSING_DATA") return "OPEN";
  return "RESOLVE"; // COMPLIANT (and anything else) closes an existing case
}

export function priorityFor(outcomeStatus: string): "HIGH" | "MEDIUM" | "LOW" {
  switch (outcomeStatus) {
    case "OVERDUE":
      return "HIGH";
    case "MISSING_DATA":
    case "DUE_SOON":
      return "MEDIUM";
    default:
      return "LOW";
  }
}

export function nextActionFor(outcomeStatus: string, measureId: string): string {
  const name = MEASURES[measureId]?.name ?? "";
  const label =
    name === "TB Surveillance"
      ? "TB screening"
      : name === "HAZWOPER Surveillance"
        ? "HAZWOPER surveillance"
        : name === "Flu Vaccine"
          ? "flu vaccine"
          : "audiogram";
  switch (outcomeStatus) {
    case "OVERDUE":
      return `Escalate ${label} follow-up immediately.`;
    case "MISSING_DATA":
      return `Collect the missing ${label} documentation.`;
    case "DUE_SOON":
      return `Schedule the annual ${label} before the due date.`;
    case "EXCLUDED":
      return "Review the active waiver and rerun before it expires.";
    default:
      return "No action required.";
  }
}
