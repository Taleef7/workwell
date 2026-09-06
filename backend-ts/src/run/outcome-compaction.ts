/**
 * Outcome retention (ADR-073, spec §7).
 *
 * At 20,000 patients across five measures a nightly run writes 100,000 outcome rows, every night. In a
 * year that is 36 million rows on a serverless Postgres whose storage is the pilot's actual bill, to
 * answer questions almost all of which are about the CURRENT state of a panel.
 *
 * So per-subject outcome history becomes a window, and the durable long-run history is the
 * quality-over-time snapshot — an aggregate the compaction never touches (#E16). What is deleted, and
 * what is not, is the whole substance of the decision:
 *
 * - **KEPT: the newest row per (subject, measure), at any age.** A subject's current answer is never
 *   deleted, so no roster cell can go blank because that measure was last run before the window.
 * - **KEPT: every row an open case's `lastRunId` points at.** A case must be able to show the evidence
 *   it was opened on, however long it has been open.
 * - **KEPT: every run row and its counts.** A compacted run still reports what it found.
 * - **DELETED: everything else older than the cutoff** — the intermediate history of subjects whose
 *   answer has since been superseded.
 *
 * **INERT unless configured.** No `WORKWELL_OUTCOME_RETENTION_DAYS` means no compaction, ever, on any
 * deployment that has not opted in. TWH sets nothing and keeps its history whole.
 */
import type { Stores } from "../stores/factory.ts";

export interface CompactionResult {
  /** ISO-8601 instant before which non-exempt rows were deleted. */
  cutoff: string;
  deleted: number;
  /** Run ids pinned by open cases — the count, not the ids, so the audit payload stays bounded. */
  kept: number;
  durationMs: number;
}

export interface CompactionOptions {
  /** Absent / non-positive ⇒ a hard no-op. */
  retentionDays?: number | undefined;
  now: number;
}

/** Parses the window from the environment; anything that is not a positive integer disables it. */
export function retentionDaysFromEnv(env: Record<string, unknown>): number | undefined {
  const raw = env.WORKWELL_OUTCOME_RETENTION_DAYS;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[workwell] WORKWELL_OUTCOME_RETENTION_DAYS="${String(raw)}" is not a positive integer; retention stays OFF.`,
    );
    return undefined;
  }
  return parsed;
}

const DAY_MS = 86_400_000;

/**
 * Delete outcome rows outside the retention window, once. Returns `null` when retention is not
 * configured — the caller then knows nothing happened, rather than reading a zero as "nothing to do".
 *
 * ORDERING IS CONTRACT: this must run AFTER the quality snapshot for the run that just finished.
 * Compacting first would delete the per-subject rows the snapshot is computed from, and the aggregate
 * that is supposed to be the durable history would be built from a roster with holes in it. The
 * scheduler enforces the order; `outcome-compaction.test.ts` pins it.
 */
export async function compactOutcomes(
  stores: Pick<Stores, "outcomes" | "cases" | "events">,
  options: CompactionOptions,
): Promise<CompactionResult | null> {
  const retentionDays = options.retentionDays;
  if (retentionDays === undefined || !Number.isInteger(retentionDays) || retentionDays <= 0) return null;

  const started = Date.now();
  const cutoff = new Date(options.now - retentionDays * DAY_MS).toISOString();

  /**
   * The runs open cases cite. Read BEFORE the delete, and treated as required rather than
   * best-effort: if this read fails the compaction does not run at all. A pin list that silently came
   * back empty would delete exactly the evidence the pins exist to protect, and the failure would look
   * like a successful compaction that removed a few more rows than usual.
   */
  const openCases = await stores.cases.listCases({ statuses: ["OPEN", "IN_PROGRESS"], limit: 100000 });
  const pinnedRunIds = [...new Set(openCases.map((c) => c.lastRunId).filter((id): id is string => Boolean(id)))];

  const deleted = await stores.outcomes.compactOlderThan(cutoff, pinnedRunIds);
  const result: CompactionResult = { cutoff, deleted, kept: pinnedRunIds.length, durationMs: Date.now() - started };

  // A deletion is a state change, so it is audited — no exceptions (CLAUDE.md). One event per pass,
  // not per row: the payload answers "what was removed and what was protected", which is the question
  // an auditor asks, and 100,000 events answering it individually would answer nothing.
  await stores.events.appendAudit({
    eventType: "OUTCOMES_COMPACTED",
    entityType: "outcome",
    entityId: null,
    actor: "system",
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: null,
    payload: { ...result, retentionDays },
  });

  return result;
}
