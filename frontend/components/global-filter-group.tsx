"use client";

import React from "react";

/**
 * GlobalFilterGroup — a labelled wrapper around the app-wide site/time selectors
 * that live in the dashboard header (UX-13).
 *
 * The header's site selector scopes every page's data, and its date range the lists that read one
 * (the work list and Cases by when a gap was opened, Runs by when a run started; hidden elsewhere,
 * #661), while each page also has its own on-page filter bar (System, Segment, Panel, Status…). With
 * no visual distinction it was "not discoverable which filter governs which surface"
 * (Fable UX-13). This wrapper gives the header selectors a visible "Global" caption
 * and an accessible group name so both sighted and AT users can tell at a glance that
 * these controls belong to the header — distinct from the page-local filters below them.
 *
 * Purely presentational: it changes no filter state, request params, or behavior.
 */
export function GlobalFilterGroup({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Global filters (the site applies to every page; a date range shows on the lists it filters)"
      title="The site applies to every page. The date range shows only on the lists it filters."
      className={`flex items-center gap-2 rounded-md border border-dashed border-neutral-300 px-2 py-1 dark:border-neutral-700 ${className ?? ""}`}
    >
      <span
        aria-hidden="true"
        className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500"
      >
        Global
      </span>
      {children}
    </div>
  );
}
