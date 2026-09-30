/**
 * Test support (#727): the ORACLE for the MADiE end-to-end test — what WorkWell should show for a
 * steward test patient, written from the specification (the population table in #727 and the QI-Core
 * Measure IG's membership rules), never by calling `outcomeFromPopulations` or `normalizeMembership`,
 * so the test checks the code against the rule rather than against itself. Pure; no app imports.
 */
import type { PopulationCounts } from "../standards/official-cases.ts";

/** CMS122 counts POOR control, so being in its numerator is the gap (`official-measure-semantics.ts`). */
export const NUMERATOR_IS_THE_GAP = new Set<string>(["cms122"]);

// ── The oracle ───────────────────────────────────────────────────────────────────────────────────────

export type DisplayStatus = "COMPLIANT" | "OVERDUE" | "EXCLUDED" | "OUT_OF_POPULATION";

/** The steward's populations for one rate, as booleans, normalised the way the QI-Core IG scores them. */
export interface Membership {
  ipp: boolean;
  denom: boolean;
  denex: boolean;
  numer: boolean;
  denexcep: boolean;
}

/**
 * A rate's membership as the eCQM counts it: an excluded patient is not scored in the numerator, and an
 * exception applies only to a patient who did not meet the numerator (QI-Core Measure IG, "Denominator
 * Membership" / "Numerator Membership").
 */
export function membershipOf(counts: PopulationCounts): Membership {
  const ipp = counts["initial-population"] > 0;
  const denom = counts.denominator > 0;
  const denex = counts["denominator-exclusion"] > 0;
  const numerRaw = counts.numerator > 0;
  const denexcepRaw = counts["denominator-exception"] > 0;
  return { ipp, denom, denex, numer: numerRaw && !denex, denexcep: denexcepRaw && !denex && !numerRaw };
}

/**
 * One rate's display status, from the population table in #727, read through `membershipOf` so the
 * status and the rate can never disagree about the same patient: a patient who met the numerator is
 * not an exception (the IG), so they are scored, not excluded. No steward deck holds that shape today;
 * see the evidence file's "Not covered".
 */
export function rateStatus(measure: string, counts: PopulationCounts): DisplayStatus {
  const m = membershipOf(counts);
  if (!m.ipp) return "OUT_OF_POPULATION";
  if (!m.denom || m.denex || m.denexcep) return "EXCLUDED";
  const gap = NUMERATOR_IS_THE_GAP.has(measure) ? m.numer : !m.numer;
  return gap ? "OVERDUE" : "COMPLIANT";
}

/** Worst first. A multi-rate patient shows the worst result across the rates they are in. */
const SEVERITY: Record<Exclude<DisplayStatus, "OUT_OF_POPULATION">, number> = { OVERDUE: 2, COMPLIANT: 1, EXCLUDED: 0 };

export function expectedStatus(measure: string, rates: readonly PopulationCounts[]): DisplayStatus {
  const inPopulation = rates.map((r) => rateStatus(measure, r)).filter((s): s is Exclude<DisplayStatus, "OUT_OF_POPULATION"> => s !== "OUT_OF_POPULATION");
  if (inPopulation.length === 0) return "OUT_OF_POPULATION";
  return inPopulation.reduce((worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst));
}

/** The case a status leaves: a gap opens one, an exclusion records a closed one, the rest none. */
export function expectedCase(status: DisplayStatus): { status: string } | null {
  if (status === "OVERDUE") return { status: "OPEN" };
  if (status === "EXCLUDED") return { status: "EXCLUDED" };
  return null;
}
