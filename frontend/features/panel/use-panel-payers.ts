"use client";

/**
 * The primary-payer ("insurance") reference data the panel filters need.
 *
 * Sibling of `use-panel-providers`: the endpoint, the option ordering and the wording live here so the
 * roster, the case list and the patient work list cannot disagree about what a payer is. The markup
 * stays with each page, for the reason that hook's header gives.
 *
 * **The grouping is the point, not a nicety.** Source of Payment Typology codes are hierarchical:
 * `1` is Medicare and `11` is its managed-care child, which the practice calls Medicare Advantage. On
 * the pilot's roster that is ~3,900 and ~2,900 patients. A flat list of four options invites someone
 * to tick "Medicare", get the smaller number, and never learn the rest were withheld — so the filter
 * is MULTI-select, the options carry their category and their count, and selecting a category selects
 * every code in it that the roster actually has.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApi } from "@/lib/api/hooks";

export type PanelPayer = {
  code: string;
  name: string;
  group: string;
  groupName: string;
  subjectCount: number;
};

export function usePanelPayers(): {
  payers: PanelPayer[];
  /** True once the server has answered with at least one payer — a UI hides the filter otherwise. */
  available: boolean;
  /** Options in server order (category, then code), labelled with name and count. */
  options: { value: string; label: string; group: string; groupName: string }[];
  /** The categories present, each with the codes under it — for a "Medicare (all)" affordance. */
  groups: { group: string; groupName: string; codes: string[]; subjectCount: number }[];
  /** Resolve a code to its display name; an active-filter chip must never show a bare number. */
  nameFor: (code: string) => string | undefined;
  /** Every code present in the same category as `code` — what "Medicare" means on THIS roster. */
  codesInGroupOf: (code: string) => string[];
} {
  const api = useApi();
  const [payers, setPayers] = useState<PanelPayer[]>([]);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<PanelPayer[]>("/api/payers")
      .then((rows) => {
        if (!cancelled) setPayers(rows ?? []);
      })
      // A payer list that fails to load leaves the filter empty rather than breaking the page — and an
      // empty list is also the honest answer on a deployment whose roster records no payer.
      .catch(() => {
        if (!cancelled) setPayers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const options = useMemo(
    () =>
      payers.map((p) => ({
        value: p.code,
        label: `${p.name} (${p.subjectCount.toLocaleString()})`,
        group: p.group,
        groupName: p.groupName,
      })),
    [payers],
  );

  const groups = useMemo(() => {
    const byGroup = new Map<string, { group: string; groupName: string; codes: string[]; subjectCount: number }>();
    for (const p of payers) {
      const existing = byGroup.get(p.group);
      if (existing) {
        existing.codes.push(p.code);
        existing.subjectCount += p.subjectCount;
      } else {
        byGroup.set(p.group, { group: p.group, groupName: p.groupName, codes: [p.code], subjectCount: p.subjectCount });
      }
    }
    // Only categories with MORE THAN ONE code are worth an "all" affordance; a single-code category
    // would render a second control that does exactly what the option beside it already does.
    return [...byGroup.values()].filter((g) => g.codes.length > 1);
  }, [payers]);

  const nameFor = useCallback((code: string) => payers.find((p) => p.code === code)?.name, [payers]);

  const codesInGroupOf = useCallback(
    (code: string) => {
      const group = payers.find((p) => p.code === code)?.group;
      if (!group) return [code];
      return payers.filter((p) => p.group === group).map((p) => p.code);
    },
    [payers],
  );

  return { payers, available: payers.length > 0, options, groups, nameFor, codesInGroupOf };
}

/** The label for the filter. "Insurance" is what the practice calls it; "payer" is what the data calls it. */
export const payerFilterLabel = "Insurance";
