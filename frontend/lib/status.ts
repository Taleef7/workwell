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
  if (normalized === "DRAFT") return "bg-slate-100 text-slate-700";
  if (normalized === "APPROVED") return "bg-blue-100 text-blue-700";
  if (normalized === "ACTIVE") return "bg-emerald-100 text-emerald-700";
  return "bg-slate-300 text-slate-800";
}

export function outcomeStatusClass(status: string): string {
  const normalized = normalizeEnumValue(status);
  if (normalized === "COMPLIANT") return "bg-emerald-100 text-emerald-800";
  if (normalized === "DUE_SOON") return "bg-amber-100 text-amber-800";
  if (normalized === "OVERDUE") return "bg-rose-100 text-rose-800";
  if (normalized === "MISSING_DATA") return "bg-violet-100 text-violet-800";
  if (normalized === "EXCLUDED") return "bg-indigo-100 text-indigo-800";
  return "bg-slate-100 text-slate-700";
}

export function caseStatusClass(status: string): string {
  const normalized = normalizeEnumValue(status);
  if (normalized === "OPEN") return "bg-amber-100 text-amber-900";
  if (normalized === "IN_PROGRESS") return "bg-blue-100 text-blue-900";
  if (normalized === "RESOLVED") return "bg-emerald-100 text-emerald-900";
  if (normalized === "CLOSED") return "bg-slate-100 text-slate-700";
  if (normalized === "EXCLUDED") return "bg-indigo-100 text-indigo-900";
  return "bg-slate-100 text-slate-700";
}
