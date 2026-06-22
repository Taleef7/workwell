/** Shared run-status terminal set — single source of truth for "a run has finished", imported by
 *  the global RunStatusProvider and the /runs page so a new terminal status can't be added to one
 *  and missed by the other. */
export const TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "FAILED", "PARTIAL_FAILURE", "CANCELLED"]);

export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return TERMINAL_RUN_STATUSES.has((status ?? "").toUpperCase());
}
