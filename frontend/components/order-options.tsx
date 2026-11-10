/**
 * A measure's order options (#620, #640): shared by the Orders page and the case page's panel.
 * Catalog text only. Whether a code is card-ready is an admin's approval (owner decision 2026-11-04).
 */

/** One option of a measure's order set: catalog text, and whether an admin approved the code for cards. */
export type OrderOptionView = {
  key: string;
  code: string;
  system: string;
  display: string;
  interval?: string;
  audience?: string;
  note?: string;
  suggestible: boolean;
  approved: boolean;
};

export type MeasureOrdersView = { mode: "protocol" | "choice"; caveat?: string; options: OrderOptionView[] };

export function systemLabel(system: string): string {
  if (system.includes("HCPCS")) return "HCPCS";
  if (system.includes("cpt")) return "CPT";
  if (system.includes("cvx")) return "CVX";
  if (system.includes("loinc")) return "LOINC";
  if (system.includes("urn:workwell")) return "LOCAL";
  return system;
}

/** Card-ready, awaiting admin approval, or listed only (a LOCAL option is never offered on a card). */
export function CardReadyBadge({ option }: { option: Pick<OrderOptionView, "approved" | "suggestible"> }) {
  if (!option.suggestible) {
    return (
      <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
        Listed only
      </span>
    );
  }
  return option.approved ? (
    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
      Card-ready
    </span>
  ) : (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
      Awaiting admin approval
    </span>
  );
}

export function CodeChip({ system, code }: { system: string; code: string }) {
  return (
    <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
      {systemLabel(system)} {code}
    </span>
  );
}
