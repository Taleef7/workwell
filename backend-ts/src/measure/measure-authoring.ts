/**
 * Measure authoring writes (#107) — TS port of MeasureService.updateSpec / updateCql / compileCql /
 * updateTests / validateTests. The Studio Spec/CQL/Tests tabs write through here; each edit replaces
 * the latest version's spec_json / cql_text and writes a MEASURE_VERSION_DRAFT_SAVED audit event
 * (CLAUDE.md: every state change writes audit). Compile maps the JVM-free translator result to the
 * Java CompileResponse shape and persists compile_status.
 *
 * Fidelity notes: the TS measure_versions floor has no `osha_reference_id` or `compile_result`
 * column, so the request's oshaReferenceId is accepted but not persisted as an FK, and compile
 * persists only `compile_status` (the activation gate input) — the full result is returned, not stored.
 */
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { MeasureStore, MeasureRecord } from "../stores/measure-store.ts";
import type { MeasureSpec, TestFixture } from "./measure-catalog.ts";
import { compileCql } from "../engine/cql/cql-translator.ts";
import { validateTests } from "./measure-read-models.ts";
import { generateCql, type Rule, type CodegenBindings } from "../engine/cql/codegen/generate-cql.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";

export interface MeasureAuthoringDeps {
  measures: MeasureStore;
  events: Pick<CaseEventStore, "appendAudit">;
}

export interface CompileResponse {
  status: string;
  warnings: string[];
  errors: string[];
}

export interface SpecUpdate {
  policyRef?: string;
  oshaReferenceId?: string | null;
  description?: string;
  eligibilityCriteria?: { roleFilter?: string; siteFilter?: string; programEnrollmentText?: string };
  exclusions?: Array<{ label: string; criteriaText: string }>;
  complianceWindow?: string;
  requiredDataElements?: string[];
}

const s = (v: unknown): string => (v == null ? "" : String(v));

async function auditDraftSaved(deps: MeasureAuthoringDeps, r: MeasureRecord, actor: string, payload: Record<string, unknown>): Promise<void> {
  await deps.events.appendAudit({
    eventType: "MEASURE_VERSION_DRAFT_SAVED",
    entityType: "measure_version",
    entityId: r.versionId,
    actor,
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: r.versionId,
    payload,
  });
}

/** PUT /api/measures/:id/spec — replace the spec fields, preserving existing test fixtures. */
export async function updateMeasureSpec(deps: MeasureAuthoringDeps, measureId: string, body: SpecUpdate, actor: string): Promise<boolean> {
  const current = await deps.measures.getLatest(measureId);
  if (!current) return false;
  const spec: MeasureSpec = {
    description: s(body.description),
    eligibilityCriteria: {
      roleFilter: s(body.eligibilityCriteria?.roleFilter),
      siteFilter: s(body.eligibilityCriteria?.siteFilter),
      programEnrollmentText: s(body.eligibilityCriteria?.programEnrollmentText),
    },
    exclusions: body.exclusions ?? [],
    complianceWindow: s(body.complianceWindow),
    requiredDataElements: body.requiredDataElements ?? [],
    testFixtures: current.spec.testFixtures ?? [], // updateSpec never touches fixtures (updateTests owns them)
    // A Spec-tab save must not drop Rule Builder params persisted in spec_json (saveRule owns them).
    ...(current.spec.rule !== undefined ? { rule: current.spec.rule } : {}),
    ...(current.spec.ruleBindings !== undefined ? { ruleBindings: current.spec.ruleBindings } : {}),
  };
  const policyRef = body.policyRef !== undefined ? s(body.policyRef).trim() : undefined;
  const updated = await deps.measures.updateSpec(measureId, spec, policyRef);
  if (!updated) return false;
  await auditDraftSaved(deps, updated, actor, { field: "spec", measureId, policyRef: policyRef ?? "", oshaReferenceId: body.oshaReferenceId ?? "" });
  return true;
}

/**
 * PUT /api/measures/:id/cql — replace the CQL text (no compile). Resets compile_status to
 * NOT_COMPILED: the CQL just changed, so any prior COMPILED/WARNINGS is stale and must not let
 * the approval/activation gate pass on uncompiled text (the author must re-run compile).
 */
export async function updateMeasureCql(deps: MeasureAuthoringDeps, measureId: string, cqlText: string, actor: string): Promise<boolean> {
  const updated = await deps.measures.updateCql(measureId, cqlText, "NOT_COMPILED");
  if (!updated) return false;
  await auditDraftSaved(deps, updated, actor, { field: "cql", measureId });
  return true;
}

