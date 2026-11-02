/**
 * What the measure's own CQL found for one patient on one rate (#875, §6.6): the list report's four
 * `evidence*` columns, and since #880 the case page's "Why this was flagged". Pure, and outside the
 * report module, so the case read model can use it without joining that module's import graph.
 */
import { CQL_FACTS_SPEC_VERSION, factsSpecFor, isScoredRate } from "../wiring/official-facts.ts";
import type { MeasureReportEntry, ReportRow, ReportRowRate } from "./subject-list-report.ts";

/**
 * What a row's `evidenceStatus` says, per rate (§6.6). Read from the rate's population flags and the
 * outcome's recorded define values only; nothing here looks at FHIR data or chooses among values.
 */
export type EvidenceStatus =
  | "NOT_APPLICABLE"
  | "NOT_EXPOSED_BY_LOGIC"
  | "NOT_RECORDED_BY_RUN"
  | "NUMERATOR_EVIDENCE"
  | "LATEST_NOT_QUALIFYING"
  | "NONE_FOUND";

export interface EvidenceCells {
  status: EvidenceStatus;
  /** The `dateDefine`'s value as CQL rendered it; empty unless the status is one that found something. */
  date: string;
  /** `<define> (<executed logic>)` beside a date, so a WorkWell define never reads as CMS's (LOCKED §4.3). */
  dateSource: string;
  /** Every recorded value as `define: value`, joined by ` || `, on the three statuses that read them. */
  detail: string;
}

/**
 * One rate's evidence, by the first rule that applies (§6.6):
 * 1. not scored on this rate (`isScoredRate`), or out of population: `NOT_APPLICABLE`;
 * 2. the logic names no define for this rate (no `FactsSpec`, or the rate is not in `exposedRates`):
 *    `NOT_EXPOSED_BY_LOGIC`; a row whose logic was never recorded is rule 3's;
 * 3. the outcome recorded no facts, or under another spec version: `NOT_RECORDED_BY_RUN`;
 * 4. with a `noneFoundDefine` (CMS122, an inverse measure): its value `true` is `NONE_FOUND`, CQL's own
 *    answer and never inferred from an empty date; else the numerator met is `NUMERATOR_EVIDENCE` (the
 *    poor-control reading) and not met is `LATEST_NOT_QUALIFYING`;
 * 5. otherwise an evidence define with a value is something found: `NUMERATOR_EVIDENCE` when the
 *    numerator is met, `LATEST_NOT_QUALIFYING` when not; none found is `NONE_FOUND` when the numerator is
 *    not met, and `NOT_EXPOSED_BY_LOGIC` when it is (the logic met it through a define it does not name).
 */
export function evidenceOf(
  measureId: string,
  logic: Pick<MeasureReportEntry, "logic" | "executedLogic"> | undefined,
  rateIndex: number,
  rate: ReportRowRate,
  row: Pick<ReportRow, "outcome" | "cqlFacts">,
): EvidenceCells {
  const only = (status: EvidenceStatus): EvidenceCells => ({ status, date: "", dateSource: "", detail: "" });
  if (!isScoredRate(rate) || row.outcome?.outOfPopulation) return only("NOT_APPLICABLE");
  const kind = logic?.logic?.kind === "cms-artifact" ? "official" : logic?.logic?.kind === "workwell-translation" ? "derived" : null;
  // No recorded logic (a row from before #769) is no recorded facts either: nothing says which spec to read.
  if (!kind) return only("NOT_RECORDED_BY_RUN");
  const spec = factsSpecFor(measureId, kind);
  if (!spec || (spec.exposedRates && !spec.exposedRates.includes(rateIndex))) return only("NOT_EXPOSED_BY_LOGIC");
  const facts = row.cqlFacts;
  if (!facts || facts.spec !== CQL_FACTS_SPEC_VERSION) return only("NOT_RECORDED_BY_RUN");

  const valueOf = new Map(facts.values.map(({ define, value }) => [define, value]));
  let status: EvidenceStatus;
  if (spec.noneFoundDefine) {
    status = valueOf.get(spec.noneFoundDefine) === "true" ? "NONE_FOUND" : rate.numer ? "NUMERATOR_EVIDENCE" : "LATEST_NOT_QUALIFYING";
  } else {
    const found = spec.evidence.some((define) => valueOf.has(define));
    status = found ? (rate.numer ? "NUMERATOR_EVIDENCE" : "LATEST_NOT_QUALIFYING") : rate.numer ? "NOT_EXPOSED_BY_LOGIC" : "NONE_FOUND";
  }
  if (status === "NOT_EXPOSED_BY_LOGIC") return only(status);
  const found = status === "NUMERATOR_EVIDENCE" || status === "LATEST_NOT_QUALIFYING";
  const date = found && spec.dateDefine ? (valueOf.get(spec.dateDefine) ?? "") : "";
  return {
    status,
    date,
    dateSource: date ? (logic?.executedLogic ? `${spec.dateDefine} (${logic.executedLogic})` : (spec.dateDefine ?? "")) : "",
    detail: facts.values.map(({ define, value }) => `${define}: ${value}`).join(" || "),
  };
}
