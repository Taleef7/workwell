/**
 * The patient-first work list and the bulk assign it drives (MM-2).
 *
 *   GET  /api/worklist/patients   one row per patient, every open gap on it → 200 WorklistPatientRow[]
 *   POST /api/cases/bulk-assign   assign/clear many cases in one call       → 200 | 400
 *
 * Both read through `case/worklist-read-model.ts`, the same pipeline `/api/cases` uses, so the
 * gap-centric list and the patient-centric one cannot disagree about who is being worked.
 */
import { getStores } from "../stores/factory.ts";
import type { CloudDatabase, CloudBucket } from "@mieweb/cloud";
import { loadWorklistCases } from "../case/worklist-read-model.ts";
import { groupIntoPatients } from "../case/worklist-patients.ts";
import { employeeById, employees, providerById, profileSubjectMatcher, DIRECTORY } from "../config/deployment-profile.ts";
import { isWebChartConfigured, type DataSourceEnv } from "../engine/ingress/data-source.ts";
import { profileForId } from "../engine/ingress/webchart/live-directory.ts";
import {
  subjectFiltersFromQuery, subjectFilterErrorBody, SubjectFilterError,
} from "../compliance/subject-filters.ts";
import { resolveAssignable, assignableUsers } from "../auth/demo-users.ts";
import { ACTIVE_CASE_STATUSES } from "../case/case-logic.ts";

export interface WorklistEnv extends DataSourceEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
  BUCKET?: CloudBucket;
}

const json = (data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...extraHeaders } });

/** The cap on one bulk call. Above this the UI must page; below it the worker deadline is safe. */
export const BULK_ASSIGN_MAX = 500;

export async function handleWorklist(req: Request, env: WorklistEnv, actor = "system"): Promise<Response | null> {
  const url = new URL(req.url);

  if (req.method === "POST" && url.pathname === "/api/cases/bulk-assign") return bulkAssign(req, env, actor);
  if (req.method !== "GET" || url.pathname !== "/api/worklist/patients") return null;

  const q = url.searchParams;
  const limit = Math.min(500, Math.max(1, Number(q.get("limit") ?? "50") || 50));
  const offset = Math.max(0, Number(q.get("offset") ?? "0") || 0);

  let subjectFilters;
  try {
    subjectFilters = subjectFiltersFromQuery(q);
  } catch (error) {
    if (error instanceof SubjectFilterError) return json(subjectFilterErrorBody(error), 400);
    throw error;
  }

  const employeeLookup = isWebChartConfigured(env)
    ? (externalId: string) => employeeById(externalId) ?? profileForId(externalId, DIRECTORY)
    : employeeById;

  const stores = await getStores(env);
  const summaries = await loadWorklistCases(
    {
      cases: stores.cases,
      events: stores.events,
      employeeLookup,
      providerLookup: providerById,
      // Withheld where the directory is not the complete set of subjects a case can name — see the
      // read model's header. Omitting it is always correct, only slower.
      roster: isWebChartConfigured(env) ? undefined : employees,
      // This list shows gaps, not the outreach badge, so it does not pay for the grouped count query.
      withOutreachCounts: false,
      profileMatch: profileSubjectMatcher(employeeLookup),
    },
    {
      status: q.get("status"),
      measureId: q.get("measureId") ?? undefined,
      site: q.get("site")?.trim() || undefined,
      outcome: q.get("outcome")?.trim().toUpperCase().replace(/[\s-]+/g, "_") || undefined,
      search: q.get("search")?.trim().toLowerCase() || undefined,
      subjects: subjectFilters,
      // NOT forwarded as a case filter: the assignee question is answered per PATIENT below, because a
      // patient with one gap assigned to me still has three others I should see on the same call.
    },
  );

  const rows = groupIntoPatients(summaries, { assignee: q.get("assignee"), viewerEmail: actor });
  // X-Total-Count is the PATIENT count, which is what this list pages. Reporting the case count here
  // would tell a client to page past the end of a shorter list.
  return json(rows.slice(offset, offset + limit), 200, { "X-Total-Count": String(rows.length) });
}

/**
 * Assign or clear many cases in one call.
 *
 * **Set-based, and audited before it mutates.** The events are written for exactly the rows that will
 * change — computed from a single bulk read under the same conditions the UPDATE applies — so a
 * failure can only ever leave a recorded-but-unapplied action, never an unaudited state change. That
 * is the ordering `case-actions.ts` established and the hard rule in CLAUDE.md requires.
 *
 * **An unchanged row writes NO event.** Re-assigning a case to the person it is already assigned to is
 * not a state change, and a ledger full of those makes the ones that matter harder to find.
 */
async function bulkAssign(req: Request, env: WorklistEnv, actor: string): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_request", message: "a JSON body is required" }, 400);
  }
  const input = (body ?? {}) as { assignee?: unknown; caseIds?: unknown };

  if (!Array.isArray(input.caseIds)) {
    return json({ error: "invalid_request", parameter: "caseIds", message: "caseIds must be an array of case ids" }, 400);
  }
  // De-duplicated BEFORE the cap, so asking for the same case twice is not counted against the limit
  // and cannot report one case as two assignments.
  const ids = [...new Set(input.caseIds.map((id) => String(id).trim()).filter(Boolean))];
  if (ids.length === 0) {
    return json({ error: "invalid_request", parameter: "caseIds", message: "caseIds must contain at least one id" }, 400);
  }
  if (ids.length > BULK_ASSIGN_MAX) {
    return json(
      { error: "invalid_request", parameter: "caseIds", message: `caseIds must contain at most ${BULK_ASSIGN_MAX} ids; received ${ids.length}` },
      400,
    );
  }

  // The same validation the single-case assign uses, against the same list `/api/users/assignable`
  // offers the UI — so the offer and the check cannot drift, and a mistyped address cannot park
  // hundreds of cases on an account nobody signs in as.
  const raw = input.assignee === null || input.assignee === undefined ? "" : String(input.assignee).trim();
  let assignee: string | null = null;
  if (raw) {
    const resolved = resolveAssignable(raw);
    if (!resolved) {
      return json(
        {
          error: "invalid_request",
          parameter: "assignee",
          message: `assignee must be one of: ${assignableUsers().map((u) => u.email).join(", ")}`,
        },
        400,
      );
    }
    assignee = resolved;
  }

  const stores = await getStores(env);
  const existing = await stores.cases.getCases(ids);
  const byId = new Map(existing.map((c) => [c.id, c]));
  const missing = ids.filter((id) => !byId.has(id));
  const active = new Set<string>(ACTIVE_CASE_STATUSES);
  const closed = existing.filter((c) => !active.has(c.status)).map((c) => c.id);
  // Exactly the rows the UPDATE will move: active, and actually changing owner.
  const changing = existing.filter((c) => active.has(c.status) && (c.assignee ?? null) !== assignee);

  if (changing.length > 0) {
    await stores.events.appendAudits(
      changing.map((c) => ({
        eventType: "CASE_ASSIGNED",
        entityType: "case",
        entityId: c.id,
        actor,
        refRunId: c.lastRunId,
        refCaseId: c.id,
        refMeasureVersionId: c.measureId,
        // The same payload shape the single-case path writes, so one timeline renders both.
        payload: { assignee: assignee ?? "unassigned", previousAssignee: c.assignee ?? "unassigned", bulk: true },
      })),
    );
  }

  const assigned = await stores.cases.assignCases(changing.map((c) => c.id), assignee);
  return json({
    assigned: assigned.length,
    // Everything asked for that did not move: already on this assignee, closed, or unknown.
    unchanged: ids.length - assigned.length,
    missing,
    closed,
  });
}
