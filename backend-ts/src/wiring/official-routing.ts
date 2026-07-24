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
