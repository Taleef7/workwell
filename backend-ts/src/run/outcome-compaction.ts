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
 * - **KEPT: the newest row per (subject, measure, EVALUATION PERIOD), at any age.** Per period, not
 *   merely per measure: a calendar-year eCQM's whole 2027 evidence is superseded by the first 2028 run,
 *   so a per-measure rule would delete a closed year months before anyone could be asked to justify its
 *   rate. This also keeps a subject's current answer, so no roster cell goes blank because a measure
 *   was last run before the window.
 * - **KEPT: every row a CASE cites**, matched on (run, subject, measure) — open or closed. A closed
 *   case's detail page still resolves its evidence through `last_run_id`, and a resolved case is
 *   exactly the record re-read when a number is challenged.
 * - **KEPT: every run row and its counts.** A compacted run still reports what it found.
 * - **DELETED: everything else older than the cutoff** — the intermediate history of subjects whose
 *   answer has since been superseded.
 *
 * **INERT unless configured.** No `WORKWELL_OUTCOME_RETENTION_DAYS` means no compaction, ever, on any
 * deployment that has not opted in. TWH sets nothing and keeps its history whole.
 */
import type { Stores } from "../stores/factory.ts";
import { resetMeasureRateMemo } from "../program/measure-rate.ts";

export interface CompactionResult {
  /** ISO-8601 instant before which non-exempt rows were deleted. */
  cutoff: string;
  deleted: number;
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
  stores: Pick<Stores, "outcomes" | "events">,
  options: CompactionOptions,
): Promise<CompactionResult | null> {
  const retentionDays = options.retentionDays;
  if (retentionDays === undefined || !Number.isInteger(retentionDays) || retentionDays <= 0) return null;

  const started = Date.now();
  const cutoff = new Date(options.now - retentionDays * DAY_MS).toISOString();

  /**
   * No pin list is read here, and that is deliberate — the store expresses the exclusion in SQL, per
   * row, over every case regardless of status.
   *
   * HISTORICAL NOTE, because the reason is not obvious from what remains: this used to read
   * OPEN/IN_PROGRESS cases with `limit: 100000` and pass their `lastRunId`s down. A limit truncates
   * silently, and `listCases` orders by `updated_at DESC`, so the rows dropped would be the least
   * recently updated — the long-open cases whose run is old enough to be deleted on the next line. The
   * read succeeds either way, so nothing reports it. Whether the pilot would actually exceed 100,000
   * open cases is a projection (20,000 patients x six measures bounds it at 120,000, but how many are
   * open at once depends on compliance rates nobody has measured yet); the defect is that the failure
   * is unbounded and silent, not that a particular number is reached. Pinning by RUN was separately
   * too coarse: one long-open case protected all 100,000 rows of its run.
   */
  // A deletion is a state change, so it is audited — no exceptions (CLAUDE.md). The ledger entry is
  // written BEFORE the delete, not after it. The two stores share no transaction, so "delete, then
  // audit" left a window in which the rows were irreversibly gone and the only record of it was a
  // rejected promise the scheduler logs and moves past (Codex review, #528). Written first, the intent
  // record names the window that is about to be applied; if this write fails, nothing is deleted, and
  // if the delete then fails the ledger says a pass was attempted and against what cutoff. The count is
  // reconstructible from the cutoff — the keep-set is a deterministic function of the table — so the
  // completion record below is the convenience, and this one is the guarantee.
  const base = {
    entityType: "outcome" as const,
    entityId: null,
    actor: "system",
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: null,
  };
  await stores.events.appendAudit({ ...base, eventType: "OUTCOMES_COMPACTION_STARTED", payload: { cutoff, retentionDays } });

  const deleted = await stores.outcomes.compactOlderThan(cutoff);
  const result: CompactionResult = { cutoff, deleted, durationMs: Date.now() - started };
  // A terminal run is immutable EXCEPT for this pass, so the per-run measure-rate memo is dropped here:
  // otherwise a warm process would serve a pre-compaction rate on the dashboard while the export of the
  // same run is refused, and a cold one the post-compaction rate (own review, ADR-077 d5).
  resetMeasureRateMemo();

  // One completion event per pass, not per row: the payload answers "what window was applied and how
  // much went", which is the question an auditor asks, and 100,000 events answering it individually
  // would answer nothing.
  await stores.events.appendAudit({ ...base, eventType: "OUTCOMES_COMPACTED", payload: { ...result, retentionDays } });

  return result;
}
