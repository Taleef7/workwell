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
 *   ROLE_CASE_MANAGER   — case ops, runs, campaigns, orders, evidence
 *   ROLE_AUTHOR         — measure authoring (spec/CQL/tests, create)
 *   ROLE_APPROVER       — measure approve/activate/deprecate, MAT export
 *   ROLE_VIEWER         — read-only
 */

export const ROLES = {
  ADMIN: "ROLE_ADMIN",
  CASE_MANAGER: "ROLE_CASE_MANAGER",
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

/** Work cases: assign/escalate/outreach/rerun (POST /api/cases/**). */
export const canManageCases = (role: string | null | undefined): boolean =>
  hasAnyRole(role, [ROLES.CASE_MANAGER, ROLES.ADMIN]);

/** Launch bulk outreach campaigns + view campaign history (/api/campaigns/**). */
export const canRunCampaigns = (role: string | null | undefined): boolean =>
  hasAnyRole(role, [ROLES.CASE_MANAGER, ROLES.ADMIN]);

/** View advisory order proposals (/api/orders/**). */
export const canViewOrders = (role: string | null | undefined): boolean =>
  hasAnyRole(role, [ROLES.CASE_MANAGER, ROLES.ADMIN]);

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
