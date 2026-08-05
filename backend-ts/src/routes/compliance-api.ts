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
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { deriveExamConfig } from "../engine/synthetic/exam-config.ts";
import { seededTargetFor } from "../run/distribution.ts";
import { routedEngineForEnv } from "../wiring/executor-router.ts";
import { membershipFor, officialReportIdentity, type PopulationMembership } from "../fhir/measure-report.ts";
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
export function parseCompliancePath(pathname: string): { subjectId: string; measureId: string } | null {
  const m = /^\/api\/v1\/compliance\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!m) return null;
  return { subjectId: decodeURIComponent(m[1]!), measureId: decodeURIComponent(m[2]!) };
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
 * `official-evidence` when the outcome carries the executor's own population vector, else
 * `status-derived`. Read off the SAME field `membershipFor` branches on, so the label cannot disagree
 * with the numbers it describes.
 */
export function populationsSource(evidence: unknown): "official-evidence" | "status-derived" {
  const official = (evidence as { official?: { populationResults?: unknown } } | null | undefined)?.official;
  return official?.populationResults != null ? "official-evidence" : "status-derived";
}

function body(
  subjectId: string,
  measureId: string,
  outcome: Pick<OutcomeRecord, "status" | "evidence">,
  provenance: Record<string, unknown>,
  period: { start: string | null; end: string | null },
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
    period,
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

export async function handleComplianceApi(req: Request, env: ComplianceApiEnv): Promise<Response | null> {
  const url = new URL(req.url);
  const ids = parseCompliancePath(url.pathname);
  if (!ids) return null;
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

  if (mode === "preview") return preview(subjectId, measureId, end, env);
  return latest(subjectId, measureId, start, end, env);
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
  // Newest-first; the same bounded scan MCP's check_compliance uses. 200 is generous for one subject
  // and bounds the read regardless of how many measures a roster carries.
  const rows = await stores.outcomes.listOutcomesForEmployee(subjectId, 200);
  const match = rows.find(
    (r) =>
      r.measureId === measureId &&
      (!start || r.evaluationPeriod >= start) &&
      (!end || r.evaluationPeriod <= end),
  );

  if (!match) {
    // 404, and the message says WHICH absence this is. An integrator must be able to tell "no run has
    // covered this subject" from "this subject is compliant" — returning a cheerful empty 200 here is
    // the single easiest way to make this API dangerous.
    return json(
      {
        error: "no_outcome",
        message:
          `no evaluated outcome for subject '${subjectId}' and measure '${measureId}'` +
          (start || end ? ` in [${start ?? "-∞"}, ${end ?? "+∞"}]` : "") +
          ". This is the absence of a run, not a compliance answer — use ?mode=preview to evaluate now.",
      },
      404,
    );
  }

  return json(
    body(subjectId, measureId, match, {
      mode: "latest",
      evaluatedAt: match.evaluatedAt,
      evaluationPeriod: match.evaluationPeriod,
    }, { start, end }),
  );
}

/**
 * Evaluate now, persist NOTHING.
 *
 * Routed through `routedEngineForEnv`, not a bare authored engine: on a stack where cms125 is officially
 * routed, previewing against authored logic would answer a different question than the one a run answers
 * — a confidently wrong answer, which is worse than no answer.
 *
 * The bundle is composed the way the run pipeline's EMPLOYEE scope composes it — the same
 * `seededTargetFor` + `buildSyntheticBundle` pair — so preview and a run see identical input for the same
 * subject. Building it a second, subtly different way is exactly what `bundleFor`'s own docblock warns
 * against.
 */
async function preview(
  subjectId: string,
  measureId: string,
  end: string | null,
  env: ComplianceApiEnv,
): Promise<Response> {
  const employee = EMPLOYEES.find((e) => e.externalId === subjectId);
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

  const evalDate = end ?? new Date().toISOString().slice(0, 10);
  const target = seededTargetFor(EMPLOYEES, binding.rateKey, subjectId) ?? "MISSING_DATA";
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
      { start: null, end },
    ),
  );
}
