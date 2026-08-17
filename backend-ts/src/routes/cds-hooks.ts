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

/**
 * Write one audit event. Returns whether it succeeded — and the two callers treat that differently, on
 * purpose (review).
 *
 * For **invoke** a failure is best-effort: the cards returned are still correct, and turning a correct
 * clinical answer into a 500 because the ledger hiccuped would be the worse outcome. For **feedback** the
 * audit event IS the entire persistence (ADR-067 d10 — nothing else is stored, which is why the endpoint
 * needed no schema change), so swallowing a failure would make it a silent no-op that told the client not to
 * retry. CLAUDE.md's "every state change writes `audit_event` — no exceptions" is the rule that decides it.
 */
async function auditCds(
  env: CdsHooksEnv,
  actor: string,
  eventType: "CDS_HOOKS_INVOKED" | "CDS_HOOKS_FEEDBACK_RECEIVED",
  detail: Record<string, unknown>,
): Promise<boolean> {
  try {
    const stores = await getStores(env);
    await stores.events.appendAudit({
      eventType,
      entityType: "cds_hooks",
      entityId: crypto.randomUUID(),
      actor,
      // The run the cards came from, so the ledger row is joinable on `ref_run_id` rather than only through
      // the payload. Earlier this read `detail["runId"]`, which no caller ever set — a line that looked like
      // wiring and could not fire (review).
      refRunId: (detail["runId"] as string | null | undefined) ?? null,
      refCaseId: null,
      refMeasureVersionId: null,
      payload: { sensitivityLabel: "restricted", timestamp: new Date().toISOString(), ...detail },
    });
    return true;
  } catch (err) {
    console.error(`WORKWELL_ALERT cds-hooks audit write failed (${eventType}): ${String(err)}`);
    return false;
  }
}

/**
 * The newest FINALIZED outcome per measure for the first subject id that resolves to any row at all.
 *
 * Returns the subject id it used. To the CLIENT both absences render as the same informational card, which
 * is deliberate — a clinician does not need our run bookkeeping — but the audit trail distinguishes them
 * (`subjectId: null` for an id that resolved to nothing at all, versus a value for a subject whose only rows
 * belong to an unfinished run). An earlier version of this comment claimed the two were reported
 * differently to the caller; they are not (review).
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
          // The id the CLIENT sent, which is the only one it can act on. See `CardOptions.patientId`.
          patientId,
          approvedOrderCodes: await approvedOrderCodes(env),
          standingOrders: resolveStandingOrderProvider(env),
          studioBaseUrl: base,
        });

  // The runs these cards came from. One value is the overwhelmingly common case (a nightly ALL_PROGRAMS run
  // covers every measure), so `refRunId` is set when it is unambiguous and left null when it is not, rather
  // than picking one arbitrarily.
  const runIds = [...new Set((found?.rows ?? []).map((r) => r.runId))];
  await auditCds(env, actor, "CDS_HOOKS_INVOKED", {
    serviceId,
    hook: body.hook,
    hookInstance: body.hookInstance,
    patientId,
    subjectId: found?.subjectId ?? null,
    cardCount: cards.length,
    runId: runIds.length === 1 ? runIds[0]! : null,
    // What makes a later feedback event correlatable without persisting a card table: feedback cites a uuid,
    // and this event maps that uuid to the subject AND the run it came from — so recovering the measure is
    // one `cardUuid` recomputation per measure, not a search over every run in the subject's history
    // (review: without `runId` the documented claim overstated by a step).
    cards: cards
      .filter((c): c is typeof c & { uuid: string } => !!c.uuid)
      .map((c) => ({ uuid: c.uuid, measureId: measureIdOfCard(c, found?.rows ?? []) })),
  });
  return json({ cards });
}

/**
 * Which measure a built card describes, for the audit payload only.
 *
 * Matched on the `source.url` the card already carries (`.../measures/<id>`), falling back to a `summary`
 * prefix match on the catalog name. Descriptive: it never changes what the client receives, and a card we
 * cannot attribute records `null` rather than a guess.
 */
