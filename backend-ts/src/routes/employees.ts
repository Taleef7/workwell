/**
 * Employees route (#107) — the employee directory read surface behind the unchanged frontend
 * contract: the case-detail employee drawer (`/:externalId/profile`) and the worklist employee
 * search (`/search`). Both are AUTHENTICATED via the security matrix (`/api/**`).
 *
 *   GET /api/employees/search?q=&limit=     → EmployeeSearchResult[] ([] when q < 2 chars)
 *   GET /api/employees/:externalId/profile  → EmployeeProfileResponse | 404
 *   GET /api/employees/:externalId/open-cases → { openCases, contactPreference } | 404 (#880: the case page's other gaps)
 *   PUT    /api/employees/:externalId/contact-preference { preferredChannel, declinedChannels } → { contactPreference } (#886)
 *   DELETE /api/employees/:externalId/contact-preference → { contactPreference: null } (#886)
 *
 * The profile and open-cases answers carry `contactPreference` (null when none is recorded). The writes are
 * CASE_MANAGER, QUALITY_STAFF and ADMIN (`authorize.ts`), audit-first (`case/contact-preference.ts`).
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import { getEmployeeOpenCases, getEmployeeProfile, searchEmployees, type EmployeeProfileDeps } from "../run/employee-profile.ts";
import type { DataSourceEnv } from "../engine/ingress/data-source.ts";
import {
  clearContactPreference,
  parsePreferenceBody,
  setContactPreference,
  ContactPreferenceError,
} from "../case/contact-preference.ts";

interface EmployeesEnv extends DataSourceEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function deps(env: EmployeesEnv): Promise<EmployeeProfileDeps> {
  const s = await getStores(env);
  return { outcomes: s.outcomes, cases: s.cases, events: s.events, webChartEnv: env };
}

/** PUT/DELETE /api/employees/:externalId/contact-preference (#886). A subject outside the directory is 404. */
async function contactPreference(req: Request, env: EmployeesEnv, rawId: string, actor: string): Promise<Response> {
  let subjectId: string;
  try {
    subjectId = decodeURIComponent(rawId);
  } catch {
    return json({ error: "not_found", externalId: rawId }, 404);
  }
  // The same directory gate as the profile: a preference is only ever set on someone this deployment knows.
  if (!(await getEmployeeOpenCases(await deps(env), subjectId))) return json({ error: "not_found", externalId: subjectId }, 404);
  const s = await getStores(env);
  const prefDeps = { contactPreferences: s.contactPreferences, events: s.events };
  try {
    if (req.method === "DELETE") {
      await clearContactPreference(prefDeps, subjectId, actor);
      return json({ contactPreference: null });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_request", message: "a JSON body is required" }, 400);
    }
    const parsed = parsePreferenceBody(body);
    return json({ contactPreference: await setContactPreference(prefDeps, { subjectId, ...parsed, actor }) });
  } catch (err) {
    if (err instanceof ContactPreferenceError) return json({ error: err.code, message: err.message }, err.status);
    throw err;
  }
}

export async function handleEmployees(req: Request, env: EmployeesEnv, actor = "system"): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  const prefMatch = pathname.match(/^\/api\/employees\/([^/]+)\/contact-preference$/);
  if (prefMatch && (req.method === "PUT" || req.method === "DELETE")) return contactPreference(req, env, prefMatch[1]!, actor);
  if (req.method !== "GET") return null;

  if (pathname === "/api/employees/search") {
    const q = url.searchParams.get("q") ?? "";
    const limit = Number(url.searchParams.get("limit") ?? "10") || 10;
    return json(await searchEmployees(await deps(env), q, limit));
  }

  const match = pathname.match(/^\/api\/employees\/([^/]+)\/(profile|open-cases)$/);
  if (match) {
    const rawId = match[1]!;
    const view = match[2];
    let profileId: string;
    try {
      profileId = decodeURIComponent(rawId); // live wc| ids arrive %7C-encoded from the browser
    } catch {
      return json({ error: "not_found", externalId: rawId }, 404); // malformed %-encoding → unknown id
    }
    if (view === "open-cases") {
      const open = await getEmployeeOpenCases(await deps(env), profileId);
      if (!open) return json({ error: "not_found", externalId: profileId }, 404);
      return json({ ...open, contactPreference: await (await getStores(env)).contactPreferences.get(profileId) });
    }
    // Segments only here: the posture applies the roster's applicability overlay; search does not need it.
    const segments = await (await getStores(env)).segments.listSegments();
    const profile = await getEmployeeProfile({ ...(await deps(env)), segments }, profileId);
    if (!profile) return json({ error: "not_found", externalId: profileId }, 404);
    return json({ ...profile, contactPreference: await (await getStores(env)).contactPreferences.get(profileId) });
  }

  return null;
}
