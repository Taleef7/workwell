import React from "react";
import Link from "next/link";
import { ComplianceChip } from "./ComplianceChip";
import type { RosterColumn, RosterRow, RosterCell } from "./types";

const NA_FALLBACK: RosterCell = { status: "NA", method: "Not evaluated" };

/**
 * UX-11 — the `/compliance` roster as per-employee cards for phones (the wide table shows ~1.5
 * columns per screen). Same data as the table; hidden at `md`+ (the table takes over). Each card is
 * an employee header (name link + tenant · site · role) over a `<dl>` of measure → ComplianceChip,
 * so assistive tech gets an explicit measure→status pairing without the table's off-screen columns.
 */
export function RosterMobileCards({
  columns,
  rows,
  loading,
}: {
  columns: RosterColumn[];
  rows: RosterRow[];
  loading: boolean;
}) {
  if (loading && rows.length === 0) {
    return <p className="rounded-lg border border-neutral-200 p-4 text-center text-sm text-neutral-500 dark:border-neutral-800 md:hidden">Loading…</p>;
  }
  if (rows.length === 0) {
    return <p className="rounded-lg border border-neutral-200 p-4 text-center text-sm text-neutral-500 dark:border-neutral-800 md:hidden">No employees match these filters.</p>;
  }
  return (
    <ul className="space-y-3 md:hidden">
      {rows.map((r) => (
        <li key={r.subject.externalId} className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
          <Link
            href={`/employees/${encodeURIComponent(r.subject.externalId)}`}
            className="font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            {r.subject.name}
          </Link>
          <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
            {r.subject.tenantName} · {r.subject.site} · {r.subject.role}
          </div>
          <dl className="mt-2 divide-y divide-neutral-100 dark:divide-neutral-800/70">
            {columns.map((c) => (
              <div key={c.measureId} className="flex items-start justify-between gap-3 py-1.5">
                <dt className="text-sm text-neutral-700 dark:text-neutral-300">
                  {c.name}
                  <span className="ml-1 text-[10px] font-normal uppercase text-neutral-400">
                    {c.complianceClass === "PERMANENT" ? "perm" : "rec"}
                  </span>
                </dt>
                <dd className="text-right">
                  <ComplianceChip cell={r.cells[c.measureId] ?? NA_FALLBACK} className="items-end" />
                </dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}
