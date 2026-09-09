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
 * `limit: 1` is exactly equivalent to the `.find()` it replaces — the store orders by
 * `evaluated_at ASC, id ASC`, so the first row under the same filter is the row `.find()` returned.
 *
 * Takes the three fields rather than a whole `CaseRecord` so a caller holding only the ids can use it,
 * and so the signature says precisely what the lookup is keyed on.
 */
import type { OutcomeRecord, OutcomeStore } from "../stores/outcome-store.ts";

export async function outcomeForCase(
  outcomes: Pick<OutcomeStore, "listOutcomes">,
  lastRunId: string,
  subjectId: string,
  measureId: string,
): Promise<OutcomeRecord | null> {
  const rows = await outcomes.listOutcomes(lastRunId, { subjectId, measureId, limit: 1 });
  return rows[0] ?? null;
}
