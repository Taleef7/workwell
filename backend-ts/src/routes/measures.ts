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
import { getStores } from "../stores/factory.ts";
import type { MeasureStore } from "../stores/measure-store.ts";
import type { ValueSetStore } from "../stores/value-set-store.ts";
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import type { EvaluateMeasureBinding } from "../engine/evaluate-measure.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { ELM_LIBRARIES } from "../engine/cql/elm/index.ts";
import { compileCql, reconstructCql } from "../engine/cql/cql-translator.ts";
import { listMeasures, toMeasureDetail, toVersionHistory, toActivationReadiness, withValueSetResolution } from "../measure/measure-read-models.ts";
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
import { exportMatBundle } from "../fhir/mat-export.ts";
import { previewImpact, ImpactPreviewError, type ImpactPreviewRequest } from "../measure/impact-preview.ts";
import type { TestFixture } from "../measure/measure-catalog.ts";
import { seedValueSets, backfillImmunizationValueSets } from "../measure/value-set-seed.ts";
import {
  listValueSets,
  listValueSetsByVersion,
  createValueSet,
  attachValueSet,
  detachValueSet,
  resolveCheck,
  diffValueSets,
  getValueSetDetail,
  ValueSetError,
  type ValueSetGovernanceDeps,
} from "../measure/value-set-governance.ts";

interface MeasuresEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
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

// One-shot catalog + value-set demo seed, run once per env over the factory's stores (SQLite floor
// or Postgres ceiling — the factory has already run schema init). The seed uses non-idempotent
// INSERTs with fixed catalog ids, so concurrent cold-start requests must NOT each run it — an
// in-flight promise keyed by env lets every caller await the single initialization.
const seeding = new WeakMap<object, Promise<void>>();
async function store(env: MeasuresEnv): Promise<MeasureStore> {
  const stores = await getStores(env);
  let seed = seeding.get(env);
  if (!seed) {
    seed = (async () => {
      await seedMeasureStore(stores.measures, measureCql);
      // Value-set governance demo seed — after measures (links target version ids).
      const records = await stores.measures.listLatest();
      const versionBySlug = new Map(records.map((r) => [r.measureId, r.versionId]));
      // Fresh store: full demo seed (all sets + links + terminology). Existing stores keep their
      // seed — and any operator detaches/edits of seeded links — untouched.
      if (await stores.valueSets.isEmpty()) {
        await seedValueSets(stores.valueSets, (slug) => versionBySlug.get(slug));
      }
      // Always back-fill ONLY the E10.6 immunization sets + links, and only on first introduction
      // (detach-safe), so they appear on already-seeded DBs without re-asserting the pre-existing links.
      await backfillImmunizationValueSets(stores.valueSets, (slug) => versionBySlug.get(slug));
    })();
    seeding.set(env, seed);
  }
  await seed;
  return stores.measures;
}
async function lifecycleDeps(env: MeasuresEnv): Promise<MeasureLifecycleDeps> {
  const measures = await store(env);
  return { measures, events: (await getStores(env)).events };
}
/** Governance deps (measure store + value-set store + audit) for the value-set surfaces. */
async function governanceDeps(env: MeasuresEnv): Promise<ValueSetGovernanceDeps> {
  const measures = await store(env);
  const s = await getStores(env);
  return { measures, valueSets: s.valueSets, events: s.events };
}
/** Value-set store with the shared one-shot init (schema + measure + value-set demo seed) guaranteed. */
async function valueSetStore(env: MeasuresEnv): Promise<ValueSetStore> {
  await store(env);
  return (await getStores(env)).valueSets;
}

/**
 * Shared, race-safe measure-store accessor (DDL + migrate + catalog seed via the same
 * per-DB in-flight promise). Exported so sibling modules (e.g. the AI route's draft-cql /
 * generate-test-fixtures, #108) read the catalog without re-running the non-idempotent seed.
 */
