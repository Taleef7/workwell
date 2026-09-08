/** Shared run-status terminal set — single source of truth for "a run has finished", imported by
 *  the global RunStatusProvider and the /runs page so a new terminal status can't be added to one
 *  and missed by the other. */
export const TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "FAILED", "PARTIAL_FAILURE", "CANCELLED"]);

export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return TERMINAL_RUN_STATUSES.has((status ?? "").toUpperCase());
}

/** Runs whose outcomes are FINAL and may be exported as a quality report. Mirrors the backend's
 *  `src/run/reportable.ts`, which is the authority (it answers 409 `run_not_reportable`). FAILED and
 *  CANCELLED are terminal but NOT reportable: what they persisted is a fragment (ADR-077 d1). */
export const REPORTABLE_RUN_STATUSES = new Set(["COMPLETED", "PARTIAL_FAILURE"]);

export function isReportableRunStatus(status: string | null | undefined): boolean {
  return REPORTABLE_RUN_STATUSES.has((status ?? "").toUpperCase());
}
