"use client";

/**
 * NitroGrid — WorkWell wrapper around the MIE DataVis NITRO data grid.
 *
 * NITRO ships in `@mieweb/ui/datavis` but its runtime engine (`datavis-ace`) and the
 * grid source (`datavis`, vendored under `frontend/vendor/datavis`) are browser-only and
 * pull a dependency (`json-formatter-js`) that touches `window` at module load. This
 * component therefore:
 *   - is rendered client-only with SSR disabled (see `NitroGridClient`), and
 *   - builds an in-memory `ComputedView` from local rows (the upstream `createMockView`
 *     pattern) and feeds it to the published `DataVisNitroGrid` via `DataVisNitroContext`.
 *
 * Keep this the single integration seam: pages import the lazy `NitroGrid` below, never
 * `@mieweb/ui/datavis` directly.
 */

import { useMemo } from "react";
import {
  DataVisNitroContext,
  DataVisNitroGrid,
  type DataVisNitroColumn,
  type DataVisNitroGridProps,
} from "@mieweb/ui/datavis";
import { ComputedView, Source } from "datavis-ace";
import {
  buildLocalSourceTypeInfo,
  normalizeLocalSourceRows,
} from "datavis/src/adapters/wcdatavis-interop";
import type { ViewInstance } from "datavis/src/adapters/use-data";

export type NitroGridColumn = DataVisNitroColumn;

export interface NitroGridProps
  extends Omit<DataVisNitroGridProps, "columns" | "allColumns"> {
  /** Row objects to render. Field names become column keys when `columns` is omitted. */
  rows: Record<string, unknown>[];
  /** Optional explicit column config (string field names or full column objects). */
  columns?: NitroGridColumn[];
  /** Optional human-readable source name (shown in the grid title bar). */
  sourceName?: string;
}

let localSourceCounter = 0;

/**
 * Install an in-memory dataset on `window` under a unique var name and return a NITRO
 * `ComputedView` bound to it. Mirrors upstream `datavis/src/demo/mock-grid.createMockView`.
 */
function createLocalView(
  rows: Record<string, unknown>[],
  columns: NitroGridColumn[],
  sourceName: string,
): ViewInstance {
  const columnLikes = columns
    .filter((c): c is Exclude<NitroGridColumn, string> => typeof c !== "string")
    .map((c) => ({ field: c.field, typeInfo: c.typeInfo }));
  const typeInfo = buildLocalSourceTypeInfo(rows, columnLikes);
  const normalizedRows = normalizeLocalSourceRows(rows, typeInfo);

  localSourceCounter += 1;
  const varName = `__wcdv_workwell_source_${localSourceCounter}`;
  (window as unknown as Record<string, unknown>)[varName] = {
    data: normalizedRows,
    typeInfo,
  };

  const source = new Source(
    { type: "local", varName },
    [],
    undefined,
    { name: sourceName },
  );
  return new ComputedView(source, { name: sourceName }) as unknown as ViewInstance;
}

export default function NitroGrid({
  rows,
  columns,
  sourceName = "WorkWell",
  ...gridProps
}: NitroGridProps) {
  // Rebuild the view only when the data or column config actually changes.
  const view = useMemo(
    () => createLocalView(rows, columns ?? [], sourceName),
    [rows, columns, sourceName],
  );

  // A positioned frame gives the grid's two absolutely positioned pieces that have no positioned ancestor of
  // their own (the screen-reader "Skip to table" link, and the loading overlay) a containing block INSIDE the
  // page's scrolling <main>. Without it they were placed against the document: the skip link escaped <main>'s
  // clipping and stretched the page (on /runs, a second scrollbar into empty space below the app), and the
  // overlay dimmed a viewport-sized box at the top of the page rather than the grid. The grid's tooltips are
  // portals (fixed, outside the grid), so the frame does not clip them. `height` still sizes the grid itself,
  // not this frame: a caller wanting a percentage height needs the frame sized too.
  return (
    <div style={{ position: "relative" }} data-testid="nitro-grid-frame">
      <DataVisNitroContext.Provider value={view}>
        <DataVisNitroGrid columns={columns} {...gridProps} />
      </DataVisNitroContext.Provider>
    </div>
  );
}
