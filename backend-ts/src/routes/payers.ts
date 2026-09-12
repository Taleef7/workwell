/**
 * Payers route — the insurance list the panel filters are populated from (MM-2, the practice's ask).
 *
 *   GET /api/payers → { code, name, group, groupName, subjectCount }[]
 *
 * Read-only and authenticated like `/api/providers` (the /api/** catch-all GET → AUTHENTICATED), and
 * profile-scoped the same way: it reports the payers PRESENT in this deployment's directory, never the
 * Source of Payment Typology in the abstract. A deployment whose roster records no payer — the
 * occupational directory, and a live WebChart directory until Coverage extraction lands (#533) —
 * returns `[]`, which is what a UI needs to hide the filter rather than render an empty select.
 *
 * **`subjectCount` is here so the Medicare grouping is VISIBLE.** The typology is hierarchical: `1` is
 * Medicare and `11` is its managed-care child, which the practice calls Medicare Advantage. On the
 * pilot corpus that is 3,927 and 2,900 patients. A select that lists them as two unrelated lines
 * invites someone to pick one and believe they have the Medicare panel — so the response carries the
 * category each code belongs to AND how many subjects sit under the code, and the UI groups on it. The
 * filter predicate still matches exact codes (`subject-filters.ts`); grouping is something the caller
 * opts into by selecting several, never something done behind their back.
 *
 * Counts are over the whole profile-scoped directory, NOT over cases or outcomes: this populates a
 * filter's options, and an option that reads "0" because nobody on it has an open gap today would
 * disappear tomorrow. What it means is "patients in this deployment with this payer".
 */
import { employees } from "../config/deployment-profile.ts";
import {
  comparePayerCodes, payerGroupNameOf, payerGroupOf, payerNameOf,
} from "../engine/synthetic/payer-display.ts";

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

export interface PayerOption {
  readonly code: string;
  readonly name: string;
  readonly group: string;
  readonly groupName: string;
  readonly subjectCount: number;
}

/** The payers present in a roster, with their counts — pure, so the tests need no HTTP. */
export function payerOptionsFor(roster: readonly { payer?: string }[]): PayerOption[] {
  const counts = new Map<string, number>();
  for (const subject of roster) {
    const code = subject.payer?.trim();
    if (!code) continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()]
    // Sorted by category then numerically within it, so Medicare's two codes render adjacent. A
    // lexicographic sort puts `11` before `2`, which reads as an arbitrary order to the one person
    // the ordering exists for.
    .sort(([a], [b]) => comparePayerCodes(a, b))
    .map(([code, subjectCount]) => {
      const group = payerGroupOf(code);
      return { code, name: payerNameOf(code), group, groupName: payerGroupNameOf(group), subjectCount };
    });
}

export async function handlePayers(req: Request): Promise<Response | null> {
  if (req.method !== "GET") return null;
  if (new URL(req.url).pathname !== "/api/payers") return null;
  return json(payerOptionsFor(employees()));
}
