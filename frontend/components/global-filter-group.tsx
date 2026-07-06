"use client";

import React from "react";

/**
 * GlobalFilterGroup — a labelled wrapper around the app-wide site/time selectors
 * that live in the dashboard header (UX-13).
 *
 * The header's "All Sites" / "All time" selectors scope *every* page's data
 * (compliance roster, programs overview, cases, runs, admin waivers…), while each
 * page also has its own on-page filter bar (System, Segment, Panel, Status…). With
 * no visual distinction it was "not discoverable which filter governs which surface"
 * (Fable UX-13). This wrapper gives the header selectors a visible "Global" caption
 * and an accessible group name so both sighted and AT users can tell at a glance that
 * these controls apply app-wide — distinct from the page-local filters below them.
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
      aria-label="Global filters (apply to all pages)"
      title="These filters apply across every page"
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
