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
import { listNotFoundBody, withListFilter } from "../compliance/subject-list-filter.ts";
import { worklistQueryFor } from "../case/worklist-read-model.ts";
import { rosterCellCache } from "../compliance/roster-read-model.ts";
import { runsCsv, outcomesCsvStream, casesCsv, auditCsvStream } from "../export/export-csv.ts";
import { subjectFiltersFromQuery, subjectFilterErrorBody, SubjectFilterError } from "../compliance/subject-filters.ts";
import type { DataSourceEnv } from "../engine/ingress/data-source.ts";

interface ExportsEnv extends DataSourceEnv {
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

/**
 * The panel filters, or the 400 an unrecognised token earns. A CSV under a filter that was silently
 * dropped is the worst version of that failure — it leaves the application and gets forwarded.
 */
function subjectFiltersOr400(q: URLSearchParams): ReturnType<typeof subjectFiltersFromQuery> | Response {
  try {
    return subjectFiltersFromQuery(q);
  } catch (error) {
    if (error instanceof SubjectFilterError) {
      return new Response(JSON.stringify(subjectFilterErrorBody(error)), { status: 400, headers: { "content-type": "application/json" } });
    }
    throw error;
  }
}

/** The 404 an unknown `?listId=` earns, in the same JSON shape every other surface uses. */
const listNotFound = (listId: string): Response =>
  new Response(JSON.stringify(listNotFoundBody(listId)), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

/**
 * The status token this export understands, through the ONE parser the work list and the MCP tool
 * share.
 *
 * **"open" is `ACTIVE_CASE_STATUSES`, not `["OPEN"]`.** This export is reached from the work list's
 * own "Export" button with the status it is currently showing, so the two must agree about what is
 * open. While this said `["OPEN"]` and the list said OPEN + IN_PROGRESS, scheduling an appointment
 * moved a case to IN_PROGRESS and it stayed on screen but vanished from the CSV taken off that
 * screen — a row missing from an export nobody can see is missing, which is the worse half of the
 * two failures this codebase names. Sharing the parser is what keeps that agreement from drifting
 * again.
 *
 * THIS caller's default is made explicit: the cases CSV applies no status filter by contract
 * (§6.3 — every row, 32,558 on the pilot), where the work list's blank token means the ACTIVE set,
 * so a shared switch that assumed either default would silently change the other caller's answer.
 * `staff_closed` on the CSV means ALL history: the export has no period logic, and §6.3 lists no
 * period filter.
 */
const caseStatusQuery = (raw: string | null) => worklistQueryFor(raw, { blank: "all" });

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
    const parsed = subjectFiltersOr400(q);
    if (parsed instanceof Response) return parsed;
    const s = await getStores(env);
    // A CSV under a list that does not exist is the worst version of the silent-filter failure: it
    // leaves the application and gets forwarded, so an unknown list is a 404 rather than everybody.
    const listedOutcomes = await withListFilter(s.subjectLists, q, parsed);
    if (!listedOutcomes.ok) return listNotFound(listedOutcomes.listId);
    const subjectFilters = listedOutcomes.filters;
    // Streamed + paged (Fable H4) — bounded memory so a seed:scale run's 120k outcomes never
    // materialize at once (parity with the audit-events streaming export below).
    const stream = outcomesCsvStream(s.outcomes, s.runs, q.get("runId") ?? undefined, env, {
      site: q.get("site")?.trim() || undefined,
      ...subjectFilters,
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/csv", "content-disposition": `attachment; filename="outcomes.csv"` },
    });
  }

  if (pathname === "/api/exports/cases") {
    if (!isCsv) return badFormat();
    const parsed = subjectFiltersOr400(q);
    if (parsed instanceof Response) return parsed;
    const s = await getStores(env);
    const listedCases = await withListFilter(s.subjectLists, q, parsed);
    if (!listedCases.ok) return listNotFound(listedCases.listId);
    const subjectFilters = listedCases.filters;
    const caseIds = q.get("caseIds")?.split(",").map((c) => c.trim()).filter(Boolean);
    const csv = await casesCsv(s.cases, s.events, {
      ...caseStatusQuery(q.get("status")),
      measureId: q.get("measureId") ?? undefined,
      priority: q.get("priority") ?? undefined,
      assignee: q.get("assignee") ?? undefined,
      site: q.get("site")?.trim() || undefined,
      caseIds: caseIds?.length ? caseIds : undefined,
      ...subjectFilters,
    }, env, { outcomeStore: s.outcomes, cellCache: rosterCellCache });
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
