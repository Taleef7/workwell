/**
 * The attributed-list report's patient-level CSV (MM-2 PR 3, ADR-082; contract in
 * `DATA_MODEL_CONTRACTS` §6.6).
 *
 * The CSV *is* the patient-level artifact — the ACO asked for the result AND its date per patient,
 * and a paged JSON of 50,000 members would be a second thing to build and keep in step. The JSON
 * summary carries the counts; every count in it can be recomputed from these rows, and a test does.
 *
 * **Three row shapes, and the two non-evaluated ones are deliberate:**
 * - `EVALUATED` — one row per (measure, rate). A two-rate measure yields two rows for one patient.
 * - `MISSING_FROM_RUN` — one row per MEASURE, not per rate: the patient, provider and payer columns
 *   are filled and every population, status and rate column is EMPTY. Never `0` or `false`, which a
 *   consumer would read as a scored result of zero rather than as an absence.
 * - `NOT_MATCHED` — exactly ONE row for the member, after all evaluated rows, with every patient and
 *   measure column empty. One row per measure would multiply one unresolved identifier by six and
 *   read as six separate failures.
 *
 * Every row carries the provenance (list id, revision, run id, measurement period), because these
 * files are filed and asked about months later, and a row without its run id cannot be traced back to
 * the evidence it came from.
 */
import { csvCell, csvTextCell } from "../export/csv.ts";
import { subjectHeaders } from "../export/export-csv.ts";
import { DEPLOYMENT_PROFILE } from "../config/deployment-profile.ts";
import { ecqmIdOf } from "../measure/measure-identity.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { CQL_FACTS_SPEC_VERSION, factsSpecFor, isScoredRate } from "../wiring/official-facts.ts";
import type { MeasureReportEntry, ReportRow, ReportRowRate, SubjectListReport } from "./subject-list-report.ts";

export const reportCsvHeaders = (term: "employee" | "patient" = DEPLOYMENT_PROFILE.subjectTerm): string[] => [
  "listId",
  "listRevision",
  "generatedAt",
  "rawIdentifier",
  ...subjectHeaders(term),
  "resolution",
  "rowStatus",
  "measureId",
  "ecqmId",
  "measureVersion",
  "runId",
  "measurementPeriodStart",
  "measurementPeriodEnd",
  "evaluatedAt",
  "rate",
  "initialPopulation",
  "denominator",
  "denominatorExclusion",
  "denominatorException",
  "numerator",
  "status",
  "outOfPopulation",
  "evaluationError",
  "providerId",
  "payer",
  // APPENDED, never inserted (§6.6): which logic produced the row's numbers.
  "executedLogic",
  // APPENDED (#875): what the measure's own CQL found for the patient on this rate (`evidenceOf`).
  "evidenceStatus",
  "evidenceDate",
  "evidenceDateSource",
  "evidenceDetail",
];

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

export function subjectListReportCsv(
  report: SubjectListReport,
  employeeById: (externalId: string) => EmployeeProfile | null,
  term: "employee" | "patient" = DEPLOYMENT_PROFILE.subjectTerm,
): string {
  const byMeasure = new Map(report.measures.map((m) => [m.measureId, m]));
  const lines = [reportCsvHeaders(term).map(csvCell).join(",")];
  for (const row of report.rows) {
    for (const cells of rowCells(report, row, byMeasure.get(row.measureId ?? ""), employeeById)) {
      lines.push(cells.join(","));
    }
  }
  return lines.join("\r\n");
}

