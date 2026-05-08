export function measureStatusClass(status: string): string {
  const normalized = status.toUpperCase();
  if (normalized === "DRAFT") return "bg-slate-100 text-slate-700";
  if (normalized === "APPROVED") return "bg-blue-100 text-blue-700";
  if (normalized === "ACTIVE") return "bg-emerald-100 text-emerald-700";
  return "bg-slate-300 text-slate-800";
}

export function outcomeStatusClass(status: string): string {
  const normalized = status.toUpperCase();
  if (normalized === "COMPLIANT") return "bg-emerald-100 text-emerald-800";
  if (normalized === "DUE_SOON") return "bg-amber-100 text-amber-800";
  if (normalized === "OVERDUE") return "bg-rose-100 text-rose-800";
  if (normalized === "MISSING_DATA") return "bg-violet-100 text-violet-800";
  if (normalized === "EXCLUDED") return "bg-indigo-100 text-indigo-800";
  return "bg-slate-100 text-slate-700";
}

export function caseStatusClass(status: string): string {
  const normalized = status.toUpperCase();
  if (normalized === "OPEN") return "bg-amber-100 text-amber-900";
  if (normalized === "IN_PROGRESS") return "bg-blue-100 text-blue-900";
  if (normalized === "RESOLVED") return "bg-emerald-100 text-emerald-900";
  if (normalized === "CLOSED") return "bg-slate-100 text-slate-700";
  if (normalized === "EXCLUDED") return "bg-indigo-100 text-indigo-900";
  return "bg-slate-100 text-slate-700";
}
