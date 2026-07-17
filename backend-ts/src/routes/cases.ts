/**
 * Cases route (#107 cases module) — the worklist read behind the unchanged frontend
 * contract (`CaseSummary[]`). Cases are upserted from run outcomes (run pipeline);
 * this serves the worklist with the page's status/measure/priority/assignee/site/
 * search filters + limit/offset paging.
 *
 *   GET  /api/cases             newest-first case summaries (filtered) → 200 CaseSummary[]
 *   GET  /api/cases/:id         case detail + evidence/why_flagged + timeline → 200 | 404
 *   POST /api/cases/:id/assign  ?assignee=…  set/clear the case owner    → 200 CaseDetail | 404
 *   POST /api/cases/:id/escalate              force HIGH/OPEN            → 200 CaseDetail | 404
 *   GET  /api/cases/:id/actions/outreach/preview ?templateId=…           → 200 OutreachPreview | 404
 *   POST /api/cases/:id/actions/outreach         ?templateId=…  send     → 200 CaseDetail | 404
 *   POST /api/cases/:id/actions/outreach/delivery ?deliveryStatus=…      → 200 CaseDetail | 400 | 404
 *   POST /api/cases/:id/rerun-to-verify    re-evaluate + transition      → 200 CaseDetail | 404
 *
 * Each mutating action writes a case_action + an audit_event; the detail timeline is
 * the merged ledger. evidence/appointments/ai are later slices.
 */
import type { CloudDatabase, CloudBucket } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import type { CaseStore } from "../stores/case-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import { engineForEnv } from "../engine/cql/engine-factory.ts";
import { toCaseSummary, type CaseSummary } from "../case/case-read-models.ts";
import { bucketPeriodForMeasure } from "../run/compliance-period.ts";
import { toCaseDetail } from "../case/case-detail-read-model.ts";
import { assignCase, escalateCase, resolveCase, CaseActionError, type CaseActionDeps } from "../case/case-actions.ts";
import { previewOutreach, sendOutreach, updateOutreachDelivery, OutreachError } from "../case/case-outreach.ts";
import { rerunToVerify, UnsupportedCaseRerunError, type RerunDeps } from "../case/case-rerun.ts";
import { resolveChannel, isChannelType, type ChannelType, type OutreachChannel } from "../case/outreach-channel.ts";
import {
  uploadEvidence,
  listEvidence,
  downloadEvidence,
  EvidenceError,
  UnsupportedEvidenceTypeError,
  EvidenceNotFoundError,
  EvidenceMissingError,
  type EvidenceDeps,
} from "../case/evidence-service.ts";
import { scheduleAppointment, listAppointments, AppointmentError, type AppointmentDeps } from "../case/appointment-service.ts";
import { resolveForecaster } from "../engine/immunization/resolve-forecaster.ts";
import { resolveBucket } from "../case/resolve-bucket.ts";
import { isWebChartConfigured } from "../engine/ingress/data-source.ts";
import { profileForId } from "../engine/ingress/webchart/live-directory.ts";
import { employeeById } from "../engine/synthetic/employee-catalog.ts";

interface CasesEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
  BUCKET: CloudBucket;
  // Evidence-bucket seam (#167/ADR-030): when the three WORKWELL_BUCKET_S3_* selecting vars are set,
  // evidence bytes go to a managed S3-compatible bucket instead of the (ephemeral-on-MIE) BUCKET binding.
  WORKWELL_BUCKET_S3_BUCKET?: string;
  WORKWELL_BUCKET_S3_ACCESS_KEY_ID?: string;
  WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY?: string;
  WORKWELL_BUCKET_S3_REGION?: string;
  WORKWELL_BUCKET_S3_ENDPOINT?: string;
  WORKWELL_IMMZ_ICE_API_KEY?: string;
  WORKWELL_IMMZ_ICE_BASE_URL?: string;
  // Outreach channel/email-provider knobs read by resolveChannel (simulated by default).
  WORKWELL_EMAIL_PROVIDER?: string;
  WORKWELL_EMAIL_SENDGRID_API_KEY?: string;
  WORKWELL_OUTREACH_DATACHASER_API_KEY?: string;
  WORKWELL_OUTREACH_DATACHASER_BASE_URL?: string;
  WORKWELL_WEBCHART_BASE_URL?: string;
  WORKWELL_WEBCHART_API_KEY?: string;
  WORKWELL_WEBCHART_CLIENT_ID?: string;
  WORKWELL_WEBCHART_PRIVATE_KEY?: string;
  WORKWELL_WEBCHART_TOKEN_URL?: string;
  WORKWELL_WEBCHART_SCOPE?: string;
  WORKWELL_WEBCHART_KID?: string;
}

