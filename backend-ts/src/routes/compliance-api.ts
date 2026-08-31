/**
 * The versioned COMPLIANCE API (M-C / C3, ADR-061) — the contract MIE consumes.
 *
 *   GET /api/v1/compliance/{subjectId}/{measureId}?start=&end=&mode=latest|preview
 *
 * Doug's question shape, answered directly: *given a patient and a measure, are they compliant?*
 *
 * ## Why this exists when three other surfaces nearly answer it
 *
 * The roster grid is a UI read model whose shape follows the frontend; MCP's `check_compliance` is
 * Claude-facing and role-gated to CM/ADMIN; a run answers for a whole population and writes records. None
 * is a contract an integrator can build against. This is: one subject, one measure, a stable shape, and
 * an explicit statement of where the answer came from.
 *
 * ## `/api/v1/` — the first versioned path in this codebase, deliberately
 *
 * Everything else under `/api/` is an internal contract that moves with the frontend. `v1` is a promise
 * (fields are never removed or retyped), so exactly ONE route is added under it rather than renaming the
 * existing surface into a guarantee nobody has audited.
 *
 * ## The response says where its numbers came from
 *
 * `populationsSource` distinguishes `official-evidence` — the executor's own population vector, persisted
 * under `evidence_json.official.populationResults` — from `status-derived`, where only the initial
 * population is real and the rest are inferred from `OutcomeStatus`. A consumer that treated the second
 * as measured membership would be wrong, and nothing else in the response would tell them.
 *
 * There is exactly ONE reader of that evidence in this codebase and this is not a second one:
 * `membershipFor` / `officialReportIdentity` from `src/fhir/measure-report.ts` are the same functions the
 * MeasureReport and QRDA III exporters use (ADR-031/ADR-046). Two readers that can disagree is the defect
 * those ADRs exist to prevent.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { EVALUABLE_EMPLOYEES, isRunnableMeasure } from "../config/deployment-profile.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { deriveExamConfig } from "../engine/synthetic/exam-config.ts";
import { seededTargetFor } from "../run/distribution.ts";
import { isWebChartConfigured } from "../engine/ingress/data-source.ts";
import { DEPLOYMENT_PROFILE, employeeById } from "../config/deployment-profile.ts";
import { routedEngineForEnv } from "../wiring/executor-router.ts";
import { membershipFor, officialMembership, officialReportIdentity, type PopulationMembership } from "../fhir/measure-report.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";
import type { DataSourceEnv } from "../engine/ingress/data-source.ts";

interface ComplianceApiEnv extends DataSourceEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
  WORKWELL_OFFICIAL_MEASURES?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const isIsoDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** `/api/v1/compliance/{subjectId}/{measureId}` → the two ids, or null when the path is not ours. */
export function parseCompliancePath(pathname: string): { subjectId: string; measureId: string } | "malformed" | null {
  const m = /^\/api\/v1\/compliance\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!m) return null;
  try {
    return { subjectId: decodeURIComponent(m[1]!), measureId: decodeURIComponent(m[2]!) };
  } catch {
    // `decodeURIComponent` THROWS on a bad escape (`%E0%A4%A`), which escaped to the worker's catch-all
    // and surfaced as a 500 (review, #399). A malformed URL is the caller's error, not ours.
    return "malformed";
  }
}

/** The wire shape of the population block. Named fields, not the engine's terse ipp/denom/denex. */
export function renderPopulations(m: PopulationMembership): Record<string, boolean> {
  return {
    initialPopulation: m.ipp,
    denominator: m.denom,
    denominatorExclusion: m.denex,
    denominatorException: m.denexcep,
    numerator: m.numer,
  };
}

/**
 * `official-evidence` only when the executor's population vector was actually PARSED, else
 * `status-derived`.
 *
 * **This calls `officialMembership` — the same function `membershipFor` branches on — rather than
 * checking whether the field is present** (review, #399). A first cut tested
 * `evidence.official.populationResults != null`, which is a *weaker* condition: `officialMembership`
 * returns null on a malformed vector (and alerts), so `membershipFor` would fall back to status-derived
 * booleans while this label still said `official-evidence`. That is precisely the misleading signal the
 * field exists to prevent — the honesty field, lying. Deriving both from one call makes them incapable
 * of disagreeing.
 */
export function populationsSource(evidence: unknown): "official-evidence" | "status-derived" {
  return officialMembership(evidence) !== null ? "official-evidence" : "status-derived";
}

