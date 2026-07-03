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
import { getStores } from "../stores/factory.ts";
import { runsCsv, outcomesCsvStream, casesCsv, auditCsvStream } from "../export/export-csv.ts";

interface ExportsEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
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
    const s = await getStores(env);
    return csvResponse("runs.csv", await runsCsv(s.runs, s.outcomes));
  }

  if (pathname === "/api/exports/outcomes") {
    if (!isCsv) return badFormat();
    const s = await getStores(env);
    // Streamed + paged (Fable H4) — bounded memory so a seed:scale run's 120k outcomes never
    // materialize at once (parity with the audit-events streaming export below).
    const stream = outcomesCsvStream(s.outcomes, s.runs, q.get("runId") ?? undefined);
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/csv", "content-disposition": `attachment; filename="outcomes.csv"` },
    });
  }

  if (pathname === "/api/exports/cases") {
    if (!isCsv) return badFormat();
    const s = await getStores(env);
    const caseIds = q.get("caseIds")?.split(",").map((c) => c.trim()).filter(Boolean);
    const csv = await casesCsv(s.cases, s.events, {
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
    const s = await getStores(env);
    // #150 M9: stream the ledger in pages instead of building the whole CSV string first — bounded
    // memory regardless of audit-trail size (parity with the Java StreamingResponseBody export).
    const stream = auditCsvStream(s.events, s.cases);
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/csv", "content-disposition": `attachment; filename="audit-events.csv"` },
    });
  }

  return null;
}
