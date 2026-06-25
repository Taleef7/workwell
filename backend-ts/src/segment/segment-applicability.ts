/**
 * Segment applicability engine (#183 E11.3) — the SINGLE definition of "does this measure apply to
 * this employee under the configured segments?". Pure, no I/O. Consumed by the roster read model
 * (N/A overlay + segment filter) and the run pipeline (case-creation gate). Applicability never
 * decides compliance — CQL Outcome Status is unchanged (ADR-008/ADR-016).
 */
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { HydratedSegment, SegmentRule, SegmentCondition } from "../stores/segment-store.ts";

/** Evaluate a cohort predicate over an employee's role/site (case-insensitive). Empty ⇒ matches nobody. */
export function matchesRule(emp: EmployeeProfile, rule: SegmentRule): boolean {
  const conditions = rule.conditions ?? [];
  if (conditions.length === 0) return false;
  const testOne = (c: SegmentCondition): boolean => {
    const attr = (c.attr === "site" ? emp.site : emp.role).toLowerCase();
    if (c.op === "equals") return typeof c.value === "string" && attr === c.value.toLowerCase();
    if (c.op === "contains") return typeof c.value === "string" && attr.includes(c.value.toLowerCase());
    if (c.op === "in") return Array.isArray(c.value) && c.value.some((v) => attr === String(v).toLowerCase());
    return false;
  };
  return rule.match === "ALL" ? conditions.every(testOne) : conditions.some(testOne);
}

/** Cohort membership = rule match, with per-employee overrides. EXCLUDE wins over INCLUDE
 *  unconditionally — independent of override ordering or any upstream duplicate entry. */
export function matchesCohort(emp: EmployeeProfile, segment: HydratedSegment): boolean {
  const mine = segment.overrides.filter((o) => o.externalId === emp.externalId);
  if (mine.some((o) => o.mode === "EXCLUDE")) return false;
  if (mine.some((o) => o.mode === "INCLUDE")) return true;
  return matchesRule(emp, segment.rule);
}

/** Union of the rule-sets of every ENABLED segment the employee belongs to. */
export function applicableMeasures(emp: EmployeeProfile, segments: HydratedSegment[]): Set<string> {
  const out = new Set<string>();
  for (const s of segments) {
    if (!s.enabled) continue;
    if (matchesCohort(emp, s)) for (const m of s.measureIds) out.add(m);
  }
  return out;
}

/** True if the measure applies to the employee. Reversibility: zero ENABLED segments ⇒ always true. */
export function isApplicable(emp: EmployeeProfile, measureId: string, segments: HydratedSegment[]): boolean {
  if (!segments.some((s) => s.enabled)) return true;
  return applicableMeasures(emp, segments).has(measureId);
}
