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
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { MeasureReportEntry, ReportRow, SubjectListReport } from "./subject-list-report.ts";

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
];

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
    csvCell(measure?.ecqmId ?? ""),
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
  ];
  // evaluatedAt, rate, the five populations, status, outOfPopulation, evaluationError.
  const EVALUATION_COLUMNS = 10;

  if (row.rowStatus === "NOT_MATCHED") {
    // Every patient and measure column empty — the row exists to say this identifier resolved to
    // nobody, and filling a measure in would imply it was measured against one.
    return [[
      ...lead,
      ...measureCells.map(() => ""),
      ...Array.from({ length: EVALUATION_COLUMNS }, () => ""),
      ...tail,
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
    ]];
  }
  return row.rates.map((rate) => [
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
  ]);
}
