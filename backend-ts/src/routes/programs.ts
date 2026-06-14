/**
 * Programs route (#107 programs module) — the `/programs` dashboard read surface.
 *
 *   GET /api/programs                   overview (alias of /overview, Java parity)   → ProgramSummary[]
 *   GET /api/programs/overview          per-Active-measure KPIs + open case count    → ProgramSummary[]
 *   GET /api/programs/sites             distinct employee sites (global site filter) → string[]
 *   GET /api/programs/:id/trend         per-run compliance trend (newest 10)         → ProgramTrendPoint[]
 *   GET /api/programs/:id/top-drivers   overdue site/role + flagged-reason mix       → TopDrivers
 *
 * All honor the page's ?site=&from=&to= filters. Risk-outlook is a later slice (the page
 * degrades gracefully — empty — without it).
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { RUN_STORE_FLOOR_DDL, migrateFloorSchema } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { programOverview, programTrend, programTopDrivers, listSites, type ProgramDeps } from "../program/program-read-models.ts";

interface ProgramsEnv {
  DB: CloudDatabase;
}

const ready = new WeakSet<object>();
async function deps(env: ProgramsEnv): Promise<ProgramDeps> {
  if (!ready.has(env.DB)) {
    await env.DB.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
    await migrateFloorSchema(env.DB);
    ready.add(env.DB);
  }
  return {
    runStore: new SqliteRunStore(env.DB),
    outcomeStore: new SqliteOutcomeStore(env.DB),
    caseStore: new SqliteCaseStore(env.DB),
  };
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/**
 * Validate a `from`/`to` filter as a strict calendar date (YYYY-MM-DD), matching the Java
 * controller's parseFromDate/parseToDate (LocalDate.parse → 400 on a malformed value).
 * Blank/absent → undefined (no filter). Throws ProgramDateError on a bad value so the
 * route returns 400 instead of silently lexicographically filtering on garbage.
 */
class ProgramDateError extends Error {}
function parseDateParam(raw: string | null, field: "from" | "to"): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dt = new Date(Date.UTC(y, mo - 1, d));
    // Round-trip check rejects overflow dates (e.g. 2026-13-01, 2026-02-30) like LocalDate.parse.
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) return v;
  }
  throw new ProgramDateError(`${field} must use YYYY-MM-DD`);
}

export async function handlePrograms(req: Request, env: ProgramsEnv): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  if (req.method !== "GET") return null;

  if (pathname === "/api/programs/sites") {
    return json(listSites());
  }

  // Shared ?site=&from=&to= parsing (date filters validated like the Java controller).
  const q = url.searchParams;
  let filters: { site: string | null; from?: string; to?: string };
  try {
    filters = { site: q.get("site"), from: parseDateParam(q.get("from"), "from"), to: parseDateParam(q.get("to"), "to") };
  } catch (err) {
    if (err instanceof ProgramDateError) return json({ error: "invalid_request", message: err.message }, 400);
    throw err;
  }

  if (pathname === "/api/programs" || pathname === "/api/programs/overview") {
    return json(await programOverview(await deps(env), filters));
  }

  const trendId = pathname.match(/^\/api\/programs\/([^/]+)\/trend$/)?.[1];
  if (trendId) {
    return json(await programTrend(await deps(env), trendId, filters));
  }

  const driversId = pathname.match(/^\/api\/programs\/([^/]+)\/top-drivers$/)?.[1];
  if (driversId) {
    return json(await programTopDrivers(await deps(env), driversId, filters));
  }

  return null;
}
