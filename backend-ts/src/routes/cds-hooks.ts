/**
 * CDS Hooks 2.0.1 service (ADR-067) — the standard shape for delivering a quality gap into the workflow.
 *
 *   GET  /cds-services                              → discovery (PUBLIC — metadata only)
 *   POST /cds-services/{serviceId}                  → cards
 *   POST /cds-services/{serviceId}/feedback         → accepted/overridden, audited
 *
 * Normative reference: https://cds-hooks.hl7.org/2.0/ (HL7 balloted STU2). We serve the standard's
 * contract; we do not redefine it, and we make no claim of external validation — there is no graded
 * conformance suite for a CDS Hooks service (the community validator is JSON Schemas last touched in 2018;
 * Inferno has no CDS Hooks kit). `docs/STANDARDS_CONFORMANCE.md` states that limit.
 *
 * ## Cards render a completed evaluation; they never trigger one
 *
 * Every card comes from a persisted outcome of a FINALIZED run — the same rule ADR-061's `mode=latest`
 * follows, and for the same reason: the alternative is composing a bundle per request, which on a WebChart
 * deployment would mean reporting synthetic playback as an evaluation (`mode=preview` returns 501 there).
 * A consequence worth stating plainly: cards are as fresh as the last run, not as fresh as this encounter.
 *
 * ## Authentication is WorkWell's, NOT the CDS Hooks JWT profile
 *
 * The spec defines its own scheme — a JWT the CDS *Client* signs (RS384/ES384), verified against a JWKS,
 * with `aud` equal to the invoked endpoint and an `iss`/`jku` allowlist. It **SHALL NOT** be signed with a
 * symmetric algorithm, so WorkWell's HS256 token can never be a conformant CDS Hooks JWT — this is a named
 * gap, not an oversight (ADR-067). Invoke and feedback are gated by the ordinary bearer token via
 * `authorize.ts`; discovery is PERMIT because it returns service metadata and no patient data.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import { parseAllowedOrigins } from "../config/cors.ts";
import { resolveStandingOrderProvider, type StandingOrderEnv } from "../order/standing-order-provider.ts";
import { CDS_SERVICES, serviceById } from "../cds/discovery.ts";
import { buildComplianceCards, noEvaluationCard, type CardInput } from "../cds/cards.ts";
import type { CdsFeedbackRequest, CdsRequest } from "../cds/types.ts";

interface CdsHooksEnv extends StandingOrderEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
  WORKWELL_CORS_ALLOWED_ORIGINS?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** A run whose outcomes are an answer. Mirrors ADR-061's set exactly — `PARTIAL_FAILURE` IS terminal. */
const FINAL: ReadonlySet<string> = new Set(["COMPLETED", "PARTIAL_FAILURE"]);

/**
 * The same bounded window `mode=latest` and MCP's `check_compliance` use.
 *
 * `outcomes` has no uniqueness on (subject, measure, period), so every run inserts a fresh row — a nightly
 * ALL_PROGRAMS run over ~16 measures writes ~16 rows per subject per night. A small window would make an
 * older valid outcome read as "never evaluated", which is the one confusion this route must not create.
 */
const SCAN = 100000;

/** `/cds-services`, `/cds-services/{id}`, `/cds-services/{id}/feedback` — or null when not ours. */
export function parseCdsPath(
  pathname: string,
): { kind: "discovery" } | { kind: "invoke" | "feedback"; serviceId: string } | null {
  if (pathname === "/cds-services") return { kind: "discovery" };
  const m = /^\/cds-services\/([^/]+)(\/feedback)?$/.exec(pathname);
  if (!m) return null;
  let serviceId: string;
  try {
    serviceId = decodeURIComponent(m[1]!);
  } catch {
    // A bad percent-escape is the caller's error; `decodeURIComponent` throwing would otherwise reach the
    // worker's catch-all as a 500 (the #399 lesson, same shape as `parseCompliancePath`).
    return null;
  }
  return { kind: m[2] ? "feedback" : "invoke", serviceId };
}

/**
 * A hook's `context.patientId` is a bare EHR id; WorkWell persists live subjects as `wc|<patientId>`
 * (`live-directory.ts`, `run-pipeline.ts`) and the synthetic directory as `emp-006`. Both are tried, live
 * namespace first, so a WebChart client does not silently read as "no gaps" — the trap
 * `docs/PROPOSALS_2026-08.md` §P1 names.
 */
export function candidateSubjectIds(patientId: string): string[] {
  return patientId.startsWith("wc|") ? [patientId] : [`wc|${patientId}`, patientId];
}

