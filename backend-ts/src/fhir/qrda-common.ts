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
 * WorkWell's own identifier domains, as CDA `@root` values.
 *
 * **These are UUIDs because CDA's `II.root` is typed `uid` — the union of `oid`, `uuid` and `ruid` —
 * and a URN is none of them.** They used to be `urn:workwell:employee` / `:device` / `:custodian` /
 * `:fhir`, which Cypress CVU+ 7.5.1 rejected 56 times across the 10 Category I documents on 2026-08-02:
 * `Element 'id', attribute 'root': 'urn:workwell:employee' is not a valid value of the union type
 * '{urn:hl7-org:v3}uid'` (`docs/evidence/CVU_VALIDATION_RUN_2026-08-02.md` §5.2).
 *
 * A UUID rather than an OID arc is a deliberate choice, not a shortcut: WorkWell holds no registered
 * OID arc, and asserting an unregistered OID would be a false claim of a registered identity — strictly
 * worse than a UUID, which asserts a private domain and nothing more. If MIE assigns an arc later,
 * these four constants are the only place that changes.
 *
 * **They are generated ONCE and hardcoded.** A per-run `randomUUID()` here would make every export
 * declare a different identifier domain for the same employee, which is the opposite of what a root
 * means — and it would still pass the schema, so nothing would catch it.
 *
 * `urn:workwell:measure` is deliberately NOT in this list: it appears as an `<id>` root on the
 * authored-measure fallback path, where the document is already structurally non-conformant by design
 * (ADR-046 decision 3 forbids inventing a published eMeasure identity, and QRDA I is a format for
 * reporting PUBLISHED eCQMs). Giving it a valid-looking UUID would hide that, not fix it.
 */
export const EMPLOYEE_ID_ROOT = "2dc2e375-2167-48e8-8ea2-548182034ec4";
export const DEVICE_ID_ROOT = "676424fb-bdac-4f5e-904a-1d7858834650";
export const CUSTODIAN_ID_ROOT = "e23d2ca4-6837-4ac9-8032-9735b960c3e9";
export const FHIR_RESOURCE_ID_ROOT = "1e66ef3d-8340-46fc-a8fe-b2171b404a43";

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
  const versionNumber = cdaVersionNumber(official.version);
  return [
    `<id root="${EMEASURE_ID_ROOT}" extension="${esc(ids.versionSpecific)}"/>`,
    ids.versionIndependent ? `\n${indent}<setId root="${esc(ids.versionIndependent)}"/>` : "",
    versionNumber === null ? "" : `\n${indent}<versionNumber value="${versionNumber}"/>`,
  ].join("");
}

/**
 * CDA's `versionNumber` is an `INT`. We were emitting the eCQM version STRING into it — `1.0.000` —
 * which Cypress CVU+ rejects on all 10 Category I documents and both Category III documents:
 * `Element 'versionNumber', attribute 'value': '1.0.000' is not a valid value of the atomic type
 * '{urn:hl7-org:v3}int'` (measured 2026-08-02, `docs/evidence/CVU_VALIDATION_RUN_2026-08-02.md` §5.2).
 * Correct as identity, wrong as a type.
 *
 * The MAJOR component is the eCQM's integer version, which is what the element means. Nothing is lost
 * by narrowing: the exact version is already pinned by the version-specific eMeasure UUID in `<id>`,
 * and the version-independent one in `<setId>` — this element is supplementary to both.
 *
 * Returns `null` rather than guessing when the version does not begin with digits, so an unparseable
 * version omits an optional element instead of emitting an invalid one. Omitting is conformant;
 * emitting `1.0.000` was not.
 */
export function cdaVersionNumber(version: string | undefined): string | null {
  if (!version) return null;
  const major = /^(\d+)/.exec(version.trim());
  return major ? String(Number(major[1])) : null;
}
