/**
 * Per-measure target compliance rates (#107) — the synthetic distribution's compliant
 * fraction, mirroring `workwell.evaluation.compliance-rates` in the Java application.yml.
 * Unconfigured measures (e.g. CMS eCQM) fall back to 0.80, matching the Java default.
 */
const COMPLIANCE_RATES: Record<string, number> = {
  audiogram: 0.78,
  tb_surveillance: 0.91,
  hazwoper: 0.65,
  flu_vaccine: 0.84,
  hypertension: 0.72,
  diabetes_hba1c: 0.68,
  obesity_bmi: 0.81,
  cholesterol_ldl: 0.74,
};

export const DEFAULT_COMPLIANCE_RATE = 0.8;

export function complianceRate(rateKey: string): number {
  return COMPLIANCE_RATES[rateKey] ?? DEFAULT_COMPLIANCE_RATE;
}

/** Primary trend amplitude: each historical week oscillates ~±0.09 around the measure's base rate. */
const HISTORY_AMPLITUDE = 0.09;
/** Secondary (higher-frequency) harmonic that adds believable texture so the line isn't a clean sine. */
const HISTORY_AMPLITUDE2 = 0.03;
/** Clamp bounds for a believable compliance line. */
const HISTORY_MIN = 0.4;
const HISTORY_MAX = 0.99;

/**
 * Java `String.hashCode` (32-bit, overflowing) — duplicated here (also in distribution.ts) to keep
 * this module dependency-free; used only to derive a per-measure oscillation phase.
 */
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * A believable, week-to-week compliance rate for the synthetic TREND HISTORY backfill
 * (`run/backfill-trend-history.ts`). PURE + deterministic — NO `Math.random`. The phase is
 * seeded from `hashCode(rateKey)` (shape AND a small phase offset, so measures sharing a base
 * rate still differ) so each measure has its own wave, and the oscillation is anchored so the
 * NEWEST historical week (`weekIndex === totalWeeks - 1`) lands ≈ the measure's base rate (within
 * ~0.013) — i.e. continuous with the current real run. Earlier weeks oscillate
 * ~±{@link HISTORY_AMPLITUDE} (+ a smaller secondary harmonic) around the base, then clamped to
 * [{@link HISTORY_MIN}, {@link HISTORY_MAX}].
 *
 * @param weekIndex  0 = oldest week, `totalWeeks - 1` = newest.
 */
export function historicalComplianceRate(rateKey: string, weekIndex: number, totalWeeks: number): number {
  const base = complianceRate(rateKey);
  const weeks = Math.max(1, totalWeeks);
  const newest = weeks - 1;
  // Per-measure shape: a stretch (frequency) + a sign, both seeded from the rateKey hash so each
  // measure has its own wave. The oscillation is anchored at the newest week with no phase offset
  // (`sin((w - newest) * stretch)`), so the newest week lands exactly on `base` (sin 0 = 0 →
  // continuous with the current real run) and every earlier week stays within ±HISTORY_AMPLITUDE.
  const h = hashCode(rateKey);
  const stretch = 0.5 + (((Math.trunc(h / 7) % 5) + 5) % 5) * 0.2; // [0.5, 1.3] rad/week
  const sign = h % 2 === 0 ? 1 : -1;
  // Small per-measure phase offset in [-0.15, 0.15] rad so measures that share a base rate
  // (e.g. cms125 and adult_immunization, both 0.80) still get distinct wave shapes rather than
  // byte-identical curves. Kept ≤ 0.15 rad so the newest week stays within
  // HISTORY_AMPLITUDE·sin(0.15) ≈ 0.0134 of `base` — i.e. still ≈ base (continuous with the
  // current real run), within the ±0.02 newest-week tolerance even at the higher amplitude.
  const phase = ((((h % 7) + 7) % 7) - 3) * 0.05; // [-0.15, 0.15] rad
  // Two anchored harmonics. At weekIndex === newest the primary argument is `phase` and the
  // secondary argument is 0, so the newest-week deviation is HISTORY_AMPLITUDE·sin(phase) (≤ ~0.0134);
  // |sin| ≤ 1 keeps every earlier week within ±(HISTORY_AMPLITUDE + HISTORY_AMPLITUDE2) of base. The
  // secondary harmonic runs at ~2.3× the primary frequency, giving the line texture rather than a
  // clean sine.
  const value =
    base +
    sign * HISTORY_AMPLITUDE * Math.sin((weekIndex - newest) * stretch + phase) +
    sign * HISTORY_AMPLITUDE2 * Math.sin((weekIndex - newest) * stretch * 2.3);
  return Math.min(HISTORY_MAX, Math.max(HISTORY_MIN, value));
}
