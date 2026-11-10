"use client";

import { useState } from "react";

/**
 * What the measure's own CQL found for the patient, on the case page (#880): `CaseDetail.cqlFindings`,
 * built on the server by the attributed-list report's own reader, so this screen and the report's CSV
 * say the same thing about one outcome. Every value is CQL's rendering, labelled by the define that
 * computed it; nothing here interprets a reading or decides anything (AI_GUARDRAILS §1).
 */
export type EvidenceStatus =
  | "NOT_APPLICABLE"
  | "NOT_EXPOSED_BY_LOGIC"
  | "NOT_RECORDED_BY_RUN"
  | "NUMERATOR_EVIDENCE"
  | "LATEST_NOT_QUALIFYING"
  | "NONE_FOUND";

export interface CaseCqlFindings {
  status: EvidenceStatus;
  /** The rate's label on a multi-rate measure ("Initiation"); null on a single-rate one. */
  rate: string | null;
  date: string | null;
  /** The define the date came from, so it never reads as a date WorkWell chose. */
  dateLabel: string | null;
  executedLogic: string | null;
  values: Array<{ label: string; value: string }>;
}

/** A value longer than this is clamped to one line until "Show all" (a FHIR resource rendered by CQL). */
const LONG_VALUE = 80;

export function CqlFindings({ findings }: { findings?: CaseCqlFindings | null }) {
  const [expanded, setExpanded] = useState(false);
  // Nothing recorded (authored CQL, a run before the facts were kept) or not scored on the rate: the page
  // says nothing rather than "nothing found", which would be a claim about the chart.
  if (!findings || findings.status === "NOT_RECORDED_BY_RUN" || findings.status === "NOT_APPLICABLE") return null;
  const hasLong = findings.values.some((v) => v.value.length > LONG_VALUE);
  return (
    <div className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-800/50" data-testid="cql-findings">
      <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
        What the measure found{findings.rate ? ` · ${findings.rate}` : ""}
      </p>
      {findings.status === "NOT_EXPOSED_BY_LOGIC" ? (
        <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">This measure&apos;s logic doesn&apos;t report which result it found.</p>
      ) : null}
      {findings.status === "NONE_FOUND" ? (
        // What CQL did record (CMS137's episode) is why the patient is in the measure, not what meets it.
        <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">Nothing found that meets the measure.</p>
      ) : null}
      {findings.date ? (
        <p className="mt-2 text-sm text-neutral-900 dark:text-neutral-100">
          Latest found: <span className="font-semibold">{findings.date}</span>
          {findings.dateLabel ? <span className="text-neutral-500 dark:text-neutral-400">, {findings.dateLabel}</span> : null}
        </p>
      ) : null}
      {findings.values.length > 0 ? (
        <dl className="mt-3 space-y-2 text-xs">
          {findings.values.map((v, index) => (
            <div key={`${v.label}-${index}`} className="grid gap-1 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:gap-3">
              <dt className="text-neutral-500 dark:text-neutral-400">{v.label}</dt>
              <dd
                className={`min-w-0 font-mono text-neutral-900 [overflow-wrap:anywhere] dark:text-neutral-100 ${
                  expanded ? "whitespace-pre-wrap" : "sm:line-clamp-1"
                }`}
                title={expanded ? undefined : v.value}
              >
                {v.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {hasLong ? (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          className="mt-2 hidden text-xs font-medium text-primary-700 hover:underline sm:inline dark:text-primary-400"
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      ) : null}
      {findings.executedLogic ? (
        <p className="mt-3 text-[11px] text-neutral-500 dark:text-neutral-400">Computed by {findings.executedLogic}.</p>
      ) : null}
    </div>
  );
}
