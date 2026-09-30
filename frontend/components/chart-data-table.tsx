/**
 * ChartDataTable — a screen-reader-only data table that is the accessible
 * alternative to a (visual-only) Recharts chart (WCAG 1.1.1 non-text content).
 *
 * Recharts renders an SVG that conveys nothing to assistive tech, so each chart's
 * visual container is marked `aria-hidden="true"` and paired with this component,
 * which renders the same numbers as a real <table> with a <caption> and scoped
 * column headers. The `sr-only` class (Tailwind core) keeps it out of the visual
 * layout while leaving it in the accessibility tree, so a screen-reader user gets
 * the underlying data instead of an unlabeled graphic.
 *
 * The `sr-only` class sits on a wrapping <div>, not on the <table>: table layout ignores `width: 1px`
 * and sizes to its content, so an `sr-only` table still widened the page (every Programs card's trend
 * table made the page scroll sideways on a phone, and at 768px). A block box honours the 1px width
 * and clips what it holds (#700).
 */

export type ChartCell = string | number | null | undefined;

export function ChartDataTable({
  caption,
  columns,
  rows,
  emptyLabel = "No data",
}: {
  caption: string;
  columns: string[];
  rows: ChartCell[][];
  emptyLabel?: string;
}) {
  return (
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        {rows.length === 0 ? (
          <tbody>
            <tr>
              <td>{emptyLabel}</td>
            </tr>
          </tbody>
        ) : (
          <>
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col} scope="col">
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{cell ?? "—"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </>
        )}
      </table>
    </div>
  );
}
