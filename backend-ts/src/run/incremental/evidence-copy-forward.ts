/**
 * Copy-forward evidence recomputation for incremental evaluation (#263, Phase 2a; design §3 option 1).
 *
 * When a run REUSES a prior outcome instead of re-evaluating (data + logic unchanged, status not near a
 * boundary), it must still write an outcome row for that subject (§4 — every read model reads "the
 * outcomes of the latest run"). Copying the prior evidence VERBATIM would be wrong for a later date: the
 * CQL `"Days Since …"` defines are anchored to the run's evaluation date, so a row copied 30 days later
 * would carry day-N arithmetic under a day-N+30 timestamp — and `deriveWhyFlagged` derives
 * `days_overdue` from exactly that stored `"Days Since"` value (`case-detail-read-model.ts`). An auditor
 * would find "412 days since last audiogram" when the truth is 442.
 *
 * The fix is measure-agnostic and exact: a `"Days Since …"` value increases by precisely +1 per calendar
 * day whatever its anchor (a real exam date, or the CQL's `@1900-01-01` no-exam fallback), so we ADVANCE
 * each numeric `"Days Since"` define by the whole days elapsed between the source run's evaluation date
 * and this run's. Absolute defines (`"Most Recent … Date"`) and every non-date-dependent value copy
 * verbatim. A SAME-DAY reuse (the data-hash tier within one run's date) has zero elapsed days, so the
 * copy is byte-identical to a fresh evaluation — the parity guarantee (§8) holds by construction.
 *
 * Descriptive only (ADR-008): this reproduces what the CQL engine would have computed for the new date,
 * it never changes a status.
 */

const DAY_MS = 86_400_000;

/** Whole calendar days from `fromDate` to `toDate` (both `YYYY-MM-DD`), UTC-anchored, may be negative. */
export function daysElapsed(fromDate: string, toDate: string): number {
  const from = Date.parse(`${fromDate.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${toDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / DAY_MS);
}

interface ExpressionResult {
  define: string;
  result: unknown;
}

const isDaysSince = (define: string): boolean => /^days since/i.test(define);

/**
 * Return a copy of `evidence` with every numeric `"Days Since …"` define advanced by the days elapsed
 * from `sourceEvalDate` to `newEvalDate`. Non-`expressionResults` keys and every other define are
 * preserved untouched. Returns the input unchanged (structurally) when there is nothing to advance.
 */
export function recomputeEvidenceAsOf(evidence: unknown, sourceEvalDate: string, newEvalDate: string): unknown {
  const delta = daysElapsed(sourceEvalDate, newEvalDate);
  if (delta === 0) return evidence; // same-day reuse — byte-identical, no work
  if (evidence === null || typeof evidence !== "object") return evidence;
  const ev = evidence as Record<string, unknown>;
  const ers = ev.expressionResults;
  if (!Array.isArray(ers)) return evidence;
  const advanced = (ers as ExpressionResult[]).map((er) =>
    er && typeof er === "object" && isDaysSince(er.define) && typeof er.result === "number"
      ? { ...er, result: er.result + delta }
      : er,
  );
  return { ...ev, expressionResults: advanced };
}
