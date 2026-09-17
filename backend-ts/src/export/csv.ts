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

/**
 * A cell holding text a PERSON supplied, neutralised against spreadsheet formula injection.
 *
 * `csvCell` quotes correctly and does not defuse: a value beginning `=`, `+`, `-`, `@`, tab or CR is
 * evaluated as a formula by Excel, Sheets and LibreOffice when the file is opened, which turns a CSV
 * of somebody's uploaded identifiers into code they did not write. A leading apostrophe is the
 * standard neutralisation and is stripped by the spreadsheet on display.
 *
 * Only for user-supplied text — raw identifiers, list names, sources, notes. A status or a count
 * cannot begin with any of those characters, and prefixing one would change a value the consumer
 * parses.
 */
const FORMULA_LEAD = new Set(["=", "+", "-", "@", "\t", "\r"]);

export function csvTextCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return csvCell(FORMULA_LEAD.has(s[0] ?? "") ? `'${s}` : s);
}

/** Build a CSV document from a header row + data rows (each row an array of cell values). */
export function toCsv(headers: readonly string[], rows: readonly unknown[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return lines.join("\r\n");
}