/** The Studio origin, for card links. Taken from the CORS allowlist — definitionally the frontend. */
function studioBaseUrl(env: CdsHooksEnv): string | undefined {
  return parseAllowedOrigins(env.WORKWELL_CORS_ALLOWED_ORIGINS)[0];
}

async function auditCds(
  env: CdsHooksEnv,
  actor: string,
  eventType: "CDS_HOOKS_INVOKED" | "CDS_HOOKS_FEEDBACK_RECEIVED",
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    const stores = await getStores(env);
    await stores.events.appendAudit({
      eventType,
      entityType: "cds_hooks",
      entityId: crypto.randomUUID(),
      actor,
      refRunId: (detail["runId"] as string | undefined) ?? null,
      refCaseId: null,
      refMeasureVersionId: null,
      payload: { sensitivityLabel: "restricted", timestamp: new Date().toISOString(), ...detail },
    });
  } catch (err) {
    // Best-effort at the response boundary: an audit failure must not turn a correct answer into a 500.
    console.error(`WORKWELL_ALERT cds-hooks audit write failed: ${String(err)}`);
  }
}

/**
 * The newest FINALIZED outcome per measure for the first subject id that resolves to any row at all.
 *
 * Returns the subject id it used, so the caller can tell "this patient is unknown to WorkWell" from "this
 * patient has only mid-run rows" — two absences that must not be reported identically.
 */
async function latestFinalizedByMeasure(
  env: CdsHooksEnv,
  patientId: string,
): Promise<{ subjectId: string; rows: CardInput[] } | null> {
  const stores = await getStores(env);
  const runStatus = new Map<string, boolean>();
  const isFinal = async (runId: string): Promise<boolean> => {
    const cached = runStatus.get(runId);
    if (cached !== undefined) return cached;
    const run = await stores.runs.getRun(runId);
    const ok = !!run && FINAL.has(run.status);
    runStatus.set(runId, ok);
    return ok;
  };

  for (const subjectId of candidateSubjectIds(patientId)) {
    const all = await stores.outcomes.listOutcomesForEmployee(subjectId, SCAN);
    if (all.length === 0) continue;
    const byMeasure = new Map<string, CardInput>();
    for (const r of all) {
      // Newest-first, so the first finalized row per measure wins.
      if (byMeasure.has(r.measureId)) continue;
      if (!(await isFinal(r.runId))) continue;
      byMeasure.set(r.measureId, {
        measureId: r.measureId,
        status: r.status,
        evidence: r.evidence,
        evaluationPeriod: r.evaluationPeriod,
        runId: r.runId,
        evaluatedAt: r.evaluatedAt,
      });
    }
    return { subjectId, rows: [...byMeasure.values()] };
  }
  return null;
}

/** `"{system}|{code}"` for every APPROVED terminology mapping — read from the STORE, never the seed. */
async function approvedOrderCodes(env: CdsHooksEnv): Promise<ReadonlySet<string>> {
  const stores = await getStores(env);
  const mappings = await stores.valueSets.listTerminologyMappings();
  return new Set(
    mappings
      .filter((m) => m.mappingStatus === "APPROVED")
      .map((m) => `${m.standardSystem}|${m.standardCode}`),
  );
}

async function readJson(req: Request): Promise<unknown | "malformed"> {
  try {
    return await req.json();
  } catch {
    return "malformed";
  }
}