function body(
  subjectId: string,
  measureId: string,
  outcome: Pick<OutcomeRecord, "status" | "evidence">,
  provenance: Record<string, unknown>,
  /** The measurement period the ANSWER covers. Null-null only when genuinely unknown. */
  period: { start: string | null; end: string | null },
  /** The caller's own query bounds, echoed back so the two are never confusable. */
  filter: { start: string | null; end: string | null },
): unknown {
  const meta = MEASURES[measureId]!;
  const identity = officialReportIdentity(outcome.evidence);
  return {
    subject: { id: subjectId },
    measure: {
      id: measureId,
      name: meta.name,
      ...(identity?.ecqmId ? { ecqmId: identity.ecqmId } : {}),
      ...(identity?.version ? { version: identity.version } : {}),
    },
    // The MEASUREMENT period of the answer — not an echo of the request filter, which is what a first cut
    // returned (review, #399). `filter` carries the caller's own bounds separately so the two can never be
    // read as each other.
    period,
    filter,
    // The ANSWER first. An integrator asking "are they compliant?" must not have to compute it from
    // four booleans.
    status: outcome.status,
    populations: renderPopulations(membershipFor(outcome, measureId)),
    populationsSource: populationsSource(outcome.evidence),
    provenance: {
      ...provenance,
      ...(identity?.artifactSha256 ? { artifactSha256: identity.artifactSha256 } : {}),
    },
  };
}

/**
 * Roles allowed to trigger a PREVIEW.
 *
 * `latest` is a read of an existing row and stays open to any authenticated role. `preview` is not a
 * read — it runs the CQL engine, and `authorize.ts` states the viewer posture as "may GET but never
 * write, so the public /sandbox can browse without mutating shared demo state **or triggering compute**"
 * (review, #399). A GET that costs an evaluation is exactly the loophole in that sentence.
 *
 * The bar is the one MCP's `check_compliance` already sets for the same question over the same data:
 * CASE_MANAGER or ADMIN. Aligning them means one answer to "who may ask the engine about a patient",
 * rather than a second, quieter one introduced by a new surface.
 */
const PREVIEW_ROLES: ReadonlySet<string> = new Set(["ROLE_CASE_MANAGER", "ROLE_ADMIN"]);

/**
 * Every answered request writes an audit event (review, #399).
 *
 * MCP records one for every tool call including its sensitivity label, and `check_compliance` is the same
 * question over the same data. Without this there would be **no record that anyone read a patient's
 * compliance status through the contract MIE consumes** — for a public, versioned surface returning
 * per-subject clinical status, that is the gap that matters more than the role matrix.
 *
 * Best-effort at the response boundary: an audit failure must not turn a correct read into a 500. It is
 * logged loudly instead, matching how the run pipeline treats its own per-case audit writes.
 */
async function auditRead(
  env: ComplianceApiEnv,
  actor: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    const stores = await getStores(env);
    await stores.events.appendAudit({
      eventType: "COMPLIANCE_API_READ",
      entityType: "compliance_api",
      entityId: crypto.randomUUID(),
      actor,
      refRunId: (detail["runId"] as string | undefined) ?? null,
      refCaseId: null,
      refMeasureVersionId: null,
      payload: { sensitivityLabel: "restricted", timestamp: new Date().toISOString(), ...detail },
    });
  } catch (err) {
    console.error(`WORKWELL_ALERT compliance-api audit write failed: ${String(err)}`);
  }
}

