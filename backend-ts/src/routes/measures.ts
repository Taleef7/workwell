/**
 * Measures route (#106) — the live, JVM-free compliance engine behind the worker.
 *
 *   GET  /api/measures                    list runnable measures
 *   POST /api/measures/:id/evaluate       body = FHIR R4 bundle, ?date=YYYY-MM-DD
 *                                         → { subjectId, measure, outcome, evidence }
 *
 * This is Doug's "given a patient and a measure, are they compliant?" as a live TS
 * endpoint — CQL/eCQM evaluation in Node, no JVM (ELM compiled by @cqframework/cql).
 */
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import type { EvaluateMeasureBinding } from "../engine/evaluate-measure.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";

const engine: EvaluateMeasureBinding = new CqlExecutionEngine();

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Returns a Response if this module owns the route, else null. */
export async function handleMeasures(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  if (pathname === "/api/measures" && req.method === "GET") {
    return json(Object.values(MEASURES).map((m) => ({ id: m.id, name: m.name })));
  }

  const measureId = pathname.match(/^\/api\/measures\/([^/]+)\/evaluate$/)?.[1];
  if (measureId && req.method === "POST") {
    if (!MEASURES[measureId]) return json({ error: "unknown_measure", measureId }, 404);
    const bundle = (await req.json().catch(() => null)) as unknown;
    if (!bundle || typeof bundle !== "object") return json({ error: "invalid_bundle" }, 400);
    const evaluationDate = url.searchParams.get("date") ?? undefined;
    try {
      const outcome = await engine.evaluate({ measureId, patientBundle: bundle, evaluationDate });
      return json(outcome);
    } catch (err) {
      return json({ error: "evaluation_error", message: String((err as Error)?.message ?? err) }, 500);
    }
  }

  return null;
}