export async function ensureMeasureStore(env: MeasuresEnv): Promise<MeasureStore> {
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
    // Create a value set (Studio Value Sets tab) → { id }.
    if (pathname === "/api/value-sets") {
      const body = (await req.json().catch(() => ({}))) as { oid?: string; name?: string; version?: string | null };
      try {
        const id = await createValueSet(await valueSetStore(env), body.oid ?? "", body.name ?? "", body.version ?? null);
        return json({ id });
      } catch (err) {
        if (err instanceof ValueSetError) return json({ error: "invalid_request", message: err.message }, 400);
        throw err;
      }
    }
    // Resolve-check the measure's attached value sets (governance panel + activation gate).
    const resolveId = pathname.match(/^\/api\/measures\/([^/]+)\/value-sets\/resolve-check$/)?.[1];
    if (resolveId) {
      try {
        return json(await resolveCheck(await governanceDeps(env), resolveId));
      } catch (err) {
        if (err instanceof ValueSetError) return json({ error: "not_found", message: err.message }, 404);
        throw err;
      }
    }
    // Attach a value set to a measure's latest version → { status: "linked" }.
    const attach = pathname.match(/^\/api\/measures\/([^/]+)\/value-sets\/([^/]+)$/);
    if (attach) {
      try {
        await attachValueSet(await governanceDeps(env), attach[1]!, attach[2]!, actor);
        return json({ status: "linked" });
      } catch (err) {
        if (err instanceof ValueSetError) return json({ error: "not_found", message: err.message }, 404);
        throw err;
      }
    }
    // Save CQL + compile (persists compile_status, returns the CompileResponse).
    const compileId = pathname.match(/^\/api\/measures\/([^/]+)\/cql\/compile$/)?.[1];
    if (compileId) {
      const cqlText = ((await req.json().catch(() => ({}))) as { cqlText?: unknown }).cqlText;
      if (typeof cqlText !== "string") return json({ error: "invalid_cql" }, 400);
      if (cqlText.length > MAX_CQL_BYTES) return json({ error: "cql_too_large", maxBytes: MAX_CQL_BYTES }, 413);
      const res = await compileMeasureCql(await lifecycleDeps(env), compileId, cqlText, actor);
      return res ? json(res) : json({ error: "not_found", measureId: compileId }, 404);
    }
    // Activation impact preview (dry-run): evaluate the population + estimate case impact.
    const impactId = pathname.match(/^\/api\/measures\/([^/]+)\/impact-preview$/)?.[1];
    if (impactId) {
      const measure = await (await store(env)).getLatest(impactId);
      if (!measure) return json({ error: "not_found", measureId: impactId }, 404);
      const body = (await req.json().catch(() => ({}))) as ImpactPreviewRequest;
      try {
        const s = await getStores(env);
        const deps = { cases: s.cases, events: s.events, engine };
        return json(await previewImpact(deps, measure, body, actor));
      } catch (err) {
        if (err instanceof ImpactPreviewError) return json({ error: "invalid_request", message: err.message }, 400);
        throw err;
      }
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

  // ---- detach a value set (DELETE) -----------------------------------------
  if (req.method === "DELETE") {
    const detach = pathname.match(/^\/api\/measures\/([^/]+)\/value-sets\/([^/]+)$/);
    if (detach) {
      try {
        await detachValueSet(await governanceDeps(env), detach[1]!, detach[2]!, actor);
        return json({ status: "unlinked" });
      } catch (err) {
        if (err instanceof ValueSetError) return json({ error: "not_found", message: err.message }, 404);
        throw err;
      }
    }
    return null;
  }

  // ---- reads (GET) ---------------------------------------------------------
  // Value-set catalog + linked-by-version + diff + detail.
  if (pathname === "/api/value-sets" && req.method === "GET") {
    return json(await listValueSets(await valueSetStore(env)));
  }
  const byVersion = pathname.match(/^\/api\/measures\/versions\/([^/]+)\/value-sets$/)?.[1];
  if (byVersion && req.method === "GET") {
    return json(await listValueSetsByVersion(await valueSetStore(env), byVersion));
  }
  const vsDiff = pathname.match(/^\/api\/value-sets\/([^/]+)\/diff$/)?.[1];
  if (vsDiff && req.method === "GET") {
    const toId = url.searchParams.get("toId");
    if (!toId) return json({ error: "invalid_request", message: "toId query parameter is required" }, 400);
    try {
      return json(await diffValueSets(await valueSetStore(env), vsDiff, toId));
    } catch (err) {
      if (err instanceof ValueSetError) return json({ error: "not_found", message: err.message }, 404);
      throw err;
    }
  }
  const vsDetail = pathname.match(/^\/api\/value-sets\/([^/]+)\/detail$/)?.[1];
  if (vsDetail && req.method === "GET") {
    try {
      return json(await getValueSetDetail(await valueSetStore(env), vsDetail));
    } catch (err) {
      if (err instanceof ValueSetError) return json({ error: "not_found", message: err.message }, 404);
      throw err;
    }
  }

  // Compiled ELM (engine registry — runnable measures only).
  const elmId = pathname.match(/^\/api\/measures\/([^/]+)\/elm$/)?.[1];
  if (elmId && req.method === "GET") {
    const meta = MEASURES[elmId];
    if (!meta) return json({ error: "unknown_measure", measureId: elmId }, 404);
    const elm = ELM_LIBRARIES[meta.library];
    if (!elm) return json({ error: "elm_not_found", measureId: elmId, library: meta.library }, 404);
    return json({ measureId: meta.id, name: meta.name, library: meta.library, cql: reconstructCql(elm), elm });
  }

  // MAT-compatible FHIR R4 export (Library + Measure [+ ValueSets]) — APPROVER/ADMIN by the matrix.
  const mat = pathname.match(/^\/api\/measures\/([^/]+)\/versions\/([^/]+)\/export\/mat$/);
  if (mat && req.method === "GET") {
    const [, measureId, versionId] = mat;
    const format = (url.searchParams.get("format") ?? "xml").toLowerCase();
    if (format !== "xml") return json({ error: "invalid_format", message: "Unsupported format. Use format=xml." }, 400);
    const record = await (await store(env)).getByVersionId(versionId!);
    // 404 unless the version exists AND belongs to the measure in the path (Java WHERE m.id=? AND mv.id=?).
    if (!record || record.measureId !== measureId) return json({ error: "not_found", measureId, versionId }, 404);
    const attached = await (await valueSetStore(env)).listByVersion(record.versionId);
    const exportValueSets = attached.map((vs) => ({
      id: vs.id,
      oid: vs.oid,
      name: vs.name,
      version: vs.version,
      canonicalUrl: vs.canonicalUrl || null,
      codes: vs.codes,
    }));
    return new Response(exportMatBundle(record, exportValueSets), {
      status: 200,
      headers: {
        "content-type": "application/fhir+xml",
        "content-disposition": `attachment; filename="measure-${versionId}-mat.xml"`,
      },
    });
  }

  const versionsId = pathname.match(/^\/api\/measures\/([^/]+)\/versions$/)?.[1];
  if (versionsId && req.method === "GET") {
    const versions = await (await store(env)).listVersions(versionsId);
    return versions.length ? json(toVersionHistory(versions)) : json({ error: "not_found", measureId: versionsId }, 404);
  }

  const readinessId = pathname.match(/^\/api\/measures\/([^/]+)\/activation-readiness$/)?.[1];
  if (readinessId && req.method === "GET") {
    const r = await (await store(env)).getLatest(readinessId);
    if (!r) return json({ error: "not_found", measureId: readinessId }, 404);
    // Fold the value-set resolve-check into the readiness (Java MeasureController.activationReadiness).
    const vs = await resolveCheck(await governanceDeps(env), readinessId);
    return json(withValueSetResolution(toActivationReadiness(r), { allResolved: vs.allResolved, blockers: vs.blockers, valueSetCount: vs.valueSets.length }));
  }

  // Policy→spec→CQL→evidence traceability matrix + governance gaps.
  const traceId = pathname.match(/^\/api\/measures\/([^/]+)\/traceability$/)?.[1];
  if (traceId && req.method === "GET") {
    const r = await (await store(env)).getLatest(traceId);
    if (!r) return json({ error: "not_found", measureId: traceId }, 404);
    const attached = await (await valueSetStore(env)).listByVersion(r.versionId);
    return json(generateTraceability(r, attached.map((vs) => ({ name: vs.name, oid: vs.oid, version: vs.version ?? "" }))));
  }

  // Data readiness: required-element source mapping + freshness + missingness gaps.
  const readyId = pathname.match(/^\/api\/measures\/([^/]+)\/data-readiness$/)?.[1];
  if (readyId && req.method === "GET") {
    const r = await (await store(env)).getLatest(readyId);
    if (!r) return json({ error: "not_found", measureId: readyId }, 404);
    return json(await computeDataReadiness({ outcomes: (await getStores(env)).outcomes }, r));
  }

  const detailId = pathname.match(/^\/api\/measures\/([^/]+)$/)?.[1];
  if (detailId && detailId !== "compile" && req.method === "GET") {
    const r = await (await store(env)).getLatest(detailId);
    if (!r) return json({ error: "not_found", measureId: detailId }, 404);
    const valueSets = await listValueSetsByVersion(await valueSetStore(env), r.versionId);
    return json(toMeasureDetail(r, valueSets));
  }

  return null;
}
