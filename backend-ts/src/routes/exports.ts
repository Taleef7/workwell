/**
 * Exports route (#108) — CSV downloads matching the Java ExportController/AuditController.
 *
 *   GET /api/exports/runs?format=csv
 *   GET /api/exports/outcomes?format=csv&runId={optional}
 *   GET /api/exports/cases?format=csv  (status/measureId/priority/assignee/site filters)
 *   GET /api/audit-events/export?format=csv
 *
 * Non-csv `format` → 400 "Unsupported format. Use format=csv." (Java parity). Responses are
 * `text/csv` with `Content-Disposition: attachment`. Reads from the existing stores — no new data.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { RUN_STORE_FLOOR_DDL, migrateFloorSchema } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { runsCsv, outcomesCsv, casesCsv, auditCsv } from "../export/export-csv.ts";

interface ExportsEnv {
  DB: CloudDatabase;
}

const ready = new WeakSet<object>();
async function ensure(env: ExportsEnv): Promise<void> {
  if (!ready.has(env.DB)) {
    await env.DB.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
    await migrateFloorSchema(env.DB);
    ready.add(env.DB);
  }
}

const csvResponse = (filename: string, csv: string): Response =>
  new Response(csv, {
    status: 200,
    headers: { "content-type": "text/csv", "content-disposition": `attachment; filename="${filename}"` },
  });
const badFormat = (): Response =>
  new Response("Unsupported format. Use format=csv.", { status: 400, headers: { "content-type": "text/plain" } });

/** Statuses mapping mirrors the cases worklist: blank/"open"→OPEN, "all"→all, else the literal. */
function caseStatuses(raw: string | null): string[] | undefined {
  switch ((raw ?? "").toLowerCase()) {
    case "":
    case "all":
      return undefined;
    case "open":
      return ["OPEN"];
    case "closed":
      return ["RESOLVED", "CLOSED"];
    case "excluded":
      return ["EXCLUDED"];
    default:
      return [(raw as string).toUpperCase()];
  }
}

export async function handleExports(req: Request, env: ExportsEnv): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  if (req.method !== "GET") return null;
  const q = url.searchParams;
  const isCsv = (q.get("format") ?? "csv").toLowerCase() === "csv";

  if (pathname === "/api/exports/runs") {
    if (!isCsv) return badFormat();
    await ensure(env);
    return csvResponse("runs.csv", await runsCsv(new SqliteRunStore(env.DB), new SqliteOutcomeStore(env.DB)));
  }

  if (pathname === "/api/exports/outcomes") {
    if (!isCsv) return badFormat();
    await ensure(env);
    return csvResponse(
      "outcomes.csv",
      await outcomesCsv(new SqliteOutcomeStore(env.DB), new SqliteRunStore(env.DB), q.get("runId") ?? undefined),
    );
  }

  if (pathname === "/api/exports/cases") {
    if (!isCsv) return badFormat();
    await ensure(env);
    const caseIds = q.get("caseIds")?.split(",").map((s) => s.trim()).filter(Boolean);
    const csv = await casesCsv(new SqliteCaseStore(env.DB), new SqliteCaseEventStore(env.DB), {
      statuses: caseStatuses(q.get("status")),
      measureId: q.get("measureId") ?? undefined,
      priority: q.get("priority") ?? undefined,
      assignee: q.get("assignee") ?? undefined,
      site: q.get("site")?.trim() || undefined,
      caseIds: caseIds?.length ? caseIds : undefined,
    });
    return csvResponse("cases.csv", csv);
  }

  if (pathname === "/api/audit-events/export") {
    if (!isCsv) return badFormat();
    await ensure(env);
    return csvResponse("audit-events.csv", await auditCsv(new SqliteCaseEventStore(env.DB), new SqliteCaseStore(env.DB)));
  }

  return null;
}
