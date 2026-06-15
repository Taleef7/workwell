/**
 * Measures route (#106/#107) — the measure catalog + authoring surface + the JVM-free engine.
 *
 *   GET  /api/measures                    catalog (Measure[]); ?status=&search=
 *   POST /api/measures                    create a Draft measure → { id }
 *   GET  /api/measures/:id                MeasureDetail (spec + CQL + compile status)
 *   GET  /api/measures/:id/versions       VersionHistoryItem[]
 *   GET  /api/measures/:id/activation-readiness   ActivationReadiness (compile/fixture gate)
 *   POST /api/measures/:id/approve        Draft → Approved (gated)        → { status }
 *   POST /api/measures/:id/status         { targetStatus } transition     → { status }
 *   POST /api/measures/:id/deprecate      { reason } Active → Deprecated   → { status }
 *   GET  /api/measures/:id/elm            compiled ELM (the AST)
 *   POST /api/measures/:id/evaluate       FHIR R4 bundle → outcome
 *   POST /api/measures/compile            live CQL → ELM (ELM-explorer)
 *
 * The catalog + authoring reads/writes go through the persisted MeasureStore (seeded from
 * MEASURE_CATALOG on first use), so create/lifecycle mutations are reflected. The engine
 * endpoints (/elm, /evaluate, /compile) stay on the compiled-ELM path — no JVM, no DB.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { RUN_STORE_FLOOR_DDL, migrateFloorSchema } from "../stores/sqlite/schema.ts";
import { SqliteMeasureStore } from "../stores/sqlite/measure-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import type { EvaluateMeasureBinding } from "../engine/evaluate-measure.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { ELM_LIBRARIES } from "../engine/cql/elm/index.ts";
import { compileCql, reconstructCql } from "../engine/cql/cql-translator.ts";
import { listMeasures, toMeasureDetail, toVersionHistory, toActivationReadiness } from "../measure/measure-read-models.ts";
import { seedMeasureStore } from "../measure/measure-seed.ts";
import { createMeasure, approveMeasure, deprecateMeasure, transitionStatus, MeasureError, type MeasureLifecycleDeps } from "../measure/measure-lifecycle.ts";
import {
  updateMeasureSpec,
  updateMeasureCql,
  compileMeasureCql,
  updateMeasureTests,
  validateMeasureTests,
  type SpecUpdate,
} from "../measure/measure-authoring.ts";
import { listOshaReferences } from "../measure/osha-references.ts";
import { generateTraceability } from "../measure/measure-traceability.ts";
import { computeDataReadiness } from "../measure/data-readiness.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import type { TestFixture } from "../measure/measure-catalog.ts";

interface MeasuresEnv {
  DB: CloudDatabase;
}

/** Reconstruct the measure's CQL from its compiled ELM (runnable measures); "" otherwise. */
function measureCql(measureId: string): string {
  const meta = MEASURES[measureId];
  const elm = meta ? ELM_LIBRARIES[meta.library] : undefined;
  return elm ? reconstructCql(elm) : "";
}

/** Cap on live-compile input so the playground can't be used to DoS the translator. */
const MAX_CQL_BYTES = 64 * 1024;
const engine: EvaluateMeasureBinding = new CqlExecutionEngine();

// One-shot per-DB init (DDL + migrate + catalog seed). The seed uses non-idempotent INSERTs
// with fixed catalog ids, so concurrent cold-start requests must NOT each run it — an in-flight
// promise keyed by the DB lets every caller await the same single initialization.
const initializing = new WeakMap<object, Promise<void>>();
async function store(env: MeasuresEnv): Promise<SqliteMeasureStore> {
  let init = initializing.get(env.DB);
  if (!init) {
    init = (async () => {
      await env.DB.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
      await migrateFloorSchema(env.DB);
      await seedMeasureStore(new SqliteMeasureStore(env.DB), measureCql);
    })();
    initializing.set(env.DB, init);
  }
  await init;
  return new SqliteMeasureStore(env.DB);
}
async function lifecycleDeps(env: MeasuresEnv): Promise<MeasureLifecycleDeps> {
  return { measures: await store(env), events: new SqliteCaseEventStore(env.DB) };
}

/**
 * Shared, race-safe measure-store accessor (DDL + migrate + catalog seed via the same
 * per-DB in-flight promise). Exported so sibling modules (e.g. the AI route's draft-cql /
 * generate-test-fixtures, #108) read the catalog without re-running the non-idempotent seed.
 */
