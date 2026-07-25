/**
 * Which measures are evaluated by the OFFICIAL published CQL artifact rather than WorkWell's authored
 * CQL (roadmap §7.2). PR-7 adds the executor that reads this to route evaluation; this module lands
 * first, in PR-3, because the EXPORTERS must already branch on it — see below.
 *
 * `WORKWELL_OFFICIAL_MEASURES` is an explicit comma-separated allowlist, never "all": every flip is a
 * deliberate per-measure act gated on a green MADiE test-case run.
 *
 * **Why the exporters need this now.** The bounded `GROUP BY status` histogram behind summary
 * MeasureReport + QRDA III carries no per-subject evidence, so it cannot see
 * `evidence_json.official.populationResults` and necessarily derives populations from the WORKFLOW
 * status. For a lower-is-better measure that is the logical inverse of the official numerator
 * (cms122's numerator is poor glycemic control), so at the flip the summary and the per-subject
 * bundle would report opposite numerators for the same run — and QRDA III, the artifact the M-B
 * Cypress/CVU+ loop validates, would carry the status-derived numbers. Routing official measures to
 * the evidence-aware row path closes that before it can happen.
 *
 * Unset/blank (the demo stack and every environment today) ⇒ empty set ⇒ every read path is
 * byte-identical to before.
 */
export interface OfficialMeasuresEnv {
  WORKWELL_OFFICIAL_MEASURES?: string | undefined;
}

/**
 * The seam-inventory predicate, in the shape §10 of ARCHITECTURE requires: the boot line must call the
 * SAME function the routing decision calls, never a second parse of the same variable.
 */
export function isOfficialRoutingConfigured(env: OfficialMeasuresEnv): boolean {
  return officialMeasureIds(env as Record<string, unknown>).size > 0;
}

export function officialMeasureIds(env: Record<string, unknown> = process.env): ReadonlySet<string> {
  const raw = env["WORKWELL_OFFICIAL_MEASURES"];
  if (typeof raw !== "string") return new Set();
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/** True when this measure's outcomes are produced by the official executor (and carry official evidence). */
export function isOfficialRouted(measureId: string, env: Record<string, unknown> = process.env): boolean {
  return officialMeasureIds(env).has(measureId);
}

/**
 * THE RULE (roadmap §7.4 PR-6), enforced at the edge it is actually about: a measure may not be routed
 * to official execution unless the official MADiE test-case gate covers it. `official-gate.test.ts`
 * keeps the gated set equal to the vendored set; this keeps the OPERATOR from naming anything outside it.
 *
 * Returns the offending ids. An empty array means the configuration is legal. Callers decide how loudly
 * to fail — PR-7's router throws at construction, because a typo'd flag that silently serves authored
 * results while claiming to be official is precisely the failure this whole milestone exists to avoid.
 */
export function ungatedOfficialMeasures(
  gatedMeasureIds: readonly string[],
  env: Record<string, unknown> = process.env,
): string[] {
  const gated = new Set(gatedMeasureIds);
  return [...officialMeasureIds(env)].filter((id) => !gated.has(id)).sort();
}