/** Map the JVM-free translator result → the Java CompileResponse (status + warnings + errors). */
export function toCompileResponse(cqlText: string): CompileResponse {
  const result = compileCql(cqlText);
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const d of result.diagnostics) {
    if (d.severity?.toLowerCase() === "warning") warnings.push(d.message);
    else errors.push(d.message);
  }
  if (!result.ok && errors.length === 0) errors.push("CQL translation failed.");
  const status = errors.length > 0 ? "ERROR" : warnings.length > 0 ? "WARNINGS" : "COMPILED";
  return { status, warnings, errors };
}

/**
 * POST /api/measures/:id/cql/compile — save the CQL, compile it, persist compile_status, return
 * the result. Verifies the measure exists BEFORE compiling so an unknown id can't burn the
 * translator (the route also enforces the byte cap before calling this).
 */
export async function compileMeasureCql(deps: MeasureAuthoringDeps, measureId: string, cqlText: string, actor: string): Promise<CompileResponse | null> {
  if (!(await deps.measures.getLatest(measureId))) return null;
  const response = toCompileResponse(cqlText);
  const updated = await deps.measures.updateCql(measureId, cqlText, response.status);
  if (!updated) return null;
  await auditDraftSaved(deps, updated, actor, { field: "cql", measureId });
  return response;
}

/** PUT /api/measures/:id/tests — replace the version's test fixtures (in spec_json). */
export async function updateMeasureTests(deps: MeasureAuthoringDeps, measureId: string, fixtures: TestFixture[], actor: string): Promise<boolean> {
  const current = await deps.measures.getLatest(measureId);
  if (!current) return false;
  const spec: MeasureSpec = { ...current.spec, testFixtures: fixtures ?? [] };
  const updated = await deps.measures.updateSpec(measureId, spec);
  if (!updated) return false;
  await auditDraftSaved(deps, updated, actor, { field: "tests", measureId, fixtureCount: fixtures?.length ?? 0 });
  return true;
}

/** POST /api/measures/:id/tests/validate — structural validation of the version's fixtures. */
export async function validateMeasureTests(deps: MeasureAuthoringDeps, measureId: string): Promise<{ passed: boolean; failures: string[] } | null> {
  const current = await deps.measures.getLatest(measureId);
  if (!current) return null;
  return validateTests(current.spec.testFixtures ?? []);
}

/** Resolve the generated CQL's `library X version 'Y'` header. Prefer the runnable registry
 *  (MEASURES[id].library = "Name-1.2.3"); fall back to a sanitized measure name + version for measures
 *  not yet in the registry. The name only labels the CQL header — it doesn't affect evaluation. */
function resolveLibrary(measureId: string, record: MeasureRecord): { library: string; version: string } {
  const meta = MEASURES[measureId];
  if (meta) {
    const m = meta.library.match(/^(.*)-(\d[\d.]*)$/);
    if (m) return { library: m[1]!, version: m[2]! };
    return { library: meta.library, version: record.version };
  }
  const lib = record.name.replace(/[^A-Za-z0-9]/g, "") || "Measure";
  return { library: lib, version: record.version };
}

/** Stateless: generate CQL from rule params for a live preview. null = unknown measure; {error} = a
 *  generate failure (e.g. wrong event.type for the shape). */
export async function previewRule(
  deps: MeasureAuthoringDeps, measureId: string, rule: Rule, bindings: CodegenBindings,
): Promise<{ cql: string } | { error: string; message: string } | null> {
  const current = await deps.measures.getLatest(measureId);
  if (!current) return null;
  const { library, version } = resolveLibrary(measureId, current);
  try {
    return { cql: generateCql({ library, version, rule, bindings }) };
  } catch (e) {
    return { error: "preview_failed", message: (e as Error).message };
  }
}

/** Atomic save: generate CQL, persist rule+ruleBindings into spec_json AND the generated CQL into
 *  cql_text (+ compile status), audit once. null = unknown measure; {error} = a generate failure. */
export async function saveRule(
  deps: MeasureAuthoringDeps, measureId: string, rule: Rule, bindings: CodegenBindings, actor: string,
): Promise<(CompileResponse & { cql: string }) | { error: string; message: string } | null> {
  const current = await deps.measures.getLatest(measureId);
  if (!current) return null;
  const { library, version } = resolveLibrary(measureId, current);
  let cql: string;
  try {
    cql = generateCql({ library, version, rule, bindings });
  } catch (e) {
    return { error: "generate_failed", message: (e as Error).message };
  }
  const spec: MeasureSpec = { ...current.spec, rule, ruleBindings: bindings };
  await deps.measures.updateSpec(measureId, spec);
  const compile = toCompileResponse(cql);
  const updated = await deps.measures.updateCql(measureId, cql, compile.status);
  if (!updated) return null;
  await auditDraftSaved(deps, updated, actor, { field: "rule", measureId });
  return { cql, ...compile };
}
