/**
 * Minimal RFC-4180 CSV writer for the export endpoints (#108 exports). A cell is quoted
 * only when it contains a comma, quote, or newline; embedded quotes are doubled. Null/
 * undefined render as the empty string. Header + rows are joined with CRLF.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV document from a header row + data rows (each row an array of cell values). */
export function toCsv(headers: readonly string[], rows: readonly unknown[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return lines.join("\r\n");
}
