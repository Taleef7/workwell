/**
 * Non-circular evidence about whether outcome compaction (ADR-073) could have removed rows from a run.
 *
 * WHY THE LEDGER AND NOT THE RUN: `RunSummary.totalEvaluated` is a count of the SURVIVING rows
 * (`read-models.ts`, `retentionNoticeFor`'s own comment), so comparing it with the surviving rows is
 * always equal and detects nothing — the review's reproduction shows a 1-of-2 report becoming 0-of-1
 * while the "total" becomes 1. `RUN_COMPLETED`'s payload count is best-effort and counts work items
 * including out-of-population subjects, so equality there proves nothing either.
 *
 * What IS reliable: `compactOutcomes` awaits an `OUTCOMES_COMPACTION_STARTED` audit event BEFORE it
 * deletes, and if that write fails nothing is deleted. Each event carries the cutoff its pass applied,
 * so the FURTHEST cutoff any pass has ever applied bounds what any pass could have reached. That is the
 * maximum over the ledger, not the newest event: a cutoff is `now − window`, and widening the window
 * (400 → 730 days) moves the next cutoff BACKWARDS, so a run that started between the two cutoffs would
 * read as untouched off the newest event alone while an earlier pass had already been through it (GLM
 * review, 2026-09-08). A run that started before that maximum had every row eligible; a run that started
 * after it could not have been reached. This is conservative — a run whose rows all happened to survive
 * is still refused — and conservative is the contract: a report is refused rather than rendered from
 * rows that may be incomplete (ADR-077 d2).
 *
 * It holds as long as `compactOutcomes` is the only deletion path, which it is: the scheduler and the
 * `outcomes-compact` CLI both call it. A direct `compactOlderThan` is a store primitive, not a policy.
 */
import type { CaseEventStore } from "../stores/case-event-store.ts";

export const COMPACTION_INTENT_EVENT = "OUTCOMES_COMPACTION_STARTED";

/**
 * How many intent events are scanned for the maximum cutoff. One pass runs per nightly recompute, so
 * this is about fourteen years of nightly passes; an instance that outlives it needs a dedicated
 * MAX(cutoff) store query, which is a contract change on both stores and is not worth it before then.
 */
export const COMPACTION_PASSES_SCANNED = 5000;

export interface CompactionExposure {
  /** True when some compaction pass's cutoff postdates the run's start, or the ledger cannot be read. */
  exposed: boolean;
  /** The furthest cutoff any pass has applied, or null when none has run (or no payload was readable). */
  cutoff: string | null;
}

export async function compactionExposure(
  run: { startedAt: string },
  events: Pick<CaseEventStore, "recentAuditEventsByType">,
): Promise<CompactionExposure> {
  const passes = await events.recentAuditEventsByType(COMPACTION_INTENT_EVENT, COMPACTION_PASSES_SCANNED);
  if (passes.length === 0) return { exposed: false, cutoff: null };
  let furthest: { iso: string; ms: number } | null = null;
  let unreadable = false;
  for (const pass of passes) {
    const cutoff = typeof pass.payload?.cutoff === "string" ? pass.payload.cutoff : null;
    const ms = cutoff === null ? Number.NaN : Date.parse(cutoff);
    if (!Number.isFinite(ms)) {
      unreadable = true;
      continue;
    }
    if (!furthest || ms > furthest.ms) furthest = { iso: cutoff!, ms };
  }
  const startedMs = Date.parse(run.startedAt);
  // A pass whose cutoff cannot be read, or a run whose start cannot be parsed, is exposure: absence of
  // proof is never proof of completeness.
  if (unreadable || !Number.isFinite(startedMs)) return { exposed: true, cutoff: furthest?.iso ?? null };
  return { exposed: startedMs < furthest!.ms, cutoff: furthest!.iso };
}
