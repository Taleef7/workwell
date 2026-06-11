"use client";

/**
 * NitroGridClient — SSR-disabled lazy loader for the NITRO data grid.
 *
 * The NITRO runtime (`datavis-ace` → `json-formatter-js`) reads `window` at module load,
 * which crashes during server rendering. Loading `NitroGrid` via `next/dynamic` with
 * `ssr: false` guarantees the grid (and its module graph) only ever evaluates in the browser.
 *
 * Pages should import THIS component, not `NitroGrid` or `@mieweb/ui/datavis` directly.
 */

import dynamic from "next/dynamic";

const NitroGridClient = dynamic(() => import("./NitroGrid"), {
  ssr: false,
  loading: () => (
    <div className="flex h-40 items-center justify-center rounded-md border border-neutral-200 bg-white text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
      Loading grid…
    </div>
  ),
});

export default NitroGridClient;
export type { NitroGridProps, NitroGridColumn } from "./NitroGrid";
