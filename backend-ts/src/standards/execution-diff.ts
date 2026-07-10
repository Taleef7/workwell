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
  /** Diff-mode tier (#258): the ADR-024 official-SUBSET execution diff. literal → subset → estimate ladder. */
  mode: "subset";
  measureId: string;
  ecqmId: string;
  runId: string | null;
  asOf: string | null;
  totalSubjectsEvaluated: number;
  totalDivergent: number;
  /** Subjects whose WorkWell or official evaluation threw — recorded as ERROR rows, NOT counted as divergent. */
  totalErrors: number;
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
function attributeGate(
  ev: { expressionResults: Array<{ define: string; result: unknown }> },
  workwellOutcome: string,
  officialOutcome: string,
): string {
  if (def(ev, "Age 18 To 75") === false) return "age-18-75";
  if (def(ev, "Has Qualifying Visit") === false) return "qualifying-visit";
  if (def(ev, "Has Diabetes") === false) return "diabetes-diagnosis";
  if (def(ev, "Has Hospice") === true) return "hospice";
  if (def(ev, "Has Palliative") === true) return "palliative-care";
  if (def(ev, "Glycemic Assessment Missing") === true) return "glycemic-assessment-missing-counts-numerator";
  // WorkWell excludes the subject (a urn:workwell:* waiver the official subset doesn't model) while the
  // official measure keeps them — attribute to the WorkWell-side exclusion, not to whatever numerator the
  // official then computes.
  if (workwellOutcome === "EXCLUDED" && officialOutcome !== "EXCLUDED") return "workwell-exclusion";
  // A poor GMI (LOINC 97506-0, > 9%) drove the official numerator. WorkWell can't see the GMI observation
  // (it reads only the urn:workwell HbA1c), and the shared HbA1c can't diverge this way (both sides read
  // the same observation + value), so a value-driven official OVERDUE reaching here is GMI-driven — the
  // GMI alternative this diff is meant to surface (Codex P2; was previously mislabeled "workwell-side").
  if (officialOutcome === "OVERDUE") return "gmi-poor-control";
  // Any remaining divergence originates on the WorkWell side (a urn:workwell define the subset omits).
  return "workwell-side";
}

// Keyed on runId (only the latest run is ever queried). Assumes the imported VSAC `value_sets` don't
// churn between run completions — the official side's expansion depends on them. Not keyed on `today`
// (which anchors the synthetic bundles): a report cached before a day boundary is reused after it, but
// the run is immutable and cms122 is value-based (not recency-based), so the delta is negligible and a
// worker redeploy clears the cache anyway.
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
      const enriched = enrichForOfficialCms122(base, employee, expansions, deps.today);
      const workwell = await deps.engine.evaluate({ measureId: "cms122", patientBundle: enriched, evaluationDate: deps.asOf });
      const official = await deps.engine.evaluate({ measureId: "cms122_official", metaOverride: CMS122_OFFICIAL_META, patientBundle: enriched, evaluationDate: deps.asOf });
      const diverged = official.outcome !== workwell.outcome;
      const gate = diverged ? attributeGate(official.evidence, workwell.outcome, official.outcome) : "";
      if (diverged) byGate[gate] = (byGate[gate] ?? 0) + 1;
      subjects.push({ subjectId: row.subjectId, workwellOutcome: workwell.outcome, officialOutcome: official.outcome, diverged, divergenceGate: gate });
    } catch {
      subjects.push({ subjectId: row.subjectId, workwellOutcome: row.status, officialOutcome: "ERROR", diverged: false, divergenceGate: "" });
    }
  }

  const totalDivergent = subjects.filter((s) => s.diverged).length;
  // ERROR rows (a subject whose WorkWell or official evaluation threw) are isolated as non-divergent so
  // one failure can't abort the run — but they must be SURFACED, not silently folded into a clean count,
  // or a broken evaluation would read as "no divergence" (Codex P2).
  const totalErrors = subjects.filter((s) => s.officialOutcome === "ERROR").length;
  const report: ExecutionDiffReport = {
    mode: "subset",
    measureId: ref.measureId,
    ecqmId: ref.ecqmId,
    runId,
    asOf: deps.asOf,
    totalSubjectsEvaluated: subjects.length,
    totalDivergent,
    totalErrors,
    byGate,
    subjects,
    headline:
      `Executed the official-subset ${ref.ecqmId} against ${subjects.length} subjects of the latest ` +
      `${ref.measureId} run: ${totalDivergent} would have a different outcome under the official ` +
      `age/visit/exclusion/numerator criteria` +
      (totalErrors > 0 ? `; ${totalErrors} failed to evaluate (excluded from the divergence count).` : "."),
    disclaimer: DISCLAIMER,
  };
  if (runId) {
    if (cache.size >= 16) cache.clear();
    cache.set(runId, report);
  }
  return report;
}