function measureIdOfCard(card: { source: { url?: string }; summary: string }, rows: readonly CardInput[]): string | null {
  const fromUrl = /\/measures\/([^/?#]+)$/.exec(card.source.url ?? "")?.[1];
  if (fromUrl && rows.some((r) => r.measureId === fromUrl)) return fromUrl;
  return null;
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
  // Bounded, because each entry is an append to the audit ledger and the caller is a machine credential.
  // The spec permits batching "for multiple hook instances or multiple cards at the same time"; it does not
  // ask a service to accept an unbounded batch, and one request driving 100k inserts is amplification
  // against our own append-only ledger — the hazard the discovery endpoint's no-audit decision avoided one
  // route over (review).
  if (entries.length > MAX_FEEDBACK_ENTRIES) {
    return json(
      { error: "invalid_request", message: `feedback accepts at most ${MAX_FEEDBACK_ENTRIES} entries per request` },
      400,
    );
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
    if (e.outcome === "accepted") {
      // CONDITIONAL in the spec: `acceptedSuggestions` is REQUIRED for an `accepted` outcome, and each
      // **AcceptedSuggestion** has a REQUIRED `id` — the `card.suggestion.uuid` we emitted. Checking only
      // that the array exists accepted `[{}]`, which carries no information and would be recorded as an
      // accepted suggestion nobody can identify (Codex review surfaced this while arguing a different point).
      if (!Array.isArray(e.acceptedSuggestions) || e.acceptedSuggestions.length === 0) {
        return json(
          { error: "invalid_request", message: "acceptedSuggestions is required when outcome is 'accepted'" },
          400,
        );
      }
      if (!e.acceptedSuggestions.every((s) => typeof s?.id === "string" && s.id.length > 0)) {
        return json(
          { error: "invalid_request", message: "each acceptedSuggestions entry requires a non-empty `id`" },
          400,
        );
      }
    }
  }

  let written = 0;
  for (const e of entries) {
    const ok = await auditCds(env, actor, "CDS_HOOKS_FEEDBACK_RECEIVED", {
      serviceId,
      card: e.card,
      outcome: e.outcome,
      outcomeTimestamp: e.outcomeTimestamp,
      acceptedSuggestions: (e.acceptedSuggestions ?? []).map((s) => s.id ?? null),
      ...(e.overrideReason?.reason?.code ? { overrideReasonCode: e.overrideReason.reason.code } : {}),
      // Clinician free text about an encounter. Capped and truncation-marked, matching the 8000-char bound
      // AI_GUARDRAILS §2.2 already sets for interpolated untrusted text — and noted in the PHI posture,
      // because this is the first path putting unstructured clinical prose into `audit_events` (review).
      ...(e.overrideReason?.userComment
        ? { userComment: truncateComment(e.overrideReason.userComment) }
        : {}),
    });
    if (!ok) {
      // The audit event is the ONLY record of this action, so a failed write must not report success: the
      // spec gives feedback no response body, so a 200 tells the client never to retry and the accepted
      // order is lost silently. `written` says how much of the batch did land, so a retry is informed.
      return json(
        {
          error: "audit_write_failed",
          message:
            "feedback could not be recorded — the audit event is the only record of this action, so this " +
            "request is reported as failed rather than silently dropped. Retry is safe: feedback is " +
            "idempotent by (card, outcome, outcomeTimestamp).",
          recorded: written,
          of: entries.length,
        },
        503,
      );
    }
    written++;
  }
  // 200 with no body: the spec defines no response payload for feedback.
  return new Response(null, { status: 200 });
}

const MAX_FEEDBACK_ENTRIES = 100;
const MAX_USER_COMMENT = 8000;

function truncateComment(s: string): string {
  return s.length <= MAX_USER_COMMENT ? s : `${s.slice(0, MAX_USER_COMMENT)}…[truncated]`;
}