function rowCells(
  report: SubjectListReport,
  row: ReportRow,
  measure: MeasureReportEntry | undefined,
  employeeById: (externalId: string) => EmployeeProfile | null,
): string[][] {
  const profile = row.subjectId ? employeeById(row.subjectId) : null;
  // The identifier, the name, the source and the note are text a PERSON supplied or a directory
  // holds; everything else is ours and cannot lead with a formula character.
  const lead = [
    csvCell(report.list.id),
    csvCell(report.list.revision),
    csvCell(report.generatedAt),
    csvTextCell(row.rawIdentifier),
    csvTextCell(row.rowStatus === "NOT_MATCHED" ? "" : (row.subjectId ?? "")),
    csvTextCell(row.rowStatus === "NOT_MATCHED" ? "" : (profile?.name ?? "")),
    csvCell(row.resolution),
    csvCell(row.rowStatus),
  ];
  const measureCells = [
    csvCell(row.measureId ?? ""),
    // One spelling on every served eCQM id ("CMS125FHIR"), whoever built the entry.
    csvCell(measure?.ecqmId ? ecqmIdOf(measure.ecqmId) : ""),
    csvCell(measure?.version ?? ""),
    csvCell(measure?.runId ?? ""),
    csvCell(measure?.measurementPeriod?.start ?? ""),
    csvCell(measure?.measurementPeriod?.end ?? ""),
  ];
  // Neutralised too: on a live directory these are somebody else's strings, not ours. A payer
  // typology code cannot lead with a formula character, but a provider id from an external system can.
  const tail = [
    csvTextCell(row.rowStatus === "NOT_MATCHED" ? "" : (profile?.providerId ?? "")),
    csvTextCell(row.rowStatus === "NOT_MATCHED" ? "" : (profile?.payer ?? "")),
    // Measure-level provenance like `ecqmId`: filled wherever the measure columns are.
    csvTextCell(row.rowStatus === "NOT_MATCHED" ? "" : (measure?.executedLogic ?? "")),
  ];
  // evaluatedAt, rate, the five populations, status, outOfPopulation, evaluationError.
  const EVALUATION_COLUMNS = 10;
  // evidenceStatus, evidenceDate, evidenceDateSource, evidenceDetail: per rate, so empty on a row with none.
  const NO_EVIDENCE = ["", "", "", ""];

  if (row.rowStatus === "NOT_MATCHED") {
    // Every patient and measure column empty — the row exists to say this identifier resolved to
    // nobody, and filling a measure in would imply it was measured against one.
    return [[
      ...lead,
      ...measureCells.map(() => ""),
      ...Array.from({ length: EVALUATION_COLUMNS }, () => ""),
      ...tail,
      ...NO_EVIDENCE,
    ]];
  }
  if (row.rowStatus === "MISSING_FROM_RUN" || row.rates.length === 0) {
    return [[
      ...lead,
      ...measureCells,
      csvCell(row.outcome?.evaluatedAt ?? ""),
      "", // rate
      "", "", "", "", "", // ipp / denom / denex / denexcep / numer — EMPTY, never 0
      csvCell(row.outcome?.status ?? ""),
      csvCell(row.outcome ? String(row.outcome.outOfPopulation ?? false) : ""),
      csvCell(row.evaluationError ? "true" : row.outcome ? "false" : ""),
      ...tail,
      ...NO_EVIDENCE,
    ]];
  }
  return row.rates.map((rate, index) => [
    ...lead,
    ...measureCells,
    csvCell(row.outcome?.evaluatedAt ?? ""),
    csvTextCell(rate.label ?? ""),
    csvCell(rate.ipp),
    csvCell(rate.denom),
    csvCell(rate.denex),
    csvCell(rate.denexcep),
    csvCell(rate.numer),
    csvCell(row.outcome?.status ?? ""),
    csvCell(String(row.outcome?.outOfPopulation ?? false)),
    csvCell(row.evaluationError ? "true" : "false"),
    ...tail,
    ...evidenceCells(evidenceOf(row.measureId ?? "", measure, index, rate, row)),
  ]);
}

// The status and the date are ours; the source names a define and a logic label, and the detail is
// CQL's rendering of chart data (a coding's display, a note), so both are neutralised.
const evidenceCells = (e: EvidenceCells): string[] => [csvCell(e.status), csvCell(e.date), csvTextCell(e.dateSource), csvTextCell(e.detail)];
