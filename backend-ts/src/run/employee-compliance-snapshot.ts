/**
 * Advisory, non-persisted, as-of-date compliance re-evaluation for ONE employee (#197). For each active
 * runnable measure it takes the employee's seeded exam config, builds the synthetic bundle anchored to
 * `today` (so events sit at absolute dates), evaluates as-of `asOf`, and maps the result through the
 * shared E10.5 `deriveCell` vocabulary. Writes NOTHING — no runs/outcomes/cases/audit (not a state
 * change). The CQL `Outcome Status` remains the sole compliance authority (ADR-008/ADR-012).
 *
 * Anchoring to `today` (not `asOf`) is what makes scrubbing meaningful: days-since-event = asOf -
 * (today - daysSince), so a later asOf ages a RECURRING measure toward OVERDUE while PERMANENT
 * (series-completion, no recency) measures stay constant.
 */
import { EMPLOYEES, type EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { deriveExamConfig } from "../engine/synthetic/exam-config.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { seededTargetFor } from "./distribution.ts";
import { deriveCell, type DisplayState } from "../compliance/roster-vocabulary.ts";

export interface SnapshotEvaluation {
  measureId: string;
  name: string;
  complianceClass: "PERMANENT" | "RECURRING";
  status: DisplayState;
  method: string;
}
export interface EmployeeComplianceSnapshot {
  externalId: string;
  asOf: string;
  evaluations: SnapshotEvaluation[];
}
/** Structural engine type so tests can pass a fake; the real CqlExecutionEngine satisfies it. */
export interface SnapshotEngine {
  evaluate(input: { measureId: string; patientBundle: unknown; evaluationDate?: string }): Promise<{ outcome: string; evidence: unknown }>;
}
export interface SnapshotDeps {
  engine: SnapshotEngine;
  today: string; // YYYY-MM-DD — anchors the synthetic events
  employees?: readonly EmployeeProfile[];
}

export async function simulateComplianceAsOf(
  externalId: string,
  asOf: string,
  deps: SnapshotDeps,
): Promise<EmployeeComplianceSnapshot | null> {
  const employees = deps.employees ?? EMPLOYEES;
  const employee = employees.find((e) => e.externalId === externalId);
  if (!employee) return null;

  const evaluations: SnapshotEvaluation[] = [];
  for (const measureId of Object.keys(MEASURES)) {
    const binding = MEASURE_BINDINGS[measureId];
    if (!binding) continue;
    const name = MEASURES[measureId]!.name;
    try {
      const target = seededTargetFor(employees, binding.rateKey, externalId) ?? "MISSING_DATA";
      const config = deriveExamConfig(binding, target);
      const bundle = buildSyntheticBundle(employee, config, deps.today); // anchor to today
      const outcome = await deps.engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: asOf });
      const cell = deriveCell(outcome.outcome, outcome.evidence, measureId, asOf);
      evaluations.push({ measureId, name, complianceClass: binding.complianceClass, status: cell.status, method: cell.method });
    } catch {
      // One measure failing must not abort the snapshot (mirrors the run pipeline's per-subject guard).
      evaluations.push({ measureId, name, complianceClass: binding.complianceClass, status: "MISSING_DATA", method: "Evaluation error" });
    }
  }
  return { externalId, asOf, evaluations };
}