export async function ensureMeasureStore(env: MeasuresEnv): Promise<SqliteMeasureStore> {
  return store(env);
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Returns a Response if this module owns the route, else null. */
export async function handleMeasures(req: Request, env: MeasuresEnv, actor = "system"): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;

  // OSHA reference lookup for the Studio Spec tab policy-reference combobox (static seed).
  if (pathname === "/api/osha-references" && req.method === "GET") {
    return json(listOshaReferences());
  }

  if (pathname === "/api/measures" && req.method === "GET") {
    const records = await (await store(env)).listLatest();
    return json(listMeasures(records, { status: url.searchParams.get("status"), search: url.searchParams.get("search") }));
  }

  if (pathname === "/api/measures" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { name?: string; policyRef?: string; owner?: string };
    try {
      const id = await createMeasure(await lifecycleDeps(env), { name: body.name ?? "", policyRef: body.policyRef ?? "", owner: body.owner ?? "" }, actor);
      return json({ id }, 201);
    } catch (err) {
      if (err instanceof MeasureError) return json({ error: "invalid_request", message: err.message }, 400);
      throw err;
    }
  }

  // Live CQL → ELM compile (no JVM) — powers the ELM-explorer playground.
  if (pathname === "/api/measures/compile" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { cql?: unknown } | null;
    const cql = body?.cql;
    if (typeof cql !== "string") return json({ error: "invalid_cql" }, 400);
    if (cql.length > MAX_CQL_BYTES) return json({ error: "cql_too_large", maxBytes: MAX_CQL_BYTES }, 413);
    return json(compileCql(cql));
  }

  // ---- authoring edits (PUT) — Studio Spec/CQL/Tests tabs ------------------
  if (req.method === "PUT") {
    const specId = pathname.match(/^\/api\/measures\/([^/]+)\/spec$/)?.[1];
    if (specId) {
      const body = (await req.json().catch(() => ({}))) as SpecUpdate;
      const ok = await updateMeasureSpec(await lifecycleDeps(env), specId, body, actor);
      return ok ? json({ status: "saved" }) : json({ error: "not_found", measureId: specId }, 404);
    }
    const cqlId = pathname.match(/^\/api\/measures\/([^/]+)\/cql$/)?.[1];
    if (cqlId) {
      const cqlText = ((await req.json().catch(() => ({}))) as { cqlText?: unknown }).cqlText;
      if (typeof cqlText !== "string") return json({ error: "invalid_cql" }, 400);
      if (cqlText.length > MAX_CQL_BYTES) return json({ error: "cql_too_large", maxBytes: MAX_CQL_BYTES }, 413);
      const ok = await updateMeasureCql(await lifecycleDeps(env), cqlId, cqlText, actor);
      return ok ? json({ status: "saved" }) : json({ error: "not_found", measureId: cqlId }, 404);
    }
    const testsId = pathname.match(/^\/api\/measures\/([^/]+)\/tests$/)?.[1];
    if (testsId) {
      const fixtures = ((await req.json().catch(() => ({}))) as { fixtures?: TestFixture[] }).fixtures ?? [];
      const ok = await updateMeasureTests(await lifecycleDeps(env), testsId, fixtures, actor);
      return ok ? json({ status: "saved" }) : json({ error: "not_found", measureId: testsId }, 404);
    }
    return null;
  }

  // ---- lifecycle (POST) ----------------------------------------------------
  if (req.method === "POST") {
    // Save CQL + compile (persists compile_status, returns the CompileResponse).
    const compileId = pathname.match(/^\/api\/measures\/([^/]+)\/cql\/compile$/)?.[1];
    if (compileId) {
      const cqlText = ((await req.json().catch(() => ({}))) as { cqlText?: unknown }).cqlText;
      if (typeof cqlText !== "string") return json({ error: "invalid_cql" }, 400);
      if (cqlText.length > MAX_CQL_BYTES) return json({ error: "cql_too_large", maxBytes: MAX_CQL_BYTES }, 413);
      const res = await compileMeasureCql(await lifecycleDeps(env), compileId, cqlText, actor);
      return res ? json(res) : json({ error: "not_found", measureId: compileId }, 404);
    }
    // Validate the version's persisted test fixtures.
    const testsValidateId = pathname.match(/^\/api\/measures\/([^/]+)\/tests\/validate$/)?.[1];
    if (testsValidateId) {
      const res = await validateMeasureTests(await lifecycleDeps(env), testsValidateId);
      return res ? json(res) : json({ error: "not_found", measureId: testsValidateId }, 404);
    }
    const approveId = pathname.match(/^\/api\/measures\/([^/]+)\/approve$/)?.[1];
    const deprecateId = pathname.match(/^\/api\/measures\/([^/]+)\/deprecate$/)?.[1];
    const statusId = pathname.match(/^\/api\/measures\/([^/]+)\/status$/)?.[1];
    if (approveId || deprecateId || statusId) {
      try {
        if (approveId) {
          const s = await approveMeasure(await lifecycleDeps(env), approveId, actor);
          return s ? json({ status: s }) : json({ error: "not_found", measureId: approveId }, 404);
        }
        if (deprecateId) {
          const reason = ((await req.json().catch(() => ({}))) as { reason?: string }).reason ?? "";
          const s = await deprecateMeasure(await lifecycleDeps(env), deprecateId, reason, actor);
          return s ? json({ status: s }) : json({ error: "not_found", measureId: deprecateId }, 404);
        }
        const targetStatus = ((await req.json().catch(() => ({}))) as { targetStatus?: string }).targetStatus ?? "";
        const s = await transitionStatus(await lifecycleDeps(env), statusId!, targetStatus, actor);
        return s ? json({ status: s }) : json({ error: "not_found", measureId: statusId }, 404);
      } catch (err) {
        if (err instanceof MeasureError) return json({ error: "invalid_request", message: err.message }, 400);
        throw err;
      }
    }

    // Evaluate a subject against the measure's compiled ELM (engine path).
    const evalId = pathname.match(/^\/api\/measures\/([^/]+)\/evaluate$/)?.[1];
    if (evalId) {
      if (!MEASURES[evalId]) return json({ error: "unknown_measure", measureId: evalId }, 404);
      const bundle = (await req.json().catch(() => null)) as unknown;
      if (!bundle || typeof bundle !== "object") return json({ error: "invalid_bundle" }, 400);
      try {
        const outcome = await engine.evaluate({ measureId: evalId, patientBundle: bundle, evaluationDate: url.searchParams.get("date") ?? undefined });
        return json(outcome);
      } catch (err) {
        return json({ error: "evaluation_error", message: String((err as Error)?.message ?? err) }, 500);
      }
    }
    return null;
  }

  // ---- reads (GET) ---------------------------------------------------------
  // Compiled ELM (engine registry — runnable measures only).
  const elmId = pathname.match(/^\/api\/measures\/([^/]+)\/elm$/)?.[1];
  if (elmId && req.method === "GET") {
    const meta = MEASURES[elmId];
    if (!meta) return json({ error: "unknown_measure", measureId: elmId }, 404);
    const elm = ELM_LIBRARIES[meta.library];
    if (!elm) return json({ error: "elm_not_found", measureId: elmId, library: meta.library }, 404);
    return json({ measureId: meta.id, name: meta.name, library: meta.library, cql: reconstructCql(elm), elm });
  }

  const versionsId = pathname.match(/^\/api\/measures\/([^/]+)\/versions$/)?.[1];
  if (versionsId && req.method === "GET") {
    const versions = await (await store(env)).listVersions(versionsId);
    return versions.length ? json(toVersionHistory(versions)) : json({ error: "not_found", measureId: versionsId }, 404);
  }

  const readinessId = pathname.match(/^\/api\/measures\/([^/]+)\/activation-readiness$/)?.[1];
  if (readinessId && req.method === "GET") {
    const r = await (await store(env)).getLatest(readinessId);
    return r ? json(toActivationReadiness(r)) : json({ error: "not_found", measureId: readinessId }, 404);
  }

  // Policy→spec→CQL→evidence traceability matrix + governance gaps.
  const traceId = pathname.match(/^\/api\/measures\/([^/]+)\/traceability$/)?.[1];
  if (traceId && req.method === "GET") {
    const r = await (await store(env)).getLatest(traceId);
    return r ? json(generateTraceability(r)) : json({ error: "not_found", measureId: traceId }, 404);
  }

  // Data readiness: required-element source mapping + freshness + missingness gaps.
  const readyId = pathname.match(/^\/api\/measures\/([^/]+)\/data-readiness$/)?.[1];
  if (readyId && req.method === "GET") {
    const r = await (await store(env)).getLatest(readyId);
    if (!r) return json({ error: "not_found", measureId: readyId }, 404);
    return json(await computeDataReadiness({ outcomes: new SqliteOutcomeStore(env.DB) }, r));
  }

  const detailId = pathname.match(/^\/api\/measures\/([^/]+)$/)?.[1];
  if (detailId && detailId !== "compile" && req.method === "GET") {
    const r = await (await store(env)).getLatest(detailId);
    return r ? json(toMeasureDetail(r)) : json({ error: "not_found", measureId: detailId }, 404);
  }

  return null;
}