export async function handleCdsHooks(
  req: Request,
  env: CdsHooksEnv,
  /** The authenticated subject, for the audit trail. */
  actor = "system",
): Promise<Response | null> {
  const route = parseCdsPath(new URL(req.url).pathname);
  if (!route) return null;

  if (route.kind === "discovery") {
    if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    // No audit event: discovery carries no patient data, and a public endpoint that writes an audit row
    // per request is a denial-of-service amplifier against our own ledger.
    return json({ services: CDS_SERVICES });
  }

  const service = serviceById(route.serviceId);
  if (!service) {
    return json(
      {
        error: "unknown_service",
        message: `unknown CDS service '${route.serviceId}'`,
        known: CDS_SERVICES.map((s) => s.id),
      },
      404,
    );
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const body = await readJson(req);
  if (body === "malformed" || typeof body !== "object" || body === null) {
    return json({ error: "invalid_request", message: "request body must be a JSON object" }, 400);
  }

  return route.kind === "feedback"
    ? feedback(body as CdsFeedbackRequest, env, actor, service.id)
    : invoke(body as CdsRequest, env, actor, service.id, service.hook);
}

async function invoke(
  body: CdsRequest,
  env: CdsHooksEnv,
  actor: string,
  serviceId: string,
  expectedHook: string,
): Promise<Response> {
  if (!body.hook || !body.hookInstance) {
    return json({ error: "invalid_request", message: "hook and hookInstance are required" }, 400);
  }
  if (body.hook !== expectedHook) {
    // Refusing beats guessing: a mismatched hook means the client's context fields may not be the ones
    // this service reads, so answering would be answering a different question.
    return json(
      { error: "invalid_request", message: `service '${serviceId}' serves hook '${expectedHook}', not '${body.hook}'` },
      400,
    );
  }
  const patientId = body.context?.patientId;
  if (!patientId) {
    return json({ error: "invalid_request", message: "context.patientId is required" }, 400);
  }

  const base = studioBaseUrl(env);
  const found = await latestFinalizedByMeasure(env, patientId);
  // No subject, or no finalized outcome → ONE informational card, never an empty list. See `noEvaluationCard`.
  const cards =
    found === null || found.rows.length === 0
      ? [noEvaluationCard(patientId, base)]
      : await buildComplianceCards(found.rows, {
          subjectId: found.subjectId,
          approvedOrderCodes: await approvedOrderCodes(env),
          standingOrders: resolveStandingOrderProvider(env),
          studioBaseUrl: base,
        });

  await auditCds(env, actor, "CDS_HOOKS_INVOKED", {
    serviceId,
    hook: body.hook,
    hookInstance: body.hookInstance,
    patientId,
    subjectId: found?.subjectId ?? null,
    cardCount: cards.length,
    // The uuids this invocation emitted. This is what makes a later feedback event correlatable without
    // persisting a card table: feedback cites a uuid, this event maps that uuid to a patient and subject,
    // and `cardUuid` recomputes the measure from the subject's own outcomes. See `feedback` below.
    cardUuids: cards.map((c) => c.uuid).filter((u): u is string => !!u),
  });
  return json({ cards });
}

/**
 * Feedback — the only leg of the send/receive reconciliation in guide S7 that WorkWell can build alone.
 *
 * Nothing is persisted beyond the audit event, and nothing needed to be — which is the whole reason this
 * endpoint could be built without a schema change (schema is the owner's alone, CLAUDE.md).
 *
 * **How a bare uuid becomes a measure.** CDS Hooks feedback carries card uuids and nothing else — no
 * patient, no service context — so a service cannot resolve one from the request alone. Two properties
 * make it recoverable anyway: the `CDS_HOOKS_INVOKED` event records the uuids it emitted alongside the
 * patient and subject, and `cardUuid` is a pure function of `(runId, subjectId, measureId)`, so the measure
 * is recomputed from that subject's outcomes rather than looked up. Deterministic ids also mean a client
 * that re-fires the hook for an unchanged run gets the SAME uuid, so repeat feedback does not fragment
 * across ids. We deliberately do not guess: this handler records the uuid verbatim and asserts nothing
 * about what it referred to.
 */
async function feedback(
  body: CdsFeedbackRequest,
  env: CdsHooksEnv,
  actor: string,
  serviceId: string,
): Promise<Response> {
  const entries = body.feedback;
  if (!Array.isArray(entries) || entries.length === 0) {
    return json({ error: "invalid_request", message: "feedback must be a non-empty array" }, 400);
  }
  for (const e of entries) {
    if (!e.card || !e.outcomeTimestamp) {
      return json({ error: "invalid_request", message: "each feedback entry needs card and outcomeTimestamp" }, 400);
    }
    if (e.outcome !== "accepted" && e.outcome !== "overridden") {
      return json(
        { error: "invalid_request", message: "outcome must be 'accepted' or 'overridden'" },
        400,
      );
    }
    if (e.outcome === "accepted" && (!Array.isArray(e.acceptedSuggestions) || e.acceptedSuggestions.length === 0)) {
      // CONDITIONAL in the spec: acceptedSuggestions is REQUIRED for an `accepted` outcome.
      return json(
        { error: "invalid_request", message: "acceptedSuggestions is required when outcome is 'accepted'" },
        400,
      );
    }
  }

  for (const e of entries) {
    await auditCds(env, actor, "CDS_HOOKS_FEEDBACK_RECEIVED", {
      serviceId,
      card: e.card,
      outcome: e.outcome,
      outcomeTimestamp: e.outcomeTimestamp,
      ...(e.overrideReason?.reason?.code ? { overrideReasonCode: e.overrideReason.reason.code } : {}),
      ...(e.overrideReason?.userComment ? { userComment: e.overrideReason.userComment } : {}),
    });
  }
  // 200 with no body: the spec defines no response payload for feedback.
  return new Response(null, { status: 200 });
}
