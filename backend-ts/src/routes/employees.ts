/**
 * Employees route (#107) — the employee directory read surface behind the unchanged frontend
 * contract: the case-detail employee drawer (`/:externalId/profile`) and the worklist employee
 * search (`/search`). Both are AUTHENTICATED via the security matrix (`/api/**`).
 *
 *   GET /api/employees/search?q=&limit=     → EmployeeSearchResult[] ([] when q < 2 chars)
 *   GET /api/employees/:externalId/profile  → EmployeeProfileResponse | 404
 *   GET /api/employees/:externalId/open-cases → { openCases } | 404 (#880: the case page's other gaps)
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import { getEmployeeOpenCases, getEmployeeProfile, searchEmployees, type EmployeeProfileDeps } from "../run/employee-profile.ts";
import type { DataSourceEnv } from "../engine/ingress/data-source.ts";

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

export async function handleEmployees(req: Request, env: EmployeesEnv): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  const { pathname } = url;

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
      return open ? json(open) : json({ error: "not_found", externalId: profileId }, 404);
    }
    // Segments only here: the posture applies the roster's applicability overlay; search does not need it.
    const segments = await (await getStores(env)).segments.listSegments();
    const profile = await getEmployeeProfile({ ...(await deps(env)), segments }, profileId);
    return profile ? json(profile) : json({ error: "not_found", externalId: profileId }, 404);
  }

  return null;
}
