/**
 * Measures route (#106) — the live, JVM-free compliance engine behind the worker.
 *
 *   GET  /api/measures                    full TWH catalog (Measure[]); ?status=&search=
 *   GET  /api/measures/:id/elm            compiled ELM (the AST) for the measure
 *   POST /api/measures/:id/evaluate       body = FHIR R4 bundle, ?date=YYYY-MM-DD
 *                                         → { subjectId, measure, outcome, evidence }
 *
 * This is Doug's "given a patient and a measure, are they compliant?" as a live TS
 * endpoint — CQL/eCQM evaluation in Node, no JVM (ELM compiled by @cqframework/cql).
 *
 * The list now serves the full 60-measure TWH catalog (#107 measures module) — the
 * `/measures` page contract — ordered Active-first so the runs/studio pickers still
 * default to a runnable measure. The /elm read endpoint serves the same compiled ELM the
 * engine executes (source↔AST narrative for the Studio explorer). Read-only, no compliance.
 */
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import type { EvaluateMeasureBinding } from "../engine/evaluate-measure.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { ELM_LIBRARIES } from "../engine/cql/elm/index.ts";
import { compileCql, reconstructCql } from "../engine/cql/cql-translator.ts";
import { listCatalog } from "../measure/measure-read-models.ts";

/** Cap on live-compile input so the playground can't be used to DoS the translator. */
const MAX_CQL_BYTES = 64 * 1024;

const engine: EvaluateMeasureBinding = new CqlExecutionEngine();

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Returns a Response if this module owns the route, else null. */
export async function handleMeasures(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  if (pathname === "/api/measures" && req.method === "GET") {
    return json(listCatalog({ status: url.searchParams.get("status"), search: url.searchParams.get("search") }));
  }

  // Live CQL → ELM compile (no JVM) — powers the ELM-explorer playground.
  if (pathname === "/api/measures/compile" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { cql?: unknown } | null;
    const cql = body?.cql;
    if (typeof cql !== "string") return json({ error: "invalid_cql" }, 400);
    if (cql.length > MAX_CQL_BYTES) return json({ error: "cql_too_large", maxBytes: MAX_CQL_BYTES }, 413);
    const result = compileCql(cql);
    return json(result);
  }

  const elmId = pathname.match(/^\/api\/measures\/([^/]+)\/elm$/)?.[1];
  if (elmId && req.method === "GET") {
    const meta = MEASURES[elmId];
    if (!meta) return json({ error: "unknown_measure", measureId: elmId }, 404);
    const elm = ELM_LIBRARIES[meta.library];
    if (!elm) return json({ error: "elm_not_found", measureId: elmId, library: meta.library }, 404);
    // `cql` is the original source rebuilt from the ELM annotation narrative, so the
    // explorer can seed its editor with real, recompilable measure CQL.
    return json({ measureId: meta.id, name: meta.name, library: meta.library, cql: reconstructCql(elm), elm });
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
