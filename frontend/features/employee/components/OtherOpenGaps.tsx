"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApi } from "@/lib/api/hooks";
import { OUTCOME_LABELS, labelFor, outcomeStatusClass } from "@/lib/status";
import { SUBJECT } from "@/lib/terminology";
import { subjectPath } from "@/lib/subject-path";
import { useMeasureIdentities } from "@/lib/measure-identity";
import { lastContactLine } from "@/features/employee/last-contact";
import type { OpenCaseSummary } from "@/features/employee/hooks/useEmployeeProfile";

type Load = { state: "loading" } | { state: "failed" } | { state: "loaded"; openCases: OpenCaseSummary[] };

/**
 * The patient's other open gaps, beside the one this case is about (#880). Working one gap, staff see
 * what else the patient is due for, and write one message about them on the patient page. It does not
 * promise "all": that page leaves CMS2 and CMS137 unticked until a person chooses them (#868). Read from
 * `GET /api/employees/:id/open-cases`, the patient page's own Open Cases, so the two cannot disagree.
 */
export function OtherOpenGaps({ subjectId, caseId, canMessage }: { subjectId: string; caseId: string; canMessage: boolean }) {
  const api = useApi();
  const { labelFor: measureLabelFor } = useMeasureIdentities();
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    let mounted = true;
    api
      .get<{ openCases?: unknown }>(`/api/employees/${encodeURIComponent(subjectId)}/open-cases`)
      .then((data) => {
        if (!mounted) return;
        // Anything but a list is a server this page does not understand, never "no other gaps".
        if (Array.isArray(data?.openCases)) setLoad({ state: "loaded", openCases: data.openCases as OpenCaseSummary[] });
        else setLoad({ state: "failed" });
      })
      .catch(() => {
        if (mounted) setLoad({ state: "failed" });
      });
    return () => {
      mounted = false;
    };
  }, [api, subjectId]);

  const others = load.state === "loaded" ? load.openCases.filter((c) => c.caseId !== caseId) : [];

  return (
    <div
      className="min-w-0 rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm sm:rounded-3xl sm:p-6 dark:border-neutral-800 dark:bg-neutral-900"
      data-testid="other-open-gaps"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500 dark:text-neutral-400">Other open gaps for this {SUBJECT.singular}</p>
      {load.state === "loading" ? <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">Loading…</p> : null}
      {load.state === "failed" ? (
        <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">The {SUBJECT.singular}&apos;s other open gaps could not be loaded.</p>
      ) : null}
      {load.state === "loaded" && others.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">No other open gaps for this {SUBJECT.singular}.</p>
      ) : null}
      {others.length > 0 ? (
        <ul className="mt-3 space-y-3">
          {others.map((c) => {
            const contact = lastContactLine(c);
            return (
              <li key={c.caseId} className="rounded-xl border border-neutral-200 p-3 text-sm dark:border-neutral-800">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-neutral-900 dark:text-neutral-100">{measureLabelFor(c.measureId, c.measureName, c.logic)}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${outcomeStatusClass(c.outcomeStatus)}`}>
                    {labelFor(OUTCOME_LABELS, c.outcomeStatus)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-neutral-500 [overflow-wrap:anywhere] dark:text-neutral-400">{c.assignee ? `Assigned to ${c.assignee}` : "Unassigned"}</p>
                {contact ? <p className="mt-0.5 text-xs text-neutral-500 [overflow-wrap:anywhere] dark:text-neutral-400">{contact}</p> : null}
                <Link href={`/cases/${c.caseId}`} className="mt-1 inline-block text-xs font-medium text-primary-700 hover:underline dark:text-primary-400">
                  Open case →
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
      {canMessage && others.length > 0 ? (
        <Link
          href={`${subjectPath(subjectId)}#open-cases`}
          className="mt-3 inline-block text-sm font-medium text-primary-700 hover:underline dark:text-primary-400"
        >
          Message the {SUBJECT.singular} about their gaps →
        </Link>
      ) : null}
    </div>
  );
}