export async function handleComplianceApi(
  req: Request,
  env: ComplianceApiEnv,
  /** The caller's role, or null when auth is disabled (local/dev), in which case no gate applies. */
  principalRole?: string | null,
  /** The authenticated subject, for the audit trail. */
  actor = "system",
): Promise<Response | null> {
  const url = new URL(req.url);
  const ids = parseCompliancePath(url.pathname);
  if (!ids) return null;
  if (ids === "malformed") {
    return json({ error: "invalid_request", message: "subjectId or measureId is not valid percent-encoding" }, 400);
  }
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const { subjectId, measureId } = ids;
  if (!MEASURES[measureId]) {
    return json(
      { error: "unknown_measure", message: `unknown measure '${measureId}'`, known: Object.keys(MEASURES).sort() },
      400,
    );
  }
  const q = url.searchParams;
  const start = q.get("start");
  const end = q.get("end");
  for (const [name, v] of [["start", start], ["end", end]] as const) {
    if (v !== null && !isIsoDate(v)) {
      return json({ error: "invalid_request", message: `${name} must be YYYY-MM-DD` }, 400);
    }
  }
  if (start && end && start > end) {
    return json({ error: "invalid_request", message: "start must not be after end" }, 400);
  }

  const mode = q.get("mode") ?? "latest";
  if (mode !== "latest" && mode !== "preview") {
    return json({ error: "invalid_request", message: `unknown mode '${mode}' (expected latest | preview)` }, 400);
  }

  if (mode === "preview") {
    if (start !== null) {
      // Accepting and discarding a parameter is worse than refusing it — a versioned contract that
      // silently ignores input teaches callers it was applied (review, #399).
      return json(
        { error: "invalid_request", message: "start does not apply to mode=preview; it evaluates as of `end` (or today)" },
        400,
      );
    }
    if (principalRole != null && !PREVIEW_ROLES.has(principalRole)) {
      return json(
        {
          error: "forbidden",
          message:
            `mode=preview runs the measure engine and is restricted to ${[...PREVIEW_ROLES].join(", ")}; ` +
            `mode=latest is available to any authenticated role`,
        },
        403,
      );
    }
    const res = await preview(subjectId, measureId, end, env);
    await auditRead(env, actor, { subjectId, measureId, mode: "preview", status: res.status });
    return res;
  }
  const res = await latest(subjectId, measureId, start, end, env);
  await auditRead(env, actor, { subjectId, measureId, mode: "latest", status: res.status });
  return res;
}

/** The persisted answer — audit-backed, traceable to a run. */
async function latest(
  subjectId: string,
  measureId: string,
  start: string | null,
  end: string | null,
  env: ComplianceApiEnv,
): Promise<Response> {
  const stores = await getStores(env);
  // Newest-first, matching what MCP's `check_compliance` actually uses (review, #399: the first cut said
  // "the same bounded scan MCP uses" and picked 200 — MCP uses 100000, precisely so a wrong 404 is not
  // possible. It also cited a `scanned` field that did not exist).
  //
  // Why the window matters here: `outcomes` has NO uniqueness on (subject, measure, period), so every run
  // inserts a fresh row — a nightly ALL_PROGRAMS run over ~16 measures writes ~16 rows per subject per
  // night. At 200 that is ~12 nights before a valid older outcome falls outside the window and reads as
  // "no run has covered this subject", which is the exact confusion the 404 exists to prevent.
  const SCAN = 100000;
  const rows = await stores.outcomes.listOutcomesForEmployee(subjectId, SCAN);
  const candidates = rows.filter(
    (r) =>
      r.measureId === measureId &&
      (!start || r.evaluationPeriod >= start) &&
      (!end || r.evaluationPeriod <= end),
  );

  /**
   * Only a FINALIZED run's outcome is the persisted answer (review, #399).
   *
   * A row exists as soon as the evaluation loop writes it — before the run reaches a terminal status, and
   * before `/finalize` in the QRDA import flow. Serving one mid-run would publish a partial result as
   * *the* contract answer, and it would silently become wrong if the run later FAILED. `RUNNING`,
   * `QUEUED`, `REQUESTED`, `FAILED` and `CANCELLED` are all skipped; `PARTIAL_FAILURE` is accepted
   * because it IS terminal and the per-subject row carries its own status (a subject that failed
   * evaluation is persisted `MISSING_DATA` with an `evaluationError`, which is a truthful answer).
   */
  const FINAL: ReadonlySet<string> = new Set(["COMPLETED", "PARTIAL_FAILURE"]);
  let match: (typeof candidates)[number] | undefined;
  let skippedNonFinal = 0;
  for (const c of candidates) {
    const run = await stores.runs.getRun(c.runId);
    if (run && FINAL.has(run.status)) {
      match = c;
      break;
    }
    skippedNonFinal++;
  }

  if (!match) {
    // 404, and the message says WHICH absence this is. An integrator must be able to tell "no run has
    // covered this subject" from "this subject is compliant" — returning a cheerful empty 200 here is
    // the single easiest way to make this API dangerous.
    return json(
      {
        error: "no_outcome",
        message:
          `no FINALIZED outcome for subject '${subjectId}' and measure '${measureId}'` +
          (start || end ? ` in [${start ?? "-∞"}, ${end ?? "+∞"}]` : "") +
          (skippedNonFinal > 0
            ? `. ${skippedNonFinal} matching outcome(s) belong to a run that is not finalized — a run in ` +
              `progress is not an answer yet.`
            : ". This is the absence of a run, not a compliance answer — use ?mode=preview to evaluate now."),
        ...(skippedNonFinal > 0 ? { pendingRuns: skippedNonFinal } : {}),
      },
      404,
    );
  }

  const matchRun = await stores.runs.getRun(match.runId);
  return json(
    body(
      subjectId,
      measureId,
      match,
      { mode: "latest", runId: match.runId, evaluatedAt: match.evaluatedAt, evaluationPeriod: match.evaluationPeriod },
      // The run's OWN measurement period — the window the measure was evaluated over.
      { start: matchRun?.measurementPeriodStart ?? null, end: matchRun?.measurementPeriodEnd ?? null },
      { start, end },
    ),
  );
}

