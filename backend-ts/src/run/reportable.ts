/**
 * Which runs may be exported as a quality report — MeasureReport, QRDA I, QRDA III.
 *
 * A run in a REPORTABLE status has FINISHED and its outcomes are final. `PARTIAL_FAILURE` is
 * reportable (ADR-074 d12): those runs finished, and their failed subjects persist `MISSING_DATA` with
 * an `evaluationError`, which is a real outcome rather than an absent one; the exporters count those
 * errors separately (`x-workwell-evaluation-errors`). `FAILED` and `CANCELLED` are TERMINAL but not
 * reportable: the run stopped, and what it persisted is a partial roster that would read as complete.
 *
 * `frontend/lib/run-status.ts` mirrors this set for the export buttons; the backend is the authority
 * and answers 409 `run_not_reportable` regardless of what a client shows (ADR-077 d1).
 */
export const REPORTABLE_RUN_STATUSES: ReadonlySet<string> = new Set(["COMPLETED", "PARTIAL_FAILURE"]);

export function isReportableRunStatus(status: string | null | undefined): boolean {
  return REPORTABLE_RUN_STATUSES.has((status ?? "").toUpperCase());
}
