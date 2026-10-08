import React from "react";
import Link from "next/link";
import { ComplianceChip } from "./ComplianceChip";
import { SUBJECT } from "@/lib/terminology";
import { subjectPath } from "@/lib/subject-path";
import type { ScoringLogic } from "@/lib/measure-identity";
import { columnLogic, type RosterColumn, type RosterRow, type RosterCell } from "./types";

type MeasureLabel = (measureId: string, fallbackName: string, logic?: ScoringLogic | null) => string;

const NA_FALLBACK: RosterCell = { status: "NA", method: "Not evaluated" };

/**
 * Selection on the cards, so a phone or a narrow tablet can assign from the roster (#700): the
 * checkboxes had lived only in the desktop table. The page passes the same state the table uses, so
 * the rule stays one rule — only a row with an open case for the chosen measure is selectable.
 */
export interface RosterCardSelection {
  selectableIds: string[];
  selectedIds: string[];
  onToggle: (externalId: string, on: boolean) => void;
}

/**
 * UX-11 — the `/compliance` roster as profile cards for phones (the wide table shows ~1.5
 * columns per screen). Same data as the table; hidden at `md`+ (the table takes over). Each card is
 * a profile header (name link + tenant · site · role) over a `<dl>` of measure → ComplianceChip,
 * so assistive tech gets an explicit measure→status pairing without the table's off-screen columns.
 */
export function RosterMobileCards({
  columns,
  rows,
  loading,
  labelFor,
  titleFor,
  selection,
}: {
  columns: RosterColumn[];
  rows: RosterRow[];
  loading: boolean;
  /** Names a column's measure, given the logic that scored its winning run (#769). */
  labelFor?: MeasureLabel;
  /** The term's tooltip (the full form), when given. */
  titleFor?: MeasureLabel;
  selection?: RosterCardSelection;
}) {
  const isPatientTerm = SUBJECT.singular === "patient";
  if (loading && rows.length === 0) {
    return <p className="rounded-lg border border-neutral-200 p-4 text-center text-sm text-neutral-500 dark:border-neutral-800 md:hidden">Loading…</p>;
  }
  if (rows.length === 0) {
    return <p className="rounded-lg border border-neutral-200 p-4 text-center text-sm text-neutral-500 dark:border-neutral-800 md:hidden">{`No ${SUBJECT.plural} match these filters.`}</p>;
  }
  return (
    <ul aria-label={`${SUBJECT.Singular} cards`} className="space-y-3 md:hidden">
      {rows.map((r) => (
        <li
          key={r.subject.externalId}
          className={`rounded-lg border border-neutral-200 p-3 dark:border-neutral-800 ${selection?.selectedIds.includes(r.subject.externalId) ? "bg-primary-50/60 dark:bg-primary-900/20" : ""}`}
        >
          <div className="flex items-start gap-2">
            {selection ? (
              // A 44px target around the box: a bare checkbox is a 13px tap on a phone.
              <label className="-m-2 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center">
                <input
                  type="checkbox"
                  className="h-5 w-5"
                  aria-label={`Select ${r.subject.name}`}
                  checked={selection.selectedIds.includes(r.subject.externalId)}
                  disabled={!selection.selectableIds.includes(r.subject.externalId)}
                  onChange={(e) => selection.onToggle(r.subject.externalId, e.target.checked)}
                />
              </label>
            ) : null}
            <div className="min-w-0">
              <Link
                href={subjectPath(r.subject.externalId)}
                className="font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                {r.subject.name}
              </Link>
              <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                {r.subject.tenantName} · {r.subject.site}{isPatientTerm ? null : <> · {r.subject.role}</>}
              </div>
            </div>
          </div>
          <dl className="mt-2 divide-y divide-neutral-100 dark:divide-neutral-800/70">
            {columns.map((c) => (
              <div key={c.measureId} className="flex items-start justify-between gap-3 py-1.5">
                <dt
                  className="text-sm text-neutral-700 dark:text-neutral-300"
                  title={titleFor ? titleFor(c.measureId, c.name, columnLogic(c)) : undefined}
                >
                  {labelFor ? labelFor(c.measureId, c.name, columnLogic(c)) : c.name}
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
