/**
 * The one outcome row a case is about — the evidence its detail page, its outreach copy, its AI
 * explanation and its MCP projection all read.
 *
 * This exists because the same two lines were written out eight times:
 *
 *     const outcomes = await outcomes.listOutcomes(c.lastRunId);
 *     const outcome = outcomes.find((o) => o.subjectId === c.employeeId && o.measureId === c.measureId);
 *
 * — every outcome row of the whole run, `evidence_json` blobs included, fetched to use exactly one of
 * them. Against the pilot's six-measure nightly (120,000 pairs) opening a case measured 43s on a cold
 * read and ~4s warm with NO run in flight, and the cost grew with the roster rather than with anything
 * the surface showed. Some paths paid it twice per interaction: a case detail page also loads its
 * appointments, and an outreach send renders its context and then rebuilds the detail.
 *
 * Without a period, `limit: 1` is exactly equivalent to the `.find()` it replaces — the store orders by
 * `evaluated_at ASC, id ASC`, so the first row under the same filter is the row `.find()` returned.
 *
 * **With the case's period, the row OF THAT PERIOD wins** (#769). A run created by `/evaluate` or an
 * import resolves the date per call, so one run can hold a subject's 2026 row and 2027 row for the same
 * measure — and the 2027 case citing that run is about the 2027 row, whichever was written first. The
 * subject's rows for one (run, measure) are a handful, so they are read whole and the first row whose
 * `evaluationPeriod` matches is taken; when none matches (a row written before the period was recorded
 * carries ""), the first row stands, as before.
 *
 * Takes the fields rather than a whole `CaseRecord` so a caller holding only the ids can use it, and so
 * the signature says precisely what the lookup is keyed on.
 */
import type { OutcomeRecord, OutcomeStore } from "../stores/outcome-store.ts";

/**
 * The row a case cites among one subject's rows of one (run, measure), in the store's `evaluated_at ASC,
 * id ASC` order: the first whose `evaluationPeriod` is the case's, else the first. Shared by
 * `outcomeForCase` and the case-list reads (`scoringForCases`, the patient page), so a list and the case
 * page always name the same row.
 */
export function citedRow<T extends { evaluationPeriod?: string | null }>(rows: readonly T[], evaluationPeriod?: string | null): T | null {
  if (evaluationPeriod) {
    const match = rows.find((r) => r.evaluationPeriod === evaluationPeriod);
    if (match) return match;
  }
  return rows[0] ?? null;
}

export async function outcomeForCase(
  outcomes: Pick<OutcomeStore, "listOutcomes">,
  lastRunId: string,
  subjectId: string,
  measureId: string,
  evaluationPeriod?: string | null,
): Promise<OutcomeRecord | null> {
  if (!evaluationPeriod) {
    const rows = await outcomes.listOutcomes(lastRunId, { subjectId, measureId, limit: 1 });
    return rows[0] ?? null;
  }
  return citedRow(await outcomes.listOutcomes(lastRunId, { subjectId, measureId }), evaluationPeriod);
}
