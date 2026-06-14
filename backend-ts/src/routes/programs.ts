/**
 * Programs route (#107 programs module) — the `/programs` dashboard read surface.
 *
 *   GET /api/programs            program overview (alias of /overview, Java parity) → ProgramSummary[]
 *   GET /api/programs/overview   per-Active-measure KPIs + open case count          → ProgramSummary[]
 *   GET /api/programs/sites      distinct employee sites (the global site filter)    → string[]
 *
 * All three honor the page's ?site=&from=&to= filters. Per-measure trend, top-drivers,
 * and risk-outlook are later slices (the page degrades gracefully — empty — without them).
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { RUN_STORE_FLOOR_DDL, migrateFloorSchema } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { programOverview, listSites, type ProgramDeps } from "../program/program-read-models.ts";

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

export async function handlePrograms(req: Request, env: ProgramsEnv): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  if (req.method !== "GET") return null;

  if (pathname === "/api/programs/sites") {
    return json(listSites());
  }

  if (pathname === "/api/programs" || pathname === "/api/programs/overview") {
    const q = url.searchParams;
    const overview = await programOverview(await deps(env), {
      site: q.get("site"),
      from: q.get("from"),
      to: q.get("to"),
    });
    return json(overview);
  }

  return null;
}
