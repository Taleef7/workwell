import React from "react";
import { COMPLIANCE_STATUS_LABELS, complianceStatusClass, labelFor } from "@/lib/status";
import type { RosterCell } from "./types";

/** One roster cell: a status pill (color + text) with the method string beneath. Method text comes
 *  verbatim from the read model (E10.5); the UI never re-derives it. */
export function ComplianceChip({ cell, className = "" }: { cell: RosterCell; className?: string }) {
  return (
    <div className={`flex flex-col gap-0.5 ${className}`} title={cell.method || undefined}>
      <span
        className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-semibold ${complianceStatusClass(cell.status)}`}
      >
        {labelFor(COMPLIANCE_STATUS_LABELS, cell.status)}
      </span>
      {cell.method ? (
        <span className="text-[11px] leading-tight text-neutral-500 dark:text-neutral-400">{cell.method}</span>
      ) : null}
    </div>
  );
}
