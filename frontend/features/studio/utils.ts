export type ParsedCompileIssue = {
  line: number;
  column: number;
  message: string;
};

export function parseCompileIssue(issue: string): ParsedCompileIssue | null {
  const exactMatch = issue.match(/^Line\s+(\d+),\s+Column\s+(\d+):\s+(?:ERROR|WARNING):\s+(.*)$/i);
  if (exactMatch) {
    return { line: Number(exactMatch[1]), column: Number(exactMatch[2]), message: exactMatch[3] };
  }
  const locationMatch = issue.match(/line\s+(\d+)(?:,\s*column\s+(\d+))?/i) ?? issue.match(/\[(\d+):(\d+)\]/);
  if (!locationMatch) return null;
  return { line: Number(locationMatch[1]), column: Number(locationMatch[2] ?? 1), message: issue };
}

export function formatIssue(issue: string): string {
  const parsed = parseCompileIssue(issue);
  if (!parsed) return issue;
  return `Line ${parsed.line}, Column ${parsed.column}: ${parsed.message}`;
}

export function compileStatusClass(status: string): string {
  const n = status.toUpperCase();
  if (n === "COMPILED") return "bg-emerald-100 text-emerald-700";
  if (n === "WARNINGS") return "bg-amber-100 text-amber-800";
  return "bg-red-100 text-red-700";
}

export function valueSetBadgeClass(status: string): string {
  if (status.toUpperCase() === "RESOLVED") return "border border-emerald-300 bg-emerald-100 text-emerald-800";
  return "border border-amber-300 bg-amber-100 text-amber-800";
}
