/**
 * Which order codes an admin has approved, and the clinic's own code for each (#640 item 2; owner decision
 * 2026-11-04). Read from the STORE on every request, never the seed, so approving or revoking a code takes
 * effect without a deploy. One reader for the CDS service, the orders page and the case page, so the three
 * cannot disagree about whether a code is card-ready.
 *
 * - `approved`: `system|code` of every national code with at least one APPROVED mapping.
 * - `clinicCodes`: for an approved national code, the clinic's own code, from an APPROVED mapping whose local
 *   code differs from the national one. Never a `urn:workwell:*` code (the TWH demo rows'
 *   `urn:workwell:demo` must not reach a real EHR), and never the code's own row (local = national), which
 *   records an approval and carries no clinic code. The review path allows at most one such clinic code per
 *   national code; if two were ever approved at once (nothing in the database prevents it), the first in
 *   the store's order wins, deterministically.
 */
import type { TerminologyMappingRecord } from "../stores/value-set-store.ts";
import type { OrderCode } from "./proposed-order.ts";

export interface ApprovedOrderCodes {
  approved: ReadonlySet<string>;
  clinicCodes: ReadonlyMap<string, OrderCode>;
}

export const standardKeyOf = (m: Pick<TerminologyMappingRecord, "standardSystem" | "standardCode">): string =>
  `${m.standardSystem}|${m.standardCode}`;

/** A mapping that names a clinic code (not the code's own approval row, not a WorkWell-internal system). */
export const isClinicCodeRow = (m: TerminologyMappingRecord): boolean =>
  !(m.localSystem === m.standardSystem && m.localCode === m.standardCode) && !m.localSystem.startsWith("urn:workwell:");

export function approvedOrderCodesOf(mappings: readonly TerminologyMappingRecord[]): ApprovedOrderCodes {
  const approved = new Set<string>();
  const clinicCodes = new Map<string, OrderCode>();
  for (const m of mappings) {
    if (m.mappingStatus !== "APPROVED") continue;
    const key = standardKeyOf(m);
    approved.add(key);
    if (isClinicCodeRow(m) && !clinicCodes.has(key)) {
      clinicCodes.set(key, { system: m.localSystem, code: m.localCode, display: m.localDisplay ?? m.standardDisplay ?? m.localCode });
    }
  }
  return { approved, clinicCodes };
}

export async function readApprovedOrderCodes(store: {
  listTerminologyMappings(): Promise<TerminologyMappingRecord[]>;
}): Promise<ApprovedOrderCodes> {
  return approvedOrderCodesOf(await store.listTerminologyMappings());
}
