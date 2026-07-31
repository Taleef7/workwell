/**
 * CDA primitives shared by the QRDA Category I and Category III exporters (M-B).
 *
 * Extracted rather than duplicated because the two documents describe the SAME run and are compared
 * against each other by the certification loop: a timestamp or escaping rule that drifts between them
 * would show up as a validation difference nobody meant to introduce.
 *
 * Hand-built XML, balanced by construction — no CDA runtime and no new dependency, matching the
 * existing `mat-export.ts` / `qrda3-export.ts` approach.
 */

/** CDA/HL7 code systems used by both documents. */
export const LOINC = "2.16.840.1.113883.6.1";
export const ACT = "2.16.840.1.113883.5.4";
export const OBS_CAT = "2.16.840.1.113883.5.4";
/** The eMeasure Identifier root a QRDA measure reference is keyed on. */
export const EMEASURE_ID_ROOT = "2.16.840.1.113883.4.738";

export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * ISO-8601 → HL7 `YYYYMMDDHHMMSS`, in UTC.
 *
 * Throws on an unparseable input rather than emitting `NaN` into a regulatory artifact — a document
 * that validates structurally while carrying a nonsense effectiveTime is worse than one that fails
 * loudly at build time.
 */
export const hl7Ts = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid ISO date for QRDA effectiveTime: ${iso}`);
  const p = (x: number) => String(x).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
};

/** ISO date → HL7 `YYYYMMDD` (a birth date carries no time of day). */
export const hl7Date = (iso: string): string => hl7Ts(iso).slice(0, 8);