/**
 * Evaluate now, persist NOTHING.
 *
 * Routed through `routedEngineForEnv`, not a bare authored engine: on a stack where cms125 is officially
 * routed, previewing against authored logic would answer a different question than the one a run answers
 * — a confidently wrong answer, which is worse than no answer.
 *
 * ## It REFUSES on a WebChart-configured stack, and that is the honest answer (review, #399)
 *
 * A first cut composed the bundle with `seededTargetFor` + `buildSyntheticBundle` and claimed "preview and
 * a run see identical input". **That is false on exactly the stack this API exists to serve.** The run
 * pipeline's `bundleFor` uses `item.liveBundle` when `prepareLivePopulation` supplied one, i.e. the
 * patient's real FHIR data; preview had no live branch at all.
 *
 * And the failure is worse than "different input": `seededTargetFor` picks the intended outcome from a
 * hash of the subject id, and `buildSyntheticBundle` then constructs data that produces it. That is
 * deterministic demo playback, not an evaluation. Returning `{"status":"COMPLIANT"}` for a real patient
 * from a manufactured bundle — through the contract MIE consumes — is the worst thing this file could do.
 *
 * So on a live stack preview returns **501**, naming the reason. Composing a live bundle here means
 * reaching the WebChart transport per request, which is a different design with different failure modes
 * and belongs in its own change. Refusing is a limitation; answering would be a lie.
 */
async function preview(
  subjectId: string,
  measureId: string,
  end: string | null,
  env: ComplianceApiEnv,
): Promise<Response> {
  if (isWebChartConfigured(env)) {
    return json(
      {
        error: "preview_unavailable",
        message:
          "mode=preview is not available on a WebChart-configured deployment: it would evaluate a " +
          "SYNTHETIC bundle, not this patient's data, and report the result as if it were an evaluation. " +
          "Use mode=latest, which reads what a run actually computed over live data.",
      },
      501,
    );
  }
  // Indexed lookup — `employeeById` is a Map; the linear `.find` it replaced was also the reason a live
  // subject id could never resolve here.
  const employee = employeeById(subjectId);
  if (!employee) {
    return json(
      { error: "unknown_subject", message: `unknown subject '${subjectId}' — preview evaluates the directory only` },
      404,
    );
  }
  const binding = MEASURE_BINDINGS[measureId];
  if (!binding) {
    return json(
      { error: "measure_not_runnable", message: `measure '${measureId}' has no binding and cannot be evaluated` },
      400,
    );
  }
  if (!isRunnableMeasure(measureId)) {
    return json(
      { error: "measure_not_in_profile", message: `measure '${measureId}' is not runnable for deployment profile '${DEPLOYMENT_PROFILE.id}'` },
      400,
    );
  }

  const evalDate = end ?? new Date().toISOString().slice(0, 10);
  const target = seededTargetFor(EVALUABLE_EMPLOYEES, binding.rateKey, subjectId) ?? "MISSING_DATA";
  const bundle = buildSyntheticBundle(employee, deriveExamConfig(binding, target), evalDate);

  const engine = await routedEngineForEnv(env);
  const outcome = await engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: evalDate });

  return json(
    body(
      subjectId,
      measureId,
      { status: outcome.outcome, evidence: outcome.evidence },
      {
        mode: "preview",
        // Stated, not implied: nothing was written. `runId` is null BECAUSE there is no run.
        runId: null,
        persisted: false,
        evaluatedAt: new Date().toISOString(),
        evaluationDate: evalDate,
        engine: engine.logicVersionFor?.(measureId) ?? "authored",
      },
      { start: null, end: evalDate },
      { start: null, end },
    ),
  );
}
