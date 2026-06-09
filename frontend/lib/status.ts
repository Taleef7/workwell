export const MEASURE_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  APPROVED: "Approved",
  ACTIVE: "Active",
  DEPRECATED: "Deprecated"
};

export const OUTCOME_LABELS: Record<string, string> = {
  COMPLIANT: "Compliant",
  DUE_SOON: "Due Soon",
  OVERDUE: "Overdue",
  MISSING_DATA: "Missing Data",
  EXCLUDED: "Excluded"
};

export const CASE_STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In Progress",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  EXCLUDED: "Excluded"
};

export const STATUS_LABELS = CASE_STATUS_LABELS;

export const PRIORITY_LABELS: Record<string, string> = {
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low"
};

export const ROLE_LABELS: Record<string, string> = {
  ROLE_ADMIN: "Admin",
  ROLE_CASE_MANAGER: "Case Manager",
  ROLE_AUTHOR: "Author",
  ROLE_APPROVER: "Approver",
  ROLE_VIEWER: "Viewer",
  ROLE_MCP_CLIENT: "MCP Client",
  ADMIN: "Admin",
  CASE_MANAGER: "Case Manager",
  AUTHOR: "Author",
  APPROVER: "Approver",
  VIEWER: "Viewer",
  MCP_CLIENT: "MCP Client"
};

export const SCOPE_LABELS: Record<string, string> = {
  ALL_PROGRAMS: "All Programs",
  MEASURE: "Measure",
  SITE: "Site",
  EMPLOYEE: "Employee",
  CASE: "Case"
};

export const RUN_STATUS_LABELS: Record<string, string> = {
  COMPLETED: "Completed",
  RUNNING: "Running",
  FAILED: "Failed",
  PARTIAL: "Partial",
  PARTIAL_FAILURE: "Partial Failure",
  CANCELLED: "Cancelled",
  REQUESTED: "Requested",
  QUEUED: "Queued"
};

export const TRIGGER_LABELS: Record<string, string> = {
  MANUAL: "Manual",
  SCHEDULED: "Scheduled",
  SCHEDULER: "Scheduled",
  CASE_RERUN: "Case Rerun"
};

export function normalizeEnumValue(value: string): string {
  return value.trim().replace(/[-\s]+/g, "_").toUpperCase();
}

export function formatStatusLabel(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  const cleaned = value.trim().replace(/[_-]+/g, " ");
  return cleaned.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function labelFor(map: Record<string, string>, value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  const normalized = normalizeEnumValue(value);
  return map[normalized] ?? formatStatusLabel(value);
}

export function measureStatusClass(status: string): string {
  const normalized = normalizeEnumValue(status);
  if (normalized === "DRAFT") return "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  if (normalized === "APPROVED") return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300";
  if (normalized === "ACTIVE") return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300";
  return "bg-neutral-300 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-200";
}

export function outcomeStatusClass(status: string): string {
  const normalized = normalizeEnumValue(status);
  if (normalized === "COMPLIANT") return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
  if (normalized === "DUE_SOON") return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
  if (normalized === "OVERDUE") return "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300";
  if (normalized === "MISSING_DATA") return "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300";
  if (normalized === "EXCLUDED") return "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300";
  return "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
}

export function caseStatusClass(status: string): string {
  const normalized = normalizeEnumValue(status);
  if (normalized === "OPEN") return "bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200";
  if (normalized === "IN_PROGRESS") return "bg-blue-100 text-blue-900 dark:bg-blue-900/30 dark:text-blue-200";
  if (normalized === "RESOLVED") return "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200";
  if (normalized === "CLOSED") return "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  if (normalized === "EXCLUDED") return "bg-indigo-100 text-indigo-900 dark:bg-indigo-900/30 dark:text-indigo-200";
  return "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
}
