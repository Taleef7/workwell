import React from "react";
import { COMPLIANCE_STATUS_LABELS, complianceStatusClass, labelFor } from "@/lib/status";
import type { RosterCell } from "./types";

// UX-4: on many panels most cells are NA / NOT_APPLICABLE (a measure doesn't apply to a subject's
// cohort). Rendered as full gray pills + two-line explanations they form a wall that drowns the few
// actionable cells. De-emphasize them to a single dim dash — the full label + method stay available via
// tooltip and an accessible label (so AT users and hover still get the meaning; not color/shape alone).
const DE_EMPHASIZED = new Set(["NA", "NOT_APPLICABLE"]);

/** One roster cell: a status pill (color + text) with the method string beneath — except NA/Not-applicable
 *  cells, which render as a de-emphasized dash. Method text comes verbatim from the read model (E10.5);
 *  the UI never re-derives it. */
export function ComplianceChip({ cell, className = "" }: { cell: RosterCell; className?: string }) {
  const label = labelFor(COMPLIANCE_STATUS_LABELS, cell.status);

  if (DE_EMPHASIZED.has(cell.status)) {
    const detail = `${label}${cell.method ? ` — ${cell.method}` : ""}`;
    return (
      <span
        className={`inline-block text-neutral-300 dark:text-neutral-600 ${className}`}
        title={detail}
        aria-label={detail}
      >
        —
      </span>
    );
  }

  return (
    <div className={`flex flex-col gap-0.5 ${className}`} title={cell.method || undefined}>
      <span
        className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-semibold ${complianceStatusClass(cell.status)}`}
      >
        {label}
      </span>
      {cell.method ? (
        <span className="text-[11px] leading-tight text-neutral-500 dark:text-neutral-400">{cell.method}</span>
      ) : null}
    </div>
  );
}
