import React from "react";
import { COMPLIANCE_STATUS_LABELS, complianceStatusClass, labelFor } from "@/lib/status";
import type { RosterCell, StaffClosure } from "./types";

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
        className={`inline-block text-neutral-600 dark:text-neutral-500 ${className}`}
        title={detail}
        aria-label={detail}
      >
        <span aria-hidden="true">—</span>
        <span className="sr-only">{detail}</span>
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
      {cell.staffClosure ? <StaffClosureMarker closure={cell.staffClosure} /> : null}
      {cell.method ? (
        <span className="text-[11px] leading-tight text-neutral-500 dark:text-neutral-400">{cell.method}</span>
      ) : null}
    </div>
  );
}

/**
 * "Closed by staff" (#569) — a person closed the case while the measure still counts the patient.
 *
 * The status pill above is deliberately unchanged (it is what CQL says), so this marker is the only
 * thing telling a coordinator why an Overdue row is on nobody's work list. Its own text carries the
 * "still counted by CQL" clause: someone who filtered to Overdue and sees a closed marker must be
 * able to read the row without the legend, or it looks like a bug.
 */
export function StaffClosureMarker({ closure }: { closure: StaffClosure }) {
  const when = closure.closedAt ? new Date(closure.closedAt).toLocaleDateString() : null;
  const detail = `Closed by ${closure.closedBy}${when ? ` on ${when}` : ""} — still counted by CQL`;
  return (
    // No check mark: a tick is the universal "resolved" affordance and this marker means the opposite,
    // sitting directly under an Overdue pill. And the clause is VISIBLE rather than screen-reader-only,
    // because a sighted user reading one row must not have to hover to learn that the gap is still
    // counted — the full sentence (who, and when) stays in the title.
    <span
      className="inline-flex w-fit items-center rounded-full border border-neutral-300 bg-transparent px-1.5 py-0.5 text-[10px] font-medium text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
      title={detail}
    >
      Closed by staff · still counted
      <span className="sr-only">{` — ${detail}`}</span>
    </span>
  );
}
