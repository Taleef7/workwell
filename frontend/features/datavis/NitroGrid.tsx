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

  return (
    <DataVisNitroContext.Provider value={view}>
      <DataVisNitroGrid columns={columns} {...gridProps} />
    </DataVisNitroContext.Provider>
  );
}
