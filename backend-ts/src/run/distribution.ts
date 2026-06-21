/**
 * Synthetic outcome distribution (#107) — TS port of the seeded-population logic in
 * com.workwell.compile.CqlEvaluationService (`orderedEmployeesFor` + the bucket split).
 *
 * For a measure + population it assigns each employee a target outcome BUCKET:
 *   compliant = round(N * complianceRate);  excluded = min(3, …);  missing = min(2, …);
 *   the rest split half DUE_SOON / half OVERDUE.
 * Employees are ordered by a per-measure hash so the assignment is deterministic and
 * stable (the same shuffle the Java side uses — Java String.hashCode, ported exactly).
 *
 * Reminder: a bucket is a distribution INTENT; the canonical outcome is always the CQL
 * result (see exam-config.ts) — so the persisted outcome may differ for season/value-based
 * measures, exactly as in Java.
 */
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { TargetOutcome } from "../engine/synthetic/exam-config.ts";
import { complianceRate } from "./compliance-rates.ts";

const EXCLUDED_COUNT = 3;
const MISSING_DATA_COUNT = 2;

/** Java `String.hashCode` (32-bit, overflowing) — needed for ordering parity. */
export function javaHashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** floorMod(hashCode(rateKey|id), 2^31-1) — the Java sort key. */
function orderKey(rateKey: string, externalId: string): number {
  const MAX = 2147483647; // Integer.MAX_VALUE
  return ((javaHashCode(`${rateKey}|${externalId}`) % MAX) + MAX) % MAX;
}

export function orderedEmployees(employees: readonly EmployeeProfile[], rateKey: string): EmployeeProfile[] {
  return [...employees].sort((a, b) => orderKey(rateKey, a.externalId) - orderKey(rateKey, b.externalId));
}

export interface SeededAssignment {
  employee: EmployeeProfile;
  target: TargetOutcome;
}

/** Assign each employee a target bucket for `rateKey` at the measure's BASE rate (the default path). */
export function seededDistribution(employees: readonly EmployeeProfile[], rateKey: string): SeededAssignment[] {
  return seededDistributionAtRate(employees, rateKey, complianceRate(rateKey));
}

/**
 * Assign each employee a target bucket for `rateKey` at an EXPLICIT compliance `rate`, in the
 * Java order + proportions. This is the rate-parameterized body extracted from `seededDistribution`
 * (which now calls it with `complianceRate(rateKey)`, so existing callers are unchanged). The
 * synthetic trend-history backfill passes a per-week rate (`historicalComplianceRate(...)`) so each
 * backdated run varies its compliant fraction around the base rate.
 */
export function seededDistributionAtRate(
  employees: readonly EmployeeProfile[],
  rateKey: string,
  rate: number,
): SeededAssignment[] {
  const ordered = orderedEmployees(employees, rateKey);
  const n = ordered.length;
  const compliant = Math.max(0, Math.min(n, Math.round(n * rate)));
  const excluded = Math.min(EXCLUDED_COUNT, Math.max(0, n - compliant));
  const missing = Math.min(MISSING_DATA_COUNT, Math.max(0, n - compliant - excluded));
  const remaining = Math.max(0, n - compliant - excluded - missing);
  const dueSoon = Math.trunc(remaining / 2);

  return ordered.map((employee, i) => {
    let target: TargetOutcome;
    if (i < compliant) target = "COMPLIANT";
    else if (i < compliant + excluded) target = "EXCLUDED";
    else if (i < compliant + excluded + missing) target = "MISSING_DATA";
    else if (i < compliant + excluded + missing + dueSoon) target = "DUE_SOON";
    else target = "OVERDUE";
    return { employee, target };
  });
}

/** The single target bucket a given employee falls into for `rateKey` (employee-scoped runs). */
export function seededTargetFor(employees: readonly EmployeeProfile[], rateKey: string, externalId: string): TargetOutcome | null {
  return seededDistribution(employees, rateKey).find((a) => a.employee.externalId === externalId)?.target ?? null;
}
