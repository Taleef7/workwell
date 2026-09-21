/**
 * Test support: derive a fake's `listOutcomeMembershipsForRun` from its own `listOutcomes`.
 *
 * `aggregateOfficialRun` reads MEMBERSHIPS rather than whole evidence rows (review of #610 — the
 * unpaged full read had lost the memory bound, so the bound is a projection instead of a page window).
 * Every fake outcome store therefore needs the method, and the one thing it must not do is hand back
 * more than the real stores would: a fake returning whole records would be gentler than the shipped
 * query, and the failure it would hide is a reader reaching for a field the projection does not carry.
 *
 * So the narrowing here is the SAME narrowing both stores apply — `official` kept whole,
 * `evaluationError` present only when the stored evidence had it, everything else (notably
 * `expressionResults`) dropped — expressed once, over whatever rows the fake already serves.
 *
 * **`evaluationError` must be ABSENT and not null** on a row that did not error:
 * `isEvaluationErrorEvidence` tests key PRESENCE, so a key carrying null reads as a failed evaluation
 * and reports every rate as zero.
 */
import type { OutcomeRecord } from "../stores/outcome-store.ts";

type Rowish = { measureId?: string; status: string; evidence: unknown };
type MembershipRow = Pick<OutcomeRecord, "status" | "evidence">;

/** The projection itself, for a fake that already holds its rows in hand. */
export function narrowToMemberships(row: Rowish): MembershipRow {
  const full = row.evidence as Record<string, unknown> | null | undefined;
  const evidence: Record<string, unknown> = {};
  if (full?.official !== undefined && full.official !== null) evidence.official = full.official;
  if (full && "evaluationError" in full) evidence.evaluationError = full.evaluationError;
  return { status: row.status, evidence };
}

/**
 * Wrap a fake's `listOutcomes` as `listOutcomeMembershipsForRun`. The `measureId` filter is applied
 * BOTH as an option and as a post-filter, because the real stores push it into SQL and a fake that
 * ignored the option would otherwise sum every measure of the run into one answer — which is the
 * defect `officialMeasureRate`'s own measure-scoping test exists for.
 */
export function membershipsVia(
  listOutcomes: (runId: string, opts?: { measureId?: string }) => Promise<ReadonlyArray<Rowish>>,
): (runId: string, measureId: string) => Promise<MembershipRow[]> {
  return async (runId, measureId) =>
    (await listOutcomes(runId, { measureId }))
      .filter((row) => row.measureId === undefined || row.measureId === measureId)
      .map(narrowToMemberships);
}

/**
 * A fake outcome store plus the membership read, derived from its own `listOutcomes`.
 *
 * One wrap per fake, so the two reads can never disagree about the fixture — which is the property
 * that matters: a hand-written second reader is the thing that drifts the first time either is touched.
 */
export function withMemberships<
  T extends { listOutcomes: (runId: string, opts?: { measureId?: string }) => Promise<ReadonlyArray<Rowish>> },
>(fake: T): T & { listOutcomeMembershipsForRun: (runId: string, measureId: string) => Promise<MembershipRow[]> } {
  return { ...fake, listOutcomeMembershipsForRun: membershipsVia(fake.listOutcomes) };
}
