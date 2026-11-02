/**
 * Frontend role-based access mirror of `backend-ts/src/auth/authorize.ts`.
 *
 * The backend is the source of truth and 401/403s every request regardless of
 * what the UI shows. These helpers exist so the UI doesn't *surface* actions a
 * role cannot perform (e.g. an Author seeing a "Campaigns" nav link that the API
 * then 403s on). Keep the capability mapping in sync with authorize.ts.
 *
 * Role authorities (canonical, with the `ROLE_` prefix the JWT carries):
 *   ROLE_ADMIN          — everything
 *   ROLE_CASE_MANAGER   — the lead: case ops, runs, campaigns, lists, panels, bulk actions, orders, evidence
 *   ROLE_QUALITY_STAFF  — the staff seat (#880): works one case at a time, exports the CSVs, reads the
 *                         scorecard; the practice-wide levers stay with the lead
 *   ROLE_AUTHOR         — measure authoring (spec/CQL/tests, create)
 *   ROLE_APPROVER       — measure approve/activate/deprecate, MAT export
 *   ROLE_VIEWER         — read-only
 */

export const ROLES = {
  ADMIN: "ROLE_ADMIN",
  CASE_MANAGER: "ROLE_CASE_MANAGER",
  QUALITY_STAFF: "ROLE_QUALITY_STAFF",
  AUTHOR: "ROLE_AUTHOR",
  APPROVER: "ROLE_APPROVER",
  VIEWER: "ROLE_VIEWER",
  MCP_CLIENT: "ROLE_MCP_CLIENT",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/** Normalize any casing / missing-prefix form to the canonical `ROLE_*` authority. */
export function normRole(role: string | null | undefined): string {
  if (!role) return "";
  const upper = role.trim().toUpperCase().replace(/[\s-]+/g, "_");
  return upper.startsWith("ROLE_") ? upper : `ROLE_${upper}`;
}

/** True if `role` matches any authority in `allowed` (order-insensitive, prefix-tolerant). */
export function hasAnyRole(role: string | null | undefined, allowed: readonly string[]): boolean {
  const r = normRole(role);
  return allowed.some((a) => normRole(a) === r);
}

export const isAdmin = (role: string | null | undefined): boolean => normRole(role) === ROLES.ADMIN;

// Capability helpers — name the capability, not the route, so call sites read intent.
/** Trigger measure runs (POST /api/runs/**). */
export const canRunMeasures = (role: string | null | undefined): boolean =>
  hasAnyRole(role, [ROLES.CASE_MANAGER, ROLES.ADMIN]);

/** Work one case: assign/escalate/outreach/re-check (POST /api/cases/**) — the lead and the staff seat. */
export const canManageCases = (role: string | null | undefined): boolean =>
  hasAnyRole(role, [ROLES.CASE_MANAGER, ROLES.QUALITY_STAFF, ROLES.ADMIN]);

/**
 * Act on many cases at once: the selection checkboxes and the bulk bar (bulk assign, escalate, export
 * selected). The lead's (#880): `POST /api/cases/bulk-assign` refuses the staff seat.
 */
export const canActInBulk = (role: string | null | undefined): boolean =>
  hasAnyRole(role, [ROLES.CASE_MANAGER, ROLES.ADMIN]);

/** Attributed lists and `?listId=` (/api/subject-lists/**) — the lead's (#880, ADR-082). */
export const canUseLists = (role: string | null | undefined): boolean =>
  hasAnyRole(role, [ROLES.CASE_MANAGER, ROLES.ADMIN]);

/** Set who works a provider's panel (PUT/DELETE /api/panels/**) — the lead's (#880). */
export const canManagePanels = (role: string | null | undefined): boolean =>
  hasAnyRole(role, [ROLES.CASE_MANAGER, ROLES.ADMIN]);

/**
 * Download patient data in bulk as CSV (/api/exports/**) — the lead and the staff seat, mirroring the
 * backend gate (D5; owner decision 2026-11-02). Browsing the same rows in the app stays open to every
 * signed-in role.
 */
export const canExportData = (role: string | null | undefined): boolean =>
  hasAnyRole(role, [ROLES.CASE_MANAGER, ROLES.QUALITY_STAFF, ROLES.ADMIN]);

/** The files a report is filed from: QRDA I/III and MeasureReport (/api/runs/:id/…) — the lead's (#880). */
export const canExportReports = (role: string | null | undefined): boolean =>
  hasAnyRole(role, [ROLES.CASE_MANAGER, ROLES.ADMIN]);

/** Download the audit ledger (/api/audit-events/export) — ADMIN only, mirroring the backend gate. */
export const canExportAudit = (role: string | null | undefined): boolean => isAdmin(role);

/**
 * Where a signed-in user starts: the lead's day is the work list, the staff seat's the cases assigned
 * to it (#880), everyone else's the Programs overview.
 */
export const homeRouteFor = (role: string | null | undefined): "/worklist" | "/cases?view=mine" | "/programs" => {
  const r = normRole(role);
  if (r === ROLES.CASE_MANAGER) return "/worklist";
  if (r === ROLES.QUALITY_STAFF) return "/cases?view=mine";
  return "/programs";
};

/** Launch bulk outreach campaigns + view campaign history (/api/campaigns/**). */
export const canRunCampaigns = (role: string | null | undefined): boolean =>
  hasAnyRole(role, [ROLES.CASE_MANAGER, ROLES.ADMIN]);

/** View advisory order proposals (/api/orders/**). */
export const canViewOrders = (role: string | null | undefined): boolean =>
  hasAnyRole(role, [ROLES.CASE_MANAGER, ROLES.QUALITY_STAFF, ROLES.ADMIN]);

/** Author measure content: spec/CQL/tests/create (POST + PUT /api/measures/**). */
export const canAuthorMeasures = (role: string | null | undefined): boolean =>
  hasAnyRole(role, [ROLES.AUTHOR, ROLES.ADMIN]);

/** Approve / activate / deprecate measures. */
export const canApproveMeasures = (role: string | null | undefined): boolean =>
  hasAnyRole(role, [ROLES.APPROVER, ROLES.ADMIN]);

/** Studio is the authoring surface — authors edit, approvers gate releases, admin both. */
export const canUseStudio = (role: string | null | undefined): boolean =>
  hasAnyRole(role, [ROLES.AUTHOR, ROLES.APPROVER, ROLES.ADMIN]);

/** Admin console (/api/admin/**). */
export const canUseAdmin = isAdmin;

/** Segment (risk-group) management is ADMIN-only, mirroring the backend /api/segments write gate. */
export const canManageSegments = (role: string | null | undefined): boolean => isAdmin(role);

/** Identity reconcile (confirm/break a cross-system link) — CASE_MANAGER/ADMIN (mirrors the
 *  backend POST /api/identity/** gate; a wrong merge mis-joins medical records). */
export const canReconcileIdentity = (role: string | null | undefined): boolean =>
  hasAnyRole(role, [ROLES.CASE_MANAGER, ROLES.ADMIN]);

/** View the cross-system People directory (GET /api/identity/**) — CASE_MANAGER/ADMIN (the
 *  directory exposes national/MRN ids + DOB, mirroring the backend read gate). */
export const canViewPeople = (role: string | null | undefined): boolean =>
  hasAnyRole(role, [ROLES.CASE_MANAGER, ROLES.ADMIN]);
