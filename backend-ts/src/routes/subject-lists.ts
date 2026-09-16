/**
 * The ACO's attributed patient lists (MM-2 PR 3, ADR-082).
 *
 *   POST /api/subject-lists                import a list → 201 | 400 | 403 | 409 | 413
 *   GET  /api/subject-lists                the lists, newest first, with member counts → 200
 *   GET  /api/subject-lists/{id}           one list → 200 | 404
 *   GET  /api/subject-lists/{id}/members   paged, filterable by resolution → 200 | 400 | 404
 *   GET  /api/subject-lists/{id}/report    the measurement year's numbers → 200 | 400 | 404 | 409
 *
 * **Every method here is CASE_MANAGER/ADMIN, metadata included** (`auth/authorize.ts`). The public
 * `/sandbox` signs in as a read-only VIEWER that may browse every AUTHENTICATED GET, and on Maui the
 * clinician seat is a VIEWER too — but a member row is a raw patient identifier somebody else's
 * system asserted, and the list's very existence says which patients an ACO claims. The identity
 * routes are already restricted for exactly this reason. The frontend's RBAC is presentation; this
 * is the boundary.
 *
 * **The sandbox data boundary (ADR-082).** M-M authorises a SYNTHETIC sandbox (LOCKED §4A.1), and an
 * import route that persists arbitrary identifiers is a path for a real attribution file to reach
 * Neon, its backups and its exports before #267/#265/#264 exist. So an identifier outside this
 * deployment's own namespace refuses the WHOLE upload before anything is written, and a
 * live-directory deployment cannot import at all — the live directory is a worker-local last-known
 * registry that also fabricates profiles for `wc|` ids, so matching against it would be silently
 * incomplete rather than merely unavailable.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import { DEPLOYMENT_PROFILE, employees, isRunnableMeasure } from "../config/deployment-profile.ts";
import { isWebChartConfigured, type DataSourceEnv } from "../engine/ingress/data-source.ts";
import {
  MAX_IMPORT_BYTES,
  countMembers,
  countOutsideSandboxNamespace,
  parseIdentifierArray,
  parseIdentifierText,
  payerBreakdown,
  resolveMembers,
  sandboxIdentifierPattern,
  type ParseResult,
} from "../compliance/subject-list-import.ts";
import {
  SubjectListRevisionConflictError,
  type SubjectListResolution,
} from "../stores/subject-list-store.ts";
import { subjectListReport } from "../compliance/subject-list-report.ts";
import { subjectListReportCsv } from "../compliance/subject-list-report-csv.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";
import { isOfficialRouted } from "../wiring/official-routing.ts";

export interface SubjectListsEnv extends DataSourceEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const RESOLUTIONS: readonly SubjectListResolution[] = ["MATCHED", "NOT_FOUND", "AMBIGUOUS"];
const MEMBERS_PAGE_MAX = 500;

export async function handleSubjectLists(
  req: Request,
  env: SubjectListsEnv,
  actor = "system",
): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/subject-lists")) return null;

  if (url.pathname === "/api/subject-lists") {
    if (req.method === "POST") return importList(req, env, actor);
    if (req.method === "GET") return listLists(env);
    return null;
  }

  const one = url.pathname.match(/^\/api\/subject-lists\/([^/]+)$/)?.[1];
  if (one && req.method === "GET") return getOne(env, decodeURIComponent(one));

  const members = url.pathname.match(/^\/api\/subject-lists\/([^/]+)\/members$/)?.[1];
  if (members && req.method === "GET") return getMembers(env, decodeURIComponent(members), url.searchParams);

  const report = url.pathname.match(/^\/api\/subject-lists\/([^/]+)\/report$/)?.[1];
  if (report && req.method === "GET") return getReport(env, decodeURIComponent(report), url.searchParams, actor);

  return null;
}

async function getReport(
  env: SubjectListsEnv,
  id: string,
  params: URLSearchParams,
  actor: string,
): Promise<Response> {
  // REQUIRED, with no default (ADR-082). An officially routed run is scored over the calendar year
  // containing its evaluation date (ADR-072), so "the latest numbers" in January 2028 would answer a
  // PY2027 question with next year's partial data — and it would look exactly like a correct answer.
  const rawYear = params.get("measurementYear")?.trim() ?? "";
  const measurementYear = Number(rawYear);
  if (!/^\d{4}$/.test(rawYear) || !Number.isInteger(measurementYear)) {
    return json(
      {
        error: "invalid_request",
        parameter: "measurementYear",
        message: "measurementYear is required and must be a four-digit year; there is no default",
      },
      400,
    );
  }
  const format = params.get("format")?.trim().toLowerCase() ?? "";
  if (format && format !== "csv") {
    return json({ error: "invalid_request", parameter: "format", message: "format must be csv, or omitted for JSON" }, 400);
  }

  const stores = await getStores(env);
  // Runnable AND official-routed: an authored measure's membership is status-derived rather than
  // population-based, so there is no numerator to report for one.
  const measureIds = MEASURE_CATALOG
    .filter((m) => m.status === "Active" && isRunnableMeasure(m.id) && isOfficialRouted(m.id))
    .map((m) => m.id);

  const result = await subjectListReport(
    { lists: stores.subjectLists, outcomes: stores.outcomes, runs: stores.runs, events: stores.events },
    id,
    measurementYear,
    measureIds,
  );
  if (!result.ok) return json(result.body, result.status);
  const { report } = result;

  // A patient-level clinical read, audited like COMPLIANCE_API_READ. The payload names the list, the
  // revision and the runs — what a later question ("where did March's numbers come from?") needs —
  // and no identifier.
  await stores.events.appendAudit({
    eventType: "SUBJECT_LIST_REPORT_READ",
    entityType: "subject_list",
    entityId: report.list.id,
    actor,
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: null,
    payload: {
      revision: report.list.revision,
      measurementYear,
      format: format === "csv" ? "csv" : "json",
      runIds: report.measures.map((m) => m.runId).filter((r): r is string => r !== null),
      compactedMeasures: report.compactedMeasures,
      members: report.members,
      rows: report.rows.length,
    },
  });

  if (format === "csv") {
    const byExternalId = new Map(employees().map((e) => [e.externalId, e]));
    const csv = subjectListReportCsv(report, (externalId) => byExternalId.get(externalId) ?? null);
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv",
        "content-disposition": `attachment; filename="subject-list-report-${measurementYear}.csv"`,
        // Exposed through config/cors.ts so a browser client can actually read it.
        "x-workwell-compacted-measures": report.compactedMeasures.join(","),
      },
    });
  }
  // The ROWS are the CSV's job; the JSON is the summary a screen renders.
  const { rows: _rows, ...summary } = report;
  return json(summary);
}

async function importList(req: Request, env: SubjectListsEnv, actor: string): Promise<Response> {
  // The deployment gate comes FIRST, before the body is even read: on a live-directory deployment
  // there is no resolver this route could trust, and reading a 2 MB body to then refuse it would
  // still have brought the identifiers into the process.
  if (isWebChartConfigured(env)) {
    return json(
      {
        error: "not_enabled_on_this_deployment",
        message:
          "attributed-list import is available on a synthetic-directory deployment only; a live-directory deployment needs the PHI-phase authoritative subject resolver",
      },
      403,
    );
  }

  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  const isText = contentType.startsWith("text/plain");

  const raw = await req.text();
  // Byte length, not character count: a 2 MB cap that measured UTF-16 units would admit a larger
  // payload than it names for any file with non-ASCII in it.
  if (new TextEncoder().encode(raw).length > MAX_IMPORT_BYTES) {
    return json(
      { error: "payload_too_large", message: `the upload must be at most ${MAX_IMPORT_BYTES} bytes` },
      413,
    );
  }

  let name = "";
  let source: string | null = null;
  let note: string | null = null;
  let parsed: ParseResult;

  if (isText) {
    // The metadata travels in the query string for the text form, because the body IS the list.
    const params = new URL(req.url).searchParams;
    name = (params.get("name") ?? "").trim();
    source = params.get("source")?.trim() || null;
    note = params.get("note")?.trim() || null;
    parsed = parseIdentifierText(raw);
  } else {
    let body: unknown;
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      return json({ error: "invalid_request", message: "a JSON body or text/plain identifiers are required" }, 400);
    }
    const b = (body ?? {}) as Record<string, unknown>;
    name = String(b.name ?? "").trim();
    source = String(b.source ?? "").trim() || null;
    note = String(b.note ?? "").trim() || null;
    parsed = parseIdentifierArray(b.identifiers);
  }

  if (!name) {
    return json({ error: "invalid_request", parameter: "name", message: "name is required" }, 400);
  }
  if (!parsed.ok) return json(parsed.failure, parsed.failure.error === "payload_too_large" ? 413 : 400);

  const outside = countOutsideSandboxNamespace(
    parsed.value.identifiers,
    sandboxIdentifierPattern(DEPLOYMENT_PROFILE.id),
  );
  if (outside > 0) {
    // The COUNT, never the values. Refusing exists so the identifiers are not persisted, and an error
    // body is logged and kept by the browser — echoing them back would persist them by another route.
    return json(
      {
        error: "identifier_outside_sandbox_namespace",
        outsideNamespace: outside,
        total: parsed.value.identifiers.length,
        message:
          "this deployment is a synthetic sandbox; every identifier must belong to its generated directory's namespace, and nothing was written",
      },
      400,
    );
  }

  // The ENUMERATED directory members, never `employeeById` — the live directory fabricates a minimal
  // profile for any `wc|` string, so a resolver built on it would auto-match identifiers that exist
  // nowhere. (Unreachable here because the gate above already refused a live deployment; stated in
  // code because the gate and the resolver are two different decisions and only one of them is here.)
  const roster = employees();
  const byExternalId = new Map(roster.map((e) => [e.externalId, e]));
  const members = resolveMembers(parsed.value.identifiers, (raw2) => byExternalId.get(raw2)?.externalId ?? null);
  const counts = countMembers(members, parsed.value.duplicatesDropped);
  const payers = payerBreakdown(members, (subjectId) => byExternalId.get(subjectId)?.payer);

  const stores = await getStores(env);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  try {
    const list = await stores.subjectLists.createList({
      id,
      name,
      source,
      note,
      createdBy: actor,
      now,
      members,
      // Audited BEFORE the list becomes visible. The payload carries counts and provenance and NO
      // identifier: the ledger records that an import happened and what it found, and a patient
      // identifier in an audit payload would put the very data the namespace gate refuses into a
      // table that is exported wholesale.
      beforeComplete: async (header) => {
        await stores.events.appendAudit({
          eventType: "SUBJECT_LIST_IMPORTED",
          entityType: "subject_list",
          entityId: header.id,
          actor,
          refRunId: null,
          refCaseId: null,
          refMeasureVersionId: null,
          payload: {
            name: header.name,
            revision: header.revision,
            format: isText ? "text/plain" : "application/json",
            ...(source ? { source } : {}),
            counts,
            payerBreakdown: payers,
          },
        });
      },
    });
    return json({ list, counts, payerBreakdown: payers }, 201);
  } catch (err) {
    if (err instanceof SubjectListRevisionConflictError) {
      // "Your import lost a race" and "your database is broken" must not look the same to somebody who
      // just uploaded a 50,000-line file, so the conflict names the revision that won.
      return json(
        {
          error: "list_revision_conflict",
          name,
          existingRevision: err.existingRevision,
          message: `another import of "${name}" is in flight; retry to take the next revision`,
        },
        409,
      );
    }
    throw err;
  }
}

async function listLists(env: SubjectListsEnv): Promise<Response> {
  const stores = await getStores(env);
  const lists = await stores.subjectLists.listLists();
  // One grouped statement for every row's counts, rather than one read per list: the picker shows
  // matched/not-found beside each name, and a per-row read is the shape #560 removed from the export.
  const counts = await stores.subjectLists.countMembers(lists.map((l) => l.id));
  return json(
    lists.map((list) => ({
      ...list,
      counts: counts.get(list.id) ?? { MATCHED: 0, NOT_FOUND: 0, AMBIGUOUS: 0 },
    })),
  );
}

async function getOne(env: SubjectListsEnv, id: string): Promise<Response> {
  const stores = await getStores(env);
  const list = await stores.subjectLists.getList(id);
  if (!list) return json({ error: "not_found", listId: id }, 404);
  const counts = await stores.subjectLists.countMembers([id]);
  return json({ ...list, counts: counts.get(id) ?? { MATCHED: 0, NOT_FOUND: 0, AMBIGUOUS: 0 } });
}

async function getMembers(env: SubjectListsEnv, id: string, params: URLSearchParams): Promise<Response> {
  const rawResolution = params.get("resolution")?.trim().toUpperCase() ?? "";
  if (rawResolution && !RESOLUTIONS.includes(rawResolution as SubjectListResolution)) {
    // Refused rather than ignored, the rule `subject-filters.ts` states: a members table that silently
    // dropped the filter would show the whole list under a heading that says "not found".
    return json(
      {
        error: "invalid_request",
        parameter: "resolution",
        message: `resolution must be one of ${RESOLUTIONS.join(", ")}; received "${rawResolution}"`,
      },
      400,
    );
  }
  const limit = Math.min(Math.max(Number(params.get("limit") ?? 50) || 50, 1), MEMBERS_PAGE_MAX);
  const offset = Math.max(Number(params.get("offset") ?? 0) || 0, 0);

  const stores = await getStores(env);
  // Resource first: an unknown list is a 404 whatever the paging says, so a bad page size can never
  // turn "no such list" into "an empty list".
  const list = await stores.subjectLists.getList(id);
  if (!list) return json({ error: "not_found", listId: id }, 404);

  const page = await stores.subjectLists.listMembers(id, {
    ...(rawResolution ? { resolution: rawResolution as SubjectListResolution } : {}),
    limit,
    offset,
  });
  const byExternalId = new Map(employees().map((e) => [e.externalId, e]));
  return new Response(
    JSON.stringify(
      page.members.map((m) => {
        const profile = m.subjectId ? byExternalId.get(m.subjectId) : undefined;
        return {
          ...m,
          // Resolved at read time from the directory, never stored on the member row: a name is a
          // directory fact that changes, and a copy here would be a second place it could be wrong.
          subjectName: profile?.name ?? null,
          providerId: profile?.providerId ?? null,
          payer: profile?.payer ?? null,
        };
      }),
    ),
    {
      status: 200,
      headers: { "content-type": "application/json", "x-total-count": String(page.total) },
    },
  );
}
