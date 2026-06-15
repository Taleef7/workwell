/**
 * Measure activation impact preview (#108) — TS port of MeasureImpactPreviewService.preview.
 * A DRY RUN: evaluates the measure across the population through the JVM-free engine WITHOUT
 * persisting outcomes/cases, then estimates how a real activation run would change open cases for
 * the same evaluation period (would create/update/close/exclude), plus site/role breakdowns.
 *
 * Reuses the same synthetic evaluation path as the run pipeline (seeded distribution → exam config →
 * FHIR bundle → engine), so a preview's outcomes match what a MEASURE run would persist. Writes a
 * MEASURE_IMPACT_PREVIEWED audit event (dryRun: true). Eval-heavy (~one measure × population), but a
 * single measure stays well under the request timeout, so it runs synchronously like the Java side.
 */
import type { MeasureRecord } from "../stores/measure-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { EvaluateMeasureBinding } from "../engine/evaluate-measure.ts";
import { EMPLOYEES, type EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { deriveExamConfig } from "../engine/synthetic/exam-config.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { seededDistribution } from "../run/distribution.ts";

export interface ImpactPreviewScope {
  site?: string | null;
  employeeExternalId?: string | null;
}
export interface ImpactPreviewRequest {
  evaluationDate?: string | null;
  scope?: ImpactPreviewScope | null;
}
export interface CaseImpact {
  wouldCreate: number;
  wouldUpdate: number;
  wouldClose: number;
  wouldExclude: number;
}
export interface ImpactPreviewResponse {
  measureId: string;
  measureVersionId: string;
  evaluationDate: string;
  populationEvaluated: number;
  outcomeCounts: Record<string, number>;
  caseImpact: CaseImpact;
  siteBreakdown: Array<Record<string, unknown>>;
  roleBreakdown: Array<Record<string, unknown>>;
  warnings: string[];
}

export interface ImpactPreviewDeps {
  cases: CaseStore;
  events: Pick<CaseEventStore, "appendAudit">;
  engine: EvaluateMeasureBinding;
  /** Injectable population for tests (defaults to the full synthetic directory). */
  employees?: readonly EmployeeProfile[];
}

/** A previewed per-subject outcome (the DemoOutcome analogue). */
interface PreviewOutcome {
  subjectId: string;
  outcome: string;
  site: string;
  role: string;
}

const NON_COMPLIANT = new Set(["DUE_SOON", "OVERDUE", "MISSING_DATA"]);
const OUTCOME_KEYS = ["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A bad-request-class error (invalid evaluationDate) — the route maps this to 400. */
export class ImpactPreviewError extends Error {}

function emptyResponse(measure: MeasureRecord, evaluationDate: string, warnings: string[]): ImpactPreviewResponse {
  return {
    measureId: measure.measureId,
    measureVersionId: measure.versionId,
    evaluationDate,
    populationEvaluated: 0,
    outcomeCounts: Object.fromEntries(OUTCOME_KEYS.map((k) => [k, 0])),
    caseImpact: { wouldCreate: 0, wouldUpdate: 0, wouldClose: 0, wouldExclude: 0 },
    siteBreakdown: [],
    roleBreakdown: [],
    warnings,
  };
}

function breakdown(outcomes: PreviewOutcome[], key: "site" | "role"): Array<Record<string, unknown>> {
  const groups = new Map<string, Record<string, number>>();
  for (const o of outcomes) {
    const g = o[key] || "Unknown";
    const counts = groups.get(g) ?? {};
    counts[o.outcome] = (counts[o.outcome] ?? 0) + 1;
    groups.set(g, counts);
  }
  return [...groups.entries()].map(([g, counts]) => ({ [key]: g, ...counts }));
}

export async function previewImpact(deps: ImpactPreviewDeps, measure: MeasureRecord, req: ImpactPreviewRequest = {}, actor = "system"): Promise<ImpactPreviewResponse> {
  const rawDate = req.evaluationDate?.trim();
  if (rawDate && !DATE_RE.test(rawDate)) {
    throw new ImpactPreviewError(`Invalid evaluationDate format: '${rawDate}' — expected YYYY-MM-DD`);
  }
  const evaluationDate = rawDate || new Date().toISOString().slice(0, 10);
  const binding = MEASURE_BINDINGS[measure.measureId];
  const warnings: string[] = [];

  // Only runnable measures (compiled CQL + a synthetic binding) can be previewed.
  if (!binding) {
    warnings.push("CQL evaluation unavailable: measure has no runnable CQL binding.");
    return emptyResponse(measure, evaluationDate, warnings);
  }

  const employees = deps.employees ?? EMPLOYEES;
  let outcomes: PreviewOutcome[];
  try {
    outcomes = await Promise.all(
      seededDistribution(employees, binding.rateKey).map(async (a) => {
        const bundle = buildSyntheticBundle(a.employee, deriveExamConfig(binding, a.target), evaluationDate);
        const result = await deps.engine.evaluate({ measureId: measure.measureId, patientBundle: bundle, evaluationDate });
        return { subjectId: a.employee.externalId, outcome: result.outcome, site: a.employee.site, role: a.employee.role };
      }),
    );
  } catch (err) {
    warnings.push(`CQL evaluation failed: ${String((err as Error)?.message ?? err)}`);
    return emptyResponse(measure, evaluationDate, warnings);
  }

  // Scope filter (site / employee). An explicit-but-empty filter is called out.
  const scope = req.scope ?? null;
  if (scope) {
    outcomes = outcomes.filter(
      (o) =>
        (!scope.site || scope.site.toLowerCase() === o.site.toLowerCase()) &&
        (!scope.employeeExternalId || scope.employeeExternalId.toLowerCase() === o.subjectId.toLowerCase()),
    );
    if ((scope.site || scope.employeeExternalId) && outcomes.length === 0) {
      warnings.push("No employees matched the requested scope — preview reflects 0 subjects.");
    }
  }

  const outcomeCounts: Record<string, number> = Object.fromEntries(OUTCOME_KEYS.map((k) => [k, 0]));
  for (const o of outcomes) outcomeCounts[o.outcome] = (outcomeCounts[o.outcome] ?? 0) + 1;

  // Case impact vs existing non-resolved cases for this measure + evaluation period.
  const existing = await deps.cases.listCases({ measureId: measure.measureId, limit: 100000, offset: 0 });
  const openSubjects = new Set(
    existing.filter((c) => c.evaluationPeriod === evaluationDate && c.status !== "RESOLVED").map((c) => c.employeeId),
  );
  const caseImpact: CaseImpact = { wouldCreate: 0, wouldUpdate: 0, wouldClose: 0, wouldExclude: 0 };
  for (const o of outcomes) {
    const hasCase = openSubjects.has(o.subjectId);
    if (NON_COMPLIANT.has(o.outcome)) hasCase ? caseImpact.wouldUpdate++ : caseImpact.wouldCreate++;
    else if (o.outcome === "COMPLIANT" && hasCase) caseImpact.wouldClose++;
    else if (o.outcome === "EXCLUDED" && hasCase) caseImpact.wouldExclude++;
  }

  const missingData = outcomeCounts.MISSING_DATA ?? 0;
  if (missingData > 0) {
    warnings.push(`${missingData} employee(s) would have MISSING_DATA outcome — required exam records may be absent.`);
  }

  await deps.events.appendAudit({
    eventType: "MEASURE_IMPACT_PREVIEWED",
    entityType: "measure_version",
    entityId: measure.versionId,
    actor,
    refRunId: null,
    refCaseId: null,
    refMeasureVersionId: measure.versionId,
    payload: {
      measureId: measure.measureId,
      measureVersionId: measure.versionId,
      measureName: measure.name,
      version: measure.version,
      evaluationDate,
      populationEvaluated: outcomes.length,
      outcomeCounts,
      warningCount: warnings.length,
      dryRun: true,
    },
  });

  return {
    measureId: measure.measureId,
    measureVersionId: measure.versionId,
    evaluationDate,
    populationEvaluated: outcomes.length,
    outcomeCounts,
    caseImpact,
    siteBreakdown: breakdown(outcomes, "site"),
    roleBreakdown: breakdown(outcomes, "role"),
    warnings,
  };
}