async function caseStore(env: CasesEnv): Promise<CaseStore> {
  return (await getStores(env)).cases;
}
async function outcomeStore(env: CasesEnv): Promise<OutcomeStore> {
  return (await getStores(env)).outcomes;
}
async function actionDeps(env: CasesEnv): Promise<CaseActionDeps & { channels: (type: ChannelType) => OutreachChannel }> {
  const s = await getStores(env);
  // Thread the real worker env so single-case outreach honors the EMAIL provider (simulated default;
  // inert SendGrid stub when configured) and DataChaser — the same selection campaigns already use (H2).
  return { cases: s.cases, events: s.events, outcomes: s.outcomes, channels: (t) => resolveChannel(t, env) };
}
async function rerunDeps(env: CasesEnv): Promise<RerunDeps> {
  const s = await getStores(env);
  const engine = await engineForEnv(env);
  return { cases: s.cases, events: s.events, outcomes: s.outcomes, runStore: s.runs, engine };
}
async function evidenceDeps(env: CasesEnv): Promise<EvidenceDeps> {
  const s = await getStores(env);
  // #167/ADR-030: durable S3 evidence bucket when the WORKWELL_BUCKET_S3_* vars are set;
  // the injected (in-container fs on MIE) BUCKET binding otherwise — inert-unless-configured.
  return { evidence: s.evidence, cases: s.cases, bucket: await resolveBucket(env), events: s.events };
}
async function appointmentDeps(env: CasesEnv): Promise<AppointmentDeps> {
  const s = await getStores(env);
  return { appointments: s.appointments, cases: s.cases, events: s.events, outcomes: s.outcomes };
}

const json = (data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...extraHeaders } });

/**
 * Map the page's status filter to concrete case statuses. Blank/missing defaults to
 * OPEN (matching the Java controller); `all` is the explicit unfiltered view.
 */
function statusesFor(raw: string | null): string[] | undefined {
  switch ((raw ?? "").toLowerCase()) {
    case "all":
      return undefined; // explicit: include every status
    case "closed":
      return ["RESOLVED", "CLOSED"];
    case "excluded":
      return ["EXCLUDED"];
    case "":
    case "open":
      return ["OPEN"]; // default
    default:
      return [(raw as string).toUpperCase()];
  }
}

/** Day portion (YYYY-MM-DD) for day-granular, inclusive from/to comparison. */
const day = (s: string): string => s.slice(0, 10);

