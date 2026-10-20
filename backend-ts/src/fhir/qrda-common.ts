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
import { scoredByCurrentLogic } from "../measure/measure-identity.ts";
import type { OfficialManifest } from "../wiring/official-artifacts.ts";

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
 * The root a QRDA III Measure Data observation references a population CRITERION under
 * (CONF:3259-18239/18241). Its `extension` is the published `Measure.group.population.id` for an
 * official measure — so the root says whose identifier scheme this is (ours) and the extension says
 * which criterion (CMS's). Kept distinct from `FHIR_RESOURCE_ID_ROOT`, which identifies a clinical
 * RESOURCE in a patient's data: conflating a measure-definition element with patient data under one
 * root would make two different things indistinguishable to a receiver.
 */
export const MEASURE_CRITERION_ID_ROOT = "9f3b1c07-2e5a-4d18-b6a4-70c9e8d5a231";

/**
 * XML-escape a value for text or an attribute.
 *
 * Coerces rather than assuming a string: these values now come from third-party FHIR, where a numeric
 * `id` or `code` deserializes as a number and `s.replace is not a function` would take down an entire
 * export (review, #361). Coercion is safe because every call site interpolates into XML anyway.
 */
export const esc = (s: unknown): string =>
  String(s ?? "")
    // XML 1.0 forbids the C0 control characters but tab, LF and CR, even escaped: one left in made the
    // document not well-formed, and since #791 it could also forge an export's time placeholder (review).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

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

/** A FHIR date or dateTime from OUTSIDE, as an HL7 TS states it (`statedHl7Time`). */
export interface StatedHl7Time {
  /** The digits as stated, at the stated precision: `2025`, `202506`, `20250601`, `202506011000`, `20250601100000.25`. */
  digits: string;
  /** Whether it states a time of day: only then can it carry an offset. */
  hasTime: boolean;
  /** The stated zone as an HL7 offset (`Z` is `+0000`), or undefined when none is stated. */
  offset?: string;
  /** For ordering: the first instant it covers, in ms since the epoch (UTC when no zone is stated), and its fraction. */
  epochMs: number;
  fraction: string;
}

const FHIR_TIME =
  /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))?)?)?)?$/;

/**
 * A FHIR date or dateTime from OUTSIDE as an HL7 TS, exactly as stated, or null when it is not a real one (#791).
 *
 * Third-party values are written at the precision they state: a year stays `2025` and a month `202506`,
 * never an instant at midnight on the 1st. The date and time must be real as written (30 February is
 * refused, not rolled over to 2 March), the year 0001-9999, an offset no wider than ±14:00 with minutes
 * under 60, and at most nine digits of a second. A time with no zone is written as stated, never read in
 * the exporting machine's zone. A null degrades that one field to `nullFlavor` rather than losing every
 * other subject's document (#361).
 *
 * Whether the offset is written is the document's choice (CMS_0121: offsets everywhere or nowhere), so it
 * is returned beside the digits rather than in them.
 */
export function statedHl7Time(iso: unknown): StatedHl7Time | null {
  const m = typeof iso === "string" ? FHIR_TIME.exec(iso) : null;
  if (!m) return null;
  const [, y, mo, d, h, mi, s, fraction, zone, sign, oh, om] = m;
  const year = Number(y);
  if (year < 1) return null;
  const parts = [year, Number(mo ?? 1), Number(d ?? 1), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0)] as const;
  // `setUTCFullYear`, not `Date.UTC`, which reads the years 0-99 as 1900-1999.
  const check = new Date(0);
  check.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  check.setUTCHours(parts[3], parts[4], parts[5], 0);
  const real = [check.getUTCFullYear(), check.getUTCMonth() + 1, check.getUTCDate(), check.getUTCHours(), check.getUTCMinutes(), check.getUTCSeconds()];
  if (real.some((part, i) => part !== parts[i])) return null;
  let offsetMinutes = 0;
  if (sign !== undefined) {
    offsetMinutes = (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om));
    if (Number(om) > 59 || Math.abs(offsetMinutes) > 14 * 60) return null;
  }
  const digits = `${y}${mo ?? ""}${d ?? ""}${h ?? ""}${mi ?? ""}${s ?? ""}${fraction !== undefined ? `.${fraction}` : ""}`;
  return {
    digits,
    hasTime: h !== undefined,
    ...(zone !== undefined ? { offset: zone === "Z" ? "+0000" : `${sign}${oh}${om}` } : {}),
    epochMs: check.getTime() - offsetMinutes * 60_000,
    fraction: fraction ?? "",
  };
}

/**
 * A FHIR date as an HL7 date at its stated precision, or null. A birth date has no time of day; one written
 * with a time anyway keeps the date it states, never the UTC one.
 */
export const hl7DateAsStated = (date: unknown): string | null => {
  const t = statedHl7Time(date);
  return t === null ? null : t.hasTime ? t.digits.slice(0, 8) : t.digits;
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
 *    outcome was scored by the vendored artifact's LOGIC (`scoredByCurrentLogic`): its own bytes, or an
 *    earlier vendoring with the same `logicSha256` (#848) — the rule MeasureReport's canonical applies
 *    too (ADR-046 decision 3). Otherwise it falls back to a version-qualified local id: less pretty, and true.
 */
export function qrdaMeasureReference(
  measureId: string,
  official: { kind?: "derived"; version?: string; artifactSha256?: string } | null,
  artifact: { manifest: Pick<OfficialManifest, "catalogId" | "sha256" | "logicSha256">; bundle: unknown } | null,
  identifiers: (a: never) => { versionSpecific?: string; versionIndependent?: string },
  indent: string,
): string {
  // The routes refuse a translated run before building a document; this is the backstop. QRDA names a
  // measure by CMS's eMeasure identity, which a WorkWell translation may not carry (LOCKED §4.3), and the
  // fallback below would call it `:official:`.
  if (official?.kind === "derived") {
    throw new Error(`${measureId}: a WorkWell translation has no QRDA measure identity; refuse the export before reaching here`);
  }
  if (!official) return `<id root="urn:workwell:measure" extension="${esc(measureId)}"/>`;
  const sameLogic = artifact && (!official.artifactSha256 || scoredByCurrentLogic(artifact.manifest, official.artifactSha256));
  const ids = sameLogic ? identifiers(artifact as never) : {};
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
  if (!major) return null;
  // Strip leading zeros TEXTUALLY. The obvious `String(Number(major[1]))` normalizes "007" to "7"
  // correctly but turns a 22-digit version into "1e+21" — exponential notation, which is not a valid
  // CDA INT. A helper whose whole job is to guarantee a valid INT must not have an input that makes it
  // emit an invalid one, however unlikely that input is (found reviewing this function's own edge cases).
  return major[1]!.replace(/^0+(?=\d)/, "");
}
