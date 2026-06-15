/**
 * Employees route (#107) — the employee directory read surface behind the unchanged frontend
 * contract: the case-detail employee drawer (`/:externalId/profile`) and the worklist employee
 * search (`/search`). Both are AUTHENTICATED via the security matrix (`/api/**`).
 *
 *   GET /api/employees/search?q=&limit=     → EmployeeSearchResult[] ([] when q < 2 chars)
 *   GET /api/employees/:externalId/profile  → EmployeeProfileResponse | 404
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { RUN_STORE_FLOOR_DDL, migrateFloorSchema } from "../stores/sqlite/schema.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { getEmployeeProfile, searchEmployees, type EmployeeProfileDeps } from "../run/employee-profile.ts";

interface EmployeesEnv {
  DB: CloudDatabase;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const ready = new WeakSet<object>();
async function deps(env: EmployeesEnv): Promise<EmployeeProfileDeps> {
  if (!ready.has(env.DB)) {
    await env.DB.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
    await migrateFloorSchema(env.DB);
    ready.add(env.DB);
  }
  return { outcomes: new SqliteOutcomeStore(env.DB), cases: new SqliteCaseStore(env.DB), events: new SqliteCaseEventStore(env.DB) };
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

  const profileId = pathname.match(/^\/api\/employees\/([^/]+)\/profile$/)?.[1];
  if (profileId) {
    const profile = await getEmployeeProfile(await deps(env), profileId);
    return profile ? json(profile) : json({ error: "not_found", externalId: profileId }, 404);
  }

  return null;
}