export async function handleCases(req: Request, env: CasesEnv, actor = "system"): Promise<Response | null> {
  const url = new URL(req.url);
  const employeeLookup = isWebChartConfigured(env)
    ? (externalId: string) => employeeById(externalId) ?? profileForId(externalId)
    : employeeById;

  // Case actions (POST) — assign / escalate / outreach send / outreach delivery.
  if (req.method === "POST") {
    const assignId = url.pathname.match(/^\/api\/cases\/([^/]+)\/assign$/)?.[1];
    if (assignId) {
      const detail = await assignCase(await actionDeps(env), assignId, url.searchParams.get("assignee"), actor);
      return detail ? json(detail) : json({ error: "not_found", id: assignId }, 404);
    }
    const escalateId = url.pathname.match(/^\/api\/cases\/([^/]+)\/escalate$/)?.[1];
    if (escalateId) {
      const detail = await escalateCase(await actionDeps(env), escalateId, actor);
      return detail ? json(detail) : json({ error: "not_found", id: escalateId }, 404);
    }
    const deliveryId = url.pathname.match(/^\/api\/cases\/([^/]+)\/actions\/outreach\/delivery$/)?.[1];
    if (deliveryId) {
      try {
        const detail = await updateOutreachDelivery(
          await actionDeps(env),
          deliveryId,
          url.searchParams.get("deliveryStatus") ?? "",
          actor,
        );
        return detail ? json(detail) : json({ error: "not_found", id: deliveryId }, 404);
      } catch (err) {
        if (err instanceof OutreachError) return json({ error: "bad_request", message: err.message }, 400);
        throw err;
      }
    }
    const sendId = url.pathname.match(/^\/api\/cases\/([^/]+)\/actions\/outreach$/)?.[1];
    if (sendId) {
      const channelParam = url.searchParams.get("channel");
      const channel = isChannelType(channelParam) ? channelParam : undefined; // invalid/absent → undefined → EMAIL default
      const detail = await sendOutreach(await actionDeps(env), sendId, actor, url.searchParams.get("templateId"), channel);
      return detail ? json(detail) : json({ error: "not_found", id: sendId }, 404);
    }
    const rerunId = url.pathname.match(/^\/api\/cases\/([^/]+)\/rerun-to-verify$/)?.[1];
    if (rerunId) {
      try {
        const detail = await rerunToVerify(await rerunDeps(env), rerunId, actor);
        return detail ? json(detail) : json({ error: "not_found", id: rerunId }, 404);
      } catch (err) {
        if (err instanceof UnsupportedCaseRerunError) return json({ error: err.code, message: err.message }, 409);
        throw err;
      }
    }
    // Evidence upload (multipart/form-data: file + optional description).
    const evidenceId = url.pathname.match(/^\/api\/cases\/([^/]+)\/evidence$/)?.[1];
    if (evidenceId) {
      let form: FormData;
      try {
        form = await req.formData();
      } catch {
        return json({ error: "bad_request", message: "multipart/form-data with a file is required" }, 400);
      }
      const file = form.get("file") as unknown;
      // FormData entry is either a string field or a file Blob; require a Blob-like with bytes.
      if (!file || typeof file === "string" || typeof (file as Blob).arrayBuffer !== "function") {
        return json({ error: "bad_request", message: "File is required" }, 400);
      }
      const blob = file as Blob & { name?: string };
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const descriptionRaw = form.get("description");
      try {
        const record = await uploadEvidence(
          await evidenceDeps(env),
          evidenceId,
          { bytes, fileName: blob.name ?? null, description: typeof descriptionRaw === "string" ? descriptionRaw : null },
          actor,
        );
        return json(record, 201);
      } catch (err) {
        if (err instanceof UnsupportedEvidenceTypeError) return json({ error: "unsupported_media_type", message: err.message }, 415);
        if (err instanceof EvidenceError) return json({ error: "bad_request", message: err.message }, 400);
        throw err;
      }
    }
    // Case actions: RESOLVE (manual close) or SCHEDULE_APPOINTMENT.
    const actionsId = url.pathname.match(/^\/api\/cases\/([^/]+)\/actions$/)?.[1];
    if (actionsId) {
      const body = (await req.json().catch(() => ({}))) as {
        type?: string;
        note?: string;
        resolvedAt?: string;
        appointmentType?: string;
        scheduledAt?: string;
        location?: string;
        notes?: string;
      };
      const type = (body.type ?? "").toUpperCase();
      try {
        if (type === "RESOLVE") {
          const detail = await resolveCase(await actionDeps(env), actionsId, body.note ?? null, body.resolvedAt ?? null, actor);
          return detail ? json(detail) : json({ error: "not_found", id: actionsId }, 404);
        }
        if (type === "SCHEDULE_APPOINTMENT") {
          const detail = await scheduleAppointment(
            await appointmentDeps(env),
            actionsId,
            { appointmentType: body.appointmentType ?? null, scheduledAt: body.scheduledAt ?? null, location: body.location ?? null, notes: body.notes ?? null },
            actor,
          );
          return detail ? json(detail) : json({ error: "not_found", id: actionsId }, 404);
        }
        return json({ error: "bad_request", message: "Unsupported action type" }, 400);
      } catch (err) {
        if (err instanceof CaseActionError || err instanceof AppointmentError) return json({ error: "bad_request", message: err.message }, 400);
        throw err;
      }
    }
    return null;
  }

  // Evidence download — bytes from the BUCKET (image/* inline, else attachment).
  const downloadId = url.pathname.match(/^\/api\/evidence\/([^/]+)\/download$/)?.[1];
  if (downloadId && req.method === "GET") {
    try {
      const dl = await downloadEvidence(await evidenceDeps(env), downloadId, actor);
      return new Response(dl.bytes, {
        status: 200,
        headers: {
          "content-type": dl.contentType,
          "content-disposition": `${dl.inline ? "inline" : "attachment"}; filename="${dl.record.fileName}"`,
        },
      });
    } catch (err) {
      if (err instanceof EvidenceNotFoundError || err instanceof EvidenceError) return json({ error: "not_found", message: err.message }, 404);
      if (err instanceof EvidenceMissingError) return json({ error: "evidence_missing", message: err.message }, 500);
      throw err;
    }
  }

  // Evidence list + appointments list (GET) for the case-detail page.
  const evidenceListId = url.pathname.match(/^\/api\/cases\/([^/]+)\/evidence$/)?.[1];
  if (evidenceListId && req.method === "GET") {
    return json(await listEvidence(await evidenceDeps(env), evidenceListId));
  }
  const apptListId = url.pathname.match(/^\/api\/cases\/([^/]+)\/appointments$/)?.[1];
  if (apptListId && req.method === "GET") {
    return json(await listAppointments(await appointmentDeps(env), apptListId));
  }

  // Outreach preview (GET) — render the default template for the case (no state change).
  const previewId = url.pathname.match(/^\/api\/cases\/([^/]+)\/actions\/outreach\/preview$/)?.[1];
  if (previewId && req.method === "GET") {
    const preview = await previewOutreach(await actionDeps(env), previewId, url.searchParams.get("templateId"));
    return preview ? json(preview) : json({ error: "not_found", id: previewId }, 404);
  }

  // Case detail — the case row + its evidence (the outcome from the case's last run) + timeline.
  const detailId = url.pathname.match(/^\/api\/cases\/([^/]+)$/)?.[1];
  if (detailId && req.method === "GET") {
    const c = await (await caseStore(env)).getCase(detailId);
    if (!c) return json({ error: "not_found", id: detailId }, 404);
    const outcomes = await (await outcomeStore(env)).listOutcomes(c.lastRunId);
    const outcome = outcomes.find((o) => o.subjectId === c.employeeId && o.measureId === c.measureId) ?? null;
    const events = (await getStores(env)).events;
    const timeline = await events.caseTimeline(detailId);
    const latest = await events.latestOutreachDeliveryStatus(detailId);
    const today = new Date().toISOString().slice(0, 10);
    const immunizationForecast =
      c.measureId === "adult_immunization" ? await resolveForecaster(env).forecast(c.employeeId, today) : undefined;
    return json(toCaseDetail(c, outcome, timeline, latest, immunizationForecast, employeeLookup));
  }

  if (url.pathname !== "/api/cases" || req.method !== "GET") return null;

  const q = url.searchParams;
  const limit = Math.min(500, Math.max(1, Number(q.get("limit") ?? "50") || 50));
  const offset = Math.max(0, Number(q.get("offset") ?? "0") || 0);
  const site = q.get("site")?.trim() || undefined;
  const search = q.get("search")?.trim().toLowerCase() || undefined;
  const from = q.get("from")?.trim() || undefined;
  const to = q.get("to")?.trim() || undefined;
  // Outcome-bucket filter (OVERDUE/DUE_SOON/MISSING_DATA/COMPLIANT/EXCLUDED) — the worklist's
  // "why flagged" axis, distinct from case *status* (OPEN/CLOSED/…). Post-filtered in JS like
  // site/search so X-Total-Count stays exact for paging.
  const outcome = q.get("outcome")?.trim().toUpperCase().replace(/[\s-]+/g, "_") || undefined;
  // The OPEN worklist defaults to each measure's CURRENT compliance cycle — derived from TODAY + the
  // measure's cadence (`bucketPeriodForMeasure`), so it's exact and cadence-correct (filtered in JS
  // below). A blank `?period=` (empty string, not just absent) is treated as the default — `??` alone
  // would leak it through and reintroduce the flood (Codex P2). The closed/excluded/all tabs (also
  // called without a period) show full history, not a single cycle (Codex P2).
  const statusParam = (q.get("status") ?? "").toLowerCase();
  const isOpenWorklist = statusParam === "" || statusParam === "open";
  const explicitPeriod = q.get("period")?.trim() || undefined;
  const wantCurrentCycle = isOpenWorklist && (!explicitPeriod || explicitPeriod.toLowerCase() === "current");

  const store = await caseStore(env);
  // Fetch ALL rows matching the SQL-filterable predicates, then post-filter the record-derived ones
  // (current-cycle, created_at range, employee site/search) and page in the read model — correct paging
  // at floor scale. The fetch is uncapped on purpose: the default worklist always post-filters in JS
  // (per-measure current cycle), so the loaded set must be complete or X-Total-Count would under-report
  // and the frontend would stop paging early (#150 M10 — no silent truncation). For the current cycle we
  // fetch every period ("all") and filter to today's cadence anchor per measure in JS below.
  // (Ceiling-scale note: pushing these record-derived filters + LIMIT/OFFSET + COUNT into SQL — as the
  // Java path does — is the future optimization if a single worklist ever holds very large result sets.)
  let rows = await store.listCases({
    statuses: statusesFor(q.get("status")),
    measureId: q.get("measureId") ?? undefined,
    priority: q.get("priority") ?? undefined,
    assignee: q.get("assignee") ?? undefined,
    period: wantCurrentCycle ? "all" : (explicitPeriod ?? "all"),
    limit: Number.MAX_SAFE_INTEGER,
    offset: 0,
  });

  // from/to filter case creation time (day-granular, inclusive) — matches the Java route.
  if (from) rows = rows.filter((c) => day(c.createdAt) >= day(from));
  if (to) rows = rows.filter((c) => day(c.createdAt) <= day(to));

  // outreachRecordCount per case (derived from OUTREACH_SENT actions) — drives the
  // frontend worklist-gap badge (open cases with count 0). One grouped query for the set.
  const counts = await (await getStores(env)).events.outreachSentCounts(rows.map((c) => c.id));
  let summaries: CaseSummary[] = rows.map((c) => toCaseSummary(c, counts[c.id] ?? 0, employeeLookup));
  if (wantCurrentCycle) {
    // Keep only each measure's CURRENT cycle, by today + the measure's cadence (Codex P2): exact and
    // cadence-correct, so a stale row at another cadence's anchor can't appear and a rolled-over cycle
    // with no open cases doesn't fall back to a prior cycle's stale opens.
    const today = new Date().toISOString().slice(0, 10);
    summaries = summaries.filter((c) => c.evaluationPeriod === bucketPeriodForMeasure(c.measureVersionId, today));
  }
  if (site) summaries = summaries.filter((c) => c.site === site);
  if (outcome) summaries = summaries.filter((c) => (c.currentOutcomeStatus ?? "").toUpperCase() === outcome);
  if (search) {
    summaries = summaries.filter(
      (c) =>
        c.employeeName.toLowerCase().includes(search) ||
        c.measureName.toLowerCase().includes(search) ||
        c.employeeId.toLowerCase().includes(search),
    );
  }
  // #150 M10: expose the full filtered match count so clients can page past the limit instead of
  // silently capping. The body stays a plain array (non-breaking); X-Total-Count carries the total.
  return json(summaries.slice(offset, offset + limit), 200, { "X-Total-Count": String(summaries.length) });
}
