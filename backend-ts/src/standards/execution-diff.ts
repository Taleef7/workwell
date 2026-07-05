/**
 * E14 PR-3 — real subject-by-subject execution diff for CMS122. For each subject in the latest
 * population run: build the synthetic bundle, additively enrich it with real VSAC-member codes, evaluate
 * BOTH WorkWell's authored cms122 AND the official-subset measure fresh, and diff — attributing each
 * divergence to the first differing official gate. Memoized per run-id (terminal runs are immutable).
 * Descriptive only (ADR-008): writes nothing; never sets a stored outcome.
 */
import type { OfficialMeasureReference } from "./reference-types.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { ValueSetResolver, CqlCode } from "../engine/cql/value-set-resolver.ts";
import { CMS122_OFFICIAL_META, enrichForOfficialCms122, type Expansions } from "./cms122-official.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { deriveExamConfig } from "../engine/synthetic/exam-config.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { seededTargetFor } from "../run/distribution.ts";

export interface DiffEngine {
  evaluate(input: { measureId: string; metaOverride?: unknown; patientBundle: unknown; evaluationDate?: string }): Promise<{ outcome: string; evidence: { expressionResults: Array<{ define: string; result: unknown }> } }>;
}
export interface ExecutionDiffDeps {
  engine: DiffEngine;
  resolver: ValueSetResolver;
  employees: readonly EmployeeProfile[];
  today: string; // anchors synthetic events
  asOf: string;  // evaluation date (the run date)
}
export interface SubjectDiff {
  subjectId: string;
  workwellOutcome: string;
  officialOutcome: string;
  diverged: boolean;
  divergenceGate: string;
}
export interface ExecutionDiffReport {
  mode: "execution";
  measureId: string;
  ecqmId: string;
  runId: string | null;
  asOf: string | null;
  totalSubjectsEvaluated: number;
  totalDivergent: number;
  byGate: Record<string, number>;
  subjects: SubjectDiff[];
  headline: string;
  disclaimer: string;
}

type Row = { subjectId: string; status: string; runId: string; runStartedAt: string };

const DISCLAIMER =
  "Real execution diff: an official-SUBSET CMS122 (faithful-but-simplified transcription, FHIR-model, " +
  "driven by the imported VSAC value sets) evaluated per subject against WorkWell's authored measure. " +
  "Not the literal multi-library QICore artifact (un-compilable under the pinned JVM-free translator). " +
  "Descriptive only — CQL Outcome Status remains the sole compliance authority (ADR-008).";

const def = (evidence: { expressionResults: Array<{ define: string; result: unknown }> }, name: string): unknown =>
  evidence.expressionResults.find((e) => e.define === name)?.result;

/** Which official gate removed / reclassified this subject relative to WorkWell (first that applies). */
function attributeGate(ev: { expressionResults: Array<{ define: string; result: unknown }> }): string {
  if (def(ev, "Age 18 To 75") === false) return "age-18-75";
  if (def(ev, "Has Qualifying Visit") === false) return "qualifying-visit";
  if (def(ev, "Has Diabetes") === false) return "diabetes-diagnosis";
  if (def(ev, "Has Hospice") === true) return "hospice";
  if (def(ev, "Has Palliative") === true) return "palliative-care";
  if (def(ev, "HbA1c Missing") === true) return "hba1c-missing-counts-numerator";
  return "numerator-threshold";
}

const cache = new Map<string, ExecutionDiffReport>();
/** @internal test hook */
export function __clearExecutionDiffCache(): void {
  cache.clear();
}

export async function computeExecutionDiff(
  ref: OfficialMeasureReference,
  rows: Row[],
  deps: ExecutionDiffDeps,
): Promise<ExecutionDiffReport> {
  const runId = rows[0]?.runId ?? null;
  const asOf = rows[0]?.runStartedAt?.slice(0, 10) ?? deps.asOf;
  if (runId && cache.has(runId)) return cache.get(runId)!;

  const expansions: Expansions = new Map<string, CqlCode[]>();
  for (const oid of CMS122_OFFICIAL_META.valueSets ?? []) expansions.set(oid, await deps.resolver.expand(oid));

  const binding = MEASURE_BINDINGS["cms122"]!;
  const subjects: SubjectDiff[] = [];
  const byGate: Record<string, number> = {};

  for (const row of rows) {
    const employee = deps.employees.find((e) => e.externalId === row.subjectId);
    if (!employee) continue;
    try {
      const target = seededTargetFor(deps.employees, binding.rateKey, row.subjectId) ?? "MISSING_DATA";
      const config = deriveExamConfig(binding, target);
      const base = buildSyntheticBundle(employee, config, deps.today);
      const enriched = enrichForOfficialCms122(base, employee, expansions);
      const workwell = await deps.engine.evaluate({ measureId: "cms122", patientBundle: enriched, evaluationDate: deps.asOf });
      const official = await deps.engine.evaluate({ measureId: "cms122_official", metaOverride: CMS122_OFFICIAL_META, patientBundle: enriched, evaluationDate: deps.asOf });
      const diverged = official.outcome !== workwell.outcome;
      const gate = diverged ? attributeGate(official.evidence) : "";
      if (diverged) byGate[gate] = (byGate[gate] ?? 0) + 1;
      subjects.push({ subjectId: row.subjectId, workwellOutcome: workwell.outcome, officialOutcome: official.outcome, diverged, divergenceGate: gate });
    } catch {
      subjects.push({ subjectId: row.subjectId, workwellOutcome: row.status, officialOutcome: "ERROR", diverged: false, divergenceGate: "" });
    }
  }

  const totalDivergent = subjects.filter((s) => s.diverged).length;
  const report: ExecutionDiffReport = {
    mode: "execution",
    measureId: ref.measureId,
    ecqmId: ref.ecqmId,
    runId,
    asOf,
    totalSubjectsEvaluated: subjects.length,
    totalDivergent,
    byGate,
    subjects,
    headline:
      `Executed the official-subset ${ref.ecqmId} against ${subjects.length} subjects of the latest ` +
      `${ref.measureId} run: ${totalDivergent} would have a different outcome under the official ` +
      `age/visit/exclusion/numerator criteria.`,
    disclaimer: DISCLAIMER,
  };
  if (runId) cache.set(runId, report);
  return report;
}
