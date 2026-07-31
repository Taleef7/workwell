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

/**
 * XML-escape a value for text or an attribute.
 *
 * Coerces rather than assuming a string: these values now come from third-party FHIR, where a numeric
 * `id` or `code` deserializes as a number and `s.replace is not a function` would take down an entire
 * export (review, #361). Coercion is safe because every call site interpolates into XML anyway.
 */
export const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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

/**
 * `hl7Ts` for values that came from OUTSIDE — returns null instead of throwing.
 *
 * `hl7Ts` throws on purpose: a run's own measurement period producing `NaN` in a regulatory artifact
 * should fail loudly at build time. But QDM entries are translated from third-party FHIR, where a
 * MariaDB zero-date (`0000-00-00`) or a malformed string is a data-quality event, not a programming
 * error — and throwing there would lose every OTHER subject's document too. The caller degrades that
 * one field to `nullFlavor` instead.
 */
export const hl7TsOrNull = (iso: unknown): string | null => {
  if (typeof iso !== "string" || iso === "") return null;
  try {
    return hl7Ts(iso);
  } catch {
    return null;
  }
};

/**
 * The measure reference both QRDA documents emit — ONE implementation, because they describe the same
 * run and a divergence between them reads as a validation finding nobody caused.
 *
 * Two failure modes it exists to close, both found by Codex on #360:
 *
 *  - **A missing artifact must not crash the export.** The first version passed `{}` in place of a
 *    `null` artifact and then read `artifact.bundle` off it, so exporting a historical outcome whose
 *    artifact had since been removed turned the endpoint into a 500.
 *  - **A re-vendored artifact must not relabel an old outcome.** The identity is claimed only when the
 *    vendored artifact's `sha256` matches the `artifactSha256` the outcome was scored under — the same
 *    rule ADR-046 decision 3 applies to MeasureReport's canonical, which this path had not carried over.
 *    Otherwise it falls back to a version-qualified local id: less pretty, and true.
 */
export function qrdaMeasureReference(
  measureId: string,
  official: { version?: string; artifactSha256?: string } | null,
  artifact: { manifest: { sha256: string }; bundle: unknown } | null,
  identifiers: (a: never) => { versionSpecific?: string; versionIndependent?: string },
  indent: string,
): string {
  if (!official) return `<id root="urn:workwell:measure" extension="${esc(measureId)}"/>`;
  const shaMatches = artifact && (!official.artifactSha256 || artifact.manifest.sha256 === official.artifactSha256);
  const ids = shaMatches ? identifiers(artifact as never) : {};
  if (!ids.versionSpecific) {
    // Version-qualified so the document still names WHICH official run produced it, without asserting a
    // published identity this outcome may not have been scored by.
    return `<id root="urn:workwell:measure" extension="${esc(measureId)}${
      official.version ? `:official:${esc(official.version)}` : ""
    }"/>`;
  }
  return [
    `<id root="${EMEASURE_ID_ROOT}" extension="${esc(ids.versionSpecific)}"/>`,
    ids.versionIndependent ? `\n${indent}<setId root="${esc(ids.versionIndependent)}"/>` : "",
    official.version ? `\n${indent}<versionNumber value="${esc(official.version)}"/>` : "",
  ].join("");
}
