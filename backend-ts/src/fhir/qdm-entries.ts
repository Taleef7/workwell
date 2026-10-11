/**
 * FHIR R4 → QDM CDA entries for the QRDA Category I Patient Data section (M-B).
 *
 * ## Why this exists
 *
 * QRDA Category I is a PATIENT DATA document. Measured against the RY2026 Schematron, the Patient Data
 * Section QDM SHALL contain at least one entry (CONF:67-14567) — so a document that reports only which
 * populations a subject landed in is not a reduced QRDA I, it is not a QRDA I at all. That is the
 * finding that reshaped ADR-049 into ADR-050: no CMS sample file contains a single `IPOP`/`DENOM`/
 * `NUMER`/`MSRAGG`, because the receiving engine RECALCULATES from these entries rather than being told
 * the answer. §170.315(c)(2) is literally "import and calculate".
 *
 * ## Scope
 *
 * The five QDM datatypes CMS122 and CMS125 consume, and nothing speculative:
 *
 *   | FHIR                              | QDM datatype               | template                         |
 *   |-----------------------------------|----------------------------|----------------------------------|
 *   | `Encounter`                       | Encounter, Performed       | …22.4.49@2015-08-01 + …24.3.23   |
 *   | `Condition`                       | Diagnosis                  | …22.4.4@2015-08-01  + …24.3.135  |
 *   | `Observation` (laboratory)        | Laboratory Test, Performed | …24.3.38@2021-08-01              |
 *   | `Observation` (imaging)           | Diagnostic Study, Performed| …24.3.18@2021-08-01              |
 *   | `Procedure`                       | Procedure, Performed       | …22.4.14@2014-06-09 + …24.3.64   |
 *
 * An `Observation` routes on `category` — the same discriminator CMS125's official numerator uses
 * (`Status.isDiagnosticStudyPerformed` requires `category ~ imaging`), which is why ADR-044's crosswalk
 * dual-stamps it. A resource we cannot classify is SKIPPED rather than guessed into the nearest
 * datatype: a Diagnosis that was really a lab result is worse for a recalculating receiver than an
 * absent entry, because absent is visible and wrong-datatype is not.
 *
 * ## Translation, not authorship
 *
 * Every field here is read off a FHIR resource that the engine actually evaluated. Nothing is defaulted
 * into existence — no invented codes, no assumed dates, no synthesized status. Where FHIR carries no
 * value for a required CDA element the entry uses `nullFlavor`, and where the resource cannot support a
 * datatype at all it is dropped. This is ADR-037's normalization rule applied at the QRDA boundary, and
 * it is the same reason QDM appears ONLY here and never in the evaluation path (locked decision: the
 * FHIR/QI-Core column is what we execute; QDM is a translation at the reporting edge).
 */
import { FHIR_RESOURCE_ID_ROOT, LOINC, esc, hl7TsOrNull } from "./qrda-common.ts";
import { loincCodesOf } from "../wiring/qicore-preparation.ts";

/** Code systems a QDM entry can carry. Keyed by FHIR system URL — the only mapping direction we need. */
const CODE_SYSTEMS: Record<string, { oid: string; name: string }> = {
  "http://snomed.info/sct": { oid: "2.16.840.1.113883.6.96", name: "SNOMEDCT" },
  "http://loinc.org": { oid: LOINC, name: "LOINC" },
  "http://www.ama-assn.org/go/cpt": { oid: "2.16.840.1.113883.6.12", name: "CPT" },
  "http://hl7.org/fhir/sid/icd-10-cm": { oid: "2.16.840.1.113883.6.90", name: "ICD10CM" },
  "http://hl7.org/fhir/sid/icd-9-cm": { oid: "2.16.840.1.113883.6.103", name: "ICD9CM" },
  // Three spellings of HCPCS, all mapping to the one OID. The CMS URL is what the official artifacts'
  // vendored expansions use and what `qrda1-import.ts` now produces; the other two are what our own
  // crosswalk and older bundles carry. Missing the CMS one would silently drop an HCPCS-only entry from
  // a re-exported document (review, #388).
  "http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets": { oid: "2.16.840.1.113883.6.285", name: "HCPCS" },
  "urn:oid:2.16.840.1.113883.6.285": { oid: "2.16.840.1.113883.6.285", name: "HCPCS" },
  "https://bluebutton.cms.gov/resources/codesystem/hcpcs": { oid: "2.16.840.1.113883.6.285", name: "HCPCS" },
  "http://www.cms.gov/Medicare/Coding/ICD10": { oid: "2.16.840.1.113883.6.4", name: "ICD10PCS" },
  "http://www.nlm.nih.gov/research/umls/rxnorm": { oid: "2.16.840.1.113883.6.88", name: "RXNORM" },
  "http://terminology.hl7.org/CodeSystem/v3-ActCode": { oid: "2.16.840.1.113883.5.4", name: "ActCode" },
};

interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
}
interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}
interface FhirResource {
  resourceType?: string;
  id?: string;
  status?: string;
  code?: FhirCodeableConcept;
  /** Condition and Procedure: QDM "Anatomical Location Site" (#784). */
  bodySite?: FhirCodeableConcept[];
  category?: FhirCodeableConcept | FhirCodeableConcept[];
  type?: FhirCodeableConcept[];
  subject?: { reference?: string };
  patient?: { reference?: string };
  effectiveDateTime?: string;
  effectivePeriod?: { start?: string; end?: string };
  /** Observation's other two `effective[x]` types; only a blood pressure reads them (#787). */
  effectiveInstant?: string;
  effectiveTiming?: unknown;
  /** Observation fields a blood-pressure reading writes (`method`) or names as not written (#787). */
  method?: FhirCodeableConcept | FhirCodeableConcept[];
  performer?: unknown;
  encounter?: unknown;
  performedDateTime?: string;
  performedPeriod?: { start?: string; end?: string };
  period?: { start?: string; end?: string };
  onsetDateTime?: string;
  onsetPeriod?: { start?: string; end?: string };
  abatementDateTime?: string;
  /** `Condition` carries no `status`; retraction lives here (review, #361). */
  verificationStatus?: FhirCodeableConcept;
  issued?: string;
  valueQuantity?: { value?: number; unit?: string };
  valueCodeableConcept?: FhirCodeableConcept;
  /** A blood-pressure panel's systolic and diastolic readings (#591). */
  identifier?: Array<{ system?: string; value?: string }>;
  component?: Array<{
    code?: FhirCodeableConcept;
    valueQuantity?: { value?: number; unit?: string; code?: string; system?: string; comparator?: string };
  }>;
}

/** The attribute string of every coding we can map, in order. */
function cdaCodes(concept: FhirCodeableConcept | undefined): string[] {
  const codes: string[] = [];
  for (const coding of concept?.coding ?? []) {
    const sys = coding.system ? CODE_SYSTEMS[coding.system] : undefined;
    if (!sys || !coding.code) continue;
    const display = coding.display ? ` displayName="${esc(coding.display)}"` : "";
    codes.push(`code="${esc(coding.code)}" codeSystem="${sys.oid}" codeSystemName="${sys.name}"${display}`);
  }
  return codes;
}

/** A `<code>`/`<value xsi:type="CD">` attribute string for the first coding we can map, else null. */
function cdaCode(concept: FhirCodeableConcept | undefined): string | null {
  return cdaCodes(concept)[0] ?? null;
}

/**
 * Each mappable `bodySite` as a `<targetSiteCode>` (QDM "Anatomical Location Site"), one per site, or ""
 * for none (#784). The import reads them back; CMS125 reads them in both years. Every mapped coding of a
 * site is kept: the first as the code, the rest as `<translation>`s, which the import reads back as
 * codings, so a measure matching a later coding still matches after a round trip (Codex, #785). A site
 * with no mappable coding is left out, as `cdaCode` leaves out any other.
 */
function targetSites(r: FhirResource, pad: string): string {
  return (r.bodySite ?? [])
    .map((site) => cdaCodes(site))
    .filter((codes) => codes.length > 0)
    .map(([first, ...rest]) =>
      rest.length === 0
        ? `\n${pad}<targetSiteCode ${first}/>`
        : `\n${pad}<targetSiteCode ${first}>${rest.map((t) => `\n${pad}  <translation ${t}/>`).join("")}\n${pad}</targetSiteCode>`,
    )
    .join("");
}

/**
 * The QDM "relevant period" for a resource, as CDA `<effectiveTime>`.
 *
 * `nullFlavor="NA"` on the high bound is the IG's own idiom for an interval that has not ended (the CMS
 * sample uses it for an ongoing diagnosis) — as against omitting `high`, which asserts nothing about
 * whether the interval is open.
 */
function effectiveTime(resource: FhirResource, indent: string, ts: (iso: unknown) => string | null = hl7TsOrNull): string {
  const period = resource.effectivePeriod ?? resource.performedPeriod ?? resource.period ?? resource.onsetPeriod;
  // Every date goes through the non-throwing conversion: these strings come from third-party FHIR, and a
  // MariaDB zero-date must degrade this ONE field rather than lose every subject's document (#361).
  const low = ts(period?.start ?? resource.effectiveDateTime ?? resource.performedDateTime ?? resource.onsetDateTime ?? resource.issued);
  const end = ts(period?.end ?? resource.abatementDateTime);
  const interval = period !== undefined || resource.resourceType === "Condition";

  if (low === null && end === null) {
    // ADR-038 recorded that Conditions arriving with no onset are handled INCONSISTENTLY by
    // `prevalenceInterval` — not merely conservatively. Saying "no information" is the honest encoding of
    // that, and it keeps the entry (and so the subject's diagnosis) in the document.
    return `<effectiveTime nullFlavor="UNK"/>`;
  }
  // Interval-typed: a period on any resource, and Diagnosis always — QDM types it as an interval even
  // when FHIR supplies only an onset instant, so it opens at that instant rather than collapsing.
  // `nullFlavor="NA"` on the high bound says the interval has not ended, which is what an active
  // diagnosis means; omitting `high` would assert nothing either way.
  if (interval || end !== null) {
    const lowEl = low !== null ? `<low value="${low}"/>` : `<low nullFlavor="UNK"/>`;
    const highEl = end !== null ? `<high value="${end}"/>` : `<high nullFlavor="NA"/>`;
    return `<effectiveTime>\n${indent}  ${lowEl}\n${indent}  ${highEl}\n${indent}</effectiveTime>`;
  }
  return `<effectiveTime value="${low}"/>`;
}

/**
 * A FHIR dateTime as a blood-pressure reading's HL7 timestamp, or null when it is not a real one.
 * - The date and time must be real as written: `Date` rolls 30 February over to 2 March and hour 24 into
 *   the next day, a time the panel never stated (Codex, #787).
 * - A time with a zone is written in UTC with no offset, as every entry in the document is (CMS_0121: a
 *   document states offsets everywhere or nowhere), always with a four-digit year: a UTC year outside
 *   0001-9999 has no HL7 form and is refused (review, #787).
 * - A time with no zone (the corpus writes its readings so) is written as stated; `Date` would read it in
 *   the exporting machine's own zone.
 * - The fraction is kept as written, trailing zeros included: two panels a fraction of a second apart
 *   written at the same whole second would come back as four readings at one instant, and `.000` is a
 *   precision the import compares (Codex + review, #787). An offset is whole minutes, so the fraction
 *   survives the move to UTC. More than nine digits of a second, or an offset FHIR cannot state (beyond
 *   ±14:00), is refused, as the import refuses it (review, #787).
 */
function hl7TsKeepingFraction(iso: unknown): string | null {
  const m = typeof iso === "string" ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-](\d{2}):(\d{2}))?$/.exec(iso) : null;
  if (!m) return null;
  if (m[9] !== undefined && (Number(m[10]) > 59 || Number(m[9]) * 60 + Number(m[10]) > 14 * 60)) return null;
  const stated = m.slice(1, 7).map((part) => part ?? "00");
  const [y, mo, d, h, mi, s] = stated.map(Number) as [number, number, number, number, number, number];
  // `setUTCFullYear`, not `Date.UTC`, which reads the years 0-99 as 1900-1999.
  const check = new Date(0);
  check.setUTCFullYear(y, mo - 1, d);
  check.setUTCHours(h, mi, s, 0);
  const real = [check.getUTCFullYear(), check.getUTCMonth() + 1, check.getUTCDate(), check.getUTCHours(), check.getUTCMinutes(), check.getUTCSeconds()];
  if (y < 1 || real.some((part, i) => part !== [y, mo, d, h, mi, s][i])) return null;
  let whole = stated.join("");
  if (m[8] !== undefined) {
    const utc = new Date(iso as string);
    if (Number.isNaN(utc.getTime()) || utc.getUTCFullYear() < 1 || utc.getUTCFullYear() > 9999) return null;
    const p = (n: number, width = 2) => String(n).padStart(width, "0");
    whole = `${p(utc.getUTCFullYear(), 4)}${p(utc.getUTCMonth() + 1)}${p(utc.getUTCDate())}${p(utc.getUTCHours())}${p(utc.getUTCMinutes())}${p(utc.getUTCSeconds())}`;
  }
  return m[7] !== undefined ? `${whole}.${m[7]}` : whole;
}

/** The FHIR `category` codings, flattened — `category` is 0..* on Observation but 0..1 in some shims. */
function categoryCodes(resource: FhirResource): string[] {
  const cats = Array.isArray(resource.category) ? resource.category : resource.category ? [resource.category] : [];
  return cats.flatMap((c) => (c.coding ?? []).map((coding) => coding.code ?? "").filter(Boolean));
}

/** A stable CDA `<id>` — the FHIR id when there is one, so two exports of one resource agree. */
function cdaId(resource: FhirResource, fallback: string): string {
  return `<id root="${FHIR_RESOURCE_ID_ROOT}" extension="${esc(resource.id ?? fallback)}"/>`;
}

/**
 * FHIR statuses that positively mean "this did not happen" or "this record is not valid".
 *
 * A *Performed* QDM datatype asserts the event occurred, and every entry this module emits carries
 * `statusCode="completed"`. Translating an `entered-in-error` mammogram into `Procedure, Performed`
 * hands a recalculating receiver an event WorkWell's own evaluation excludes — it could satisfy a
 * numerator off a retracted record (Codex, #361).
 *
 * This is a DENYLIST rather than an allowlist on purpose, and the choice is load-bearing. Real WebChart
 * data carries `status: "unknown"` on genuine clinical rows (measured on teatea — BP panels arrive
 * `unknown`), so an allowlist of `final`/`completed` would silently drop real events and make a receiver
 * recalculate LOW. Denying only the explicitly-negating statuses fails closed on retraction and open on
 * ambiguity, which is the right way round: a dropped real event is as wrong as an admitted retracted
 * one, and only one of the two is common in practice.
 */
const NEGATED_STATUSES = new Set(["entered-in-error", "not-done", "cancelled", "nullified", "abandoned"]);

/**
 * True when the resource's own status says the event did not happen or the record was retracted.
 *
 * `Condition` has **no `status` element** — retraction is `verificationStatus.coding.code`. Reading only
 * `status` meant a retracted diabetes diagnosis still became a `Diagnosis` with `statusCode="completed"`,
 * which is the datatype CMS122's denominator is built on: a guard that read as covering all four mapped
 * types while being structurally incapable of firing for one of them (review, #361).
 */
function isNegated(resource: FhirResource): boolean {
  if (typeof resource.status === "string" && NEGATED_STATUSES.has(resource.status)) return true;
  return (resource.verificationStatus?.coding ?? []).some((c) => c.code !== undefined && NEGATED_STATUSES.has(c.code));
}

/** QDM `statusCode` — `completed` is the only status a *Performed* datatype can carry. */
const COMPLETED = `<statusCode code="completed"/>`;

function encounterPerformed(r: FhirResource, i: number, pad: string): string | null {
  const code = cdaCode(r.type?.[0]) ?? cdaCode(r.code);
  if (!code) return null;
  return `${pad}<entry typeCode="DRIV">
${pad}  <encounter classCode="ENC" moodCode="EVN">
${pad}    <templateId root="2.16.840.1.113883.10.20.22.4.49" extension="2015-08-01"/>
${pad}    <templateId root="2.16.840.1.113883.10.20.24.3.23" extension="2021-08-01"/>
${pad}    ${cdaId(r, `encounter-${i}`)}
${pad}    <code ${code}/>
${pad}    ${COMPLETED}
${pad}    ${effectiveTime(r, `${pad}    `)}
${pad}  </encounter>
${pad}</entry>`;
}

/**
 * Diagnosis — wrapped in a **Diagnosis Concern Act**, which is a SHALL, not a nicety
 * (CONF:4509-28885: "This template SHALL be contained by a Diagnosis Concern Act (V5)"). A bare
 * Diagnosis observation is the shape this exporter first emitted and the Schematron rejected it.
 *
 * The `<code>` also SHALL carry exactly one `<translation>` (CONF:4509-28886) — the LOINC "diagnosis"
 * code with its SNOMED equivalent, both fixed by the IG. Neither is derived from the patient's data:
 * they say "this entry is a diagnosis", and the patient's actual condition is the `<value>`.
 */
function diagnosis(r: FhirResource, i: number, pad: string): string | null {
  const value = cdaCode(r.code);
  if (!value) return null;
  const when = effectiveTime(r, `${pad}      `);
  const low = /<low value="(\d+)"/.exec(when)?.[1];
  return `${pad}<entry typeCode="DRIV">
${pad}  <act classCode="ACT" moodCode="EVN">
${pad}    <templateId root="2.16.840.1.113883.10.20.22.4.3" extension="2015-08-01"/>
${pad}    <templateId root="2.16.840.1.113883.10.20.24.3.137" extension="2021-08-01"/>
${pad}    ${cdaId(r, `concern-${i}`)}
${pad}    <code code="CONC" codeSystem="2.16.840.1.113883.5.6" displayName="Concern"/>
${pad}    ${COMPLETED}
${pad}    <effectiveTime>
${pad}      ${low ? `<low value="${low}"/>` : `<low nullFlavor="UNK"/>`}
${pad}    </effectiveTime>
${pad}    <entryRelationship typeCode="SUBJ">
${pad}      <observation classCode="OBS" moodCode="EVN">
${pad}        <templateId root="2.16.840.1.113883.10.20.22.4.4" extension="2015-08-01"/>
${pad}        <templateId root="2.16.840.1.113883.10.20.24.3.135" extension="2021-08-01"/>
${pad}        ${cdaId(r, `condition-${i}`)}
${pad}        <code code="29308-4" codeSystem="${LOINC}" codeSystemName="LOINC" displayName="diagnosis">
${pad}          <translation code="282291009" codeSystem="2.16.840.1.113883.6.96" codeSystemName="SNOMEDCT" displayName="diagnosis"/>
${pad}        </code>
${pad}        ${COMPLETED}
${pad}        ${when}
${pad}        <value xsi:type="CD" ${value}/>${targetSites(r, `${pad}        `)}
${pad}      </observation>
${pad}    </entryRelationship>
${pad}  </act>
${pad}</entry>`;
}

/**
 * Laboratory Test, Performed and Diagnostic Study, Performed share a shape and differ by template —
 * which is exactly the distinction CMS125's official numerator turns on, so they are built from one
 * function with the template passed in rather than copied.
 */
function observationPerformed(
  r: FhirResource,
  i: number,
  pad: string,
  template: string,
  label: string,
  opts: { baseTemplate?: string; outerValue?: boolean } = {},
): string | null {
  const code = cdaCode(r.code);
  if (!code) return null;
  const result =
    r.valueQuantity?.value !== undefined
      ? `<value xsi:type="PQ" value="${esc(String(r.valueQuantity.value))}"${r.valueQuantity.unit ? ` unit="${esc(r.valueQuantity.unit)}"` : ""}/>`
      : cdaCode(r.valueCodeableConcept)
        ? `<value xsi:type="CD" ${cdaCode(r.valueCodeableConcept)}/>`
        : null;
  // The RESULT lives in a nested Result observation, not on the datatype itself — a receiver reading
  // `[Observation: "HbA1c"] where value > 9` is reading this nested value, so dropping it would make an
  // exported HbA1c invisible to the very measure it was exported for.
  const nested = result
    ? `
${pad}    <entryRelationship typeCode="REFR">
${pad}      <observation classCode="OBS" moodCode="EVN">
${pad}        <templateId root="2.16.840.1.113883.10.20.22.4.2" extension="2015-08-01"/>
${pad}        <templateId root="2.16.840.1.113883.10.20.24.3.87" extension="2019-12-01"/>
${pad}        ${cdaId(r, `result-${i}`)}
${pad}        <code ${code}/>
${pad}        ${COMPLETED}
${pad}        ${effectiveTime(r, `${pad}        `)}
${pad}        ${result}
${pad}      </observation>
${pad}    </entryRelationship>`
    : "";
  // Diagnostic Study, Performed SHALL carry a `value` (CONF:4509-29332) even when the study produced no
  // coded result — a screening mammogram is exactly that case. `nullFlavor="NA"` is the IG's own idiom
  // for it, used by the CMS sample file on this very template. Laboratory Test, Performed carries its
  // result in the nested Result observation instead, which is why this is a per-template option.
  const outer = opts.outerValue ? `\n${pad}    ${result ?? `<value xsi:type="CD" nullFlavor="NA"/>`}` : "";
  const base = opts.baseTemplate ? `\n${pad}    <templateId root="${opts.baseTemplate}" extension="2014-06-09"/>` : "";
  return `${pad}<entry typeCode="DRIV">
${pad}  <observation classCode="OBS" moodCode="EVN">${base}
${pad}    <templateId root="${template}" extension="2021-08-01"/>
${pad}    ${cdaId(r, `observation-${i}`)}
${pad}    <code ${code}/>
${pad}    <text>${esc(label)}</text>
${pad}    ${COMPLETED}
${pad}    ${effectiveTime(r, `${pad}    `)}${outer}${opts.outerValue ? "" : nested}
${pad}  </observation>
${pad}</entry>`;
}

function procedurePerformed(r: FhirResource, i: number, pad: string): string | null {
  const code = cdaCode(r.code);
  if (!code) return null;
  return `${pad}<entry typeCode="DRIV">
${pad}  <procedure classCode="PROC" moodCode="EVN">
${pad}    <templateId root="2.16.840.1.113883.10.20.22.4.14" extension="2014-06-09"/>
${pad}    <templateId root="2.16.840.1.113883.10.20.24.3.64" extension="2021-08-01"/>
${pad}    ${cdaId(r, `procedure-${i}`)}
${pad}    <code ${code}/>
${pad}    ${COMPLETED}
${pad}    ${effectiveTime(r, `${pad}    `)}${targetSites(r, `${pad}    `)}
${pad}  </procedure>
${pad}</entry>`;
}

/** The LOINC panel codes a US Core blood pressure carries, and its two readings' codes. */
const BLOOD_PRESSURE_PANELS = new Set(["85354-9", "55284-4"]);
const READING_CODES = new Set(["8480-6", "8462-4"]);
/** Statuses that mean the result is final; anything else is not a completed reading. */
const FINAL_STATUSES = new Set(["final", "amended", "corrected"]);

/**
 * Recognised as preparation recognises one (`loincCodesOf`: LOINC in any spelling real bundles use, or with
 * no system), so such a panel is never written as a Laboratory Test and is either written or refused with
 * its reason (review, #787).
 */
function isBloodPressurePanel(r: FhirResource): boolean {
  return loincCodesOf(r.code).some((c) => BLOOD_PRESSURE_PANELS.has(c));
}

/** A panel's component that is the systolic or the diastolic reading, by its stated LOINC code in any spelling. */
function readingComponents(r: FhirResource, code: string) {
  return (r.component ?? []).filter((c) => loincCodesOf(c.code).includes(code));
}

/**
 * A panel's own time: `effective[x]` alone, never `issued` (the effectiveTime helper falls back to it). An
 * `effectiveInstant` is an instant as a dateTime is; an `effectiveTiming` is a schedule, which no reading is.
 */
function bloodPressureTime(r: FhirResource): Pick<FhirResource, "effectiveDateTime" | "effectivePeriod"> {
  const instant = r.effectiveDateTime ?? r.effectiveInstant;
  return instant !== undefined ? { effectiveDateTime: instant } : { effectivePeriod: r.effectivePeriod };
}

/**
 * Why a blood-pressure panel cannot be written as two Physical Exam readings, or null when it can. Every
 * condition guards the round trip against stating what the panel does not (review, #787):
 * - final (a preliminary panel would come back `final` and count);
 * - a time of day in `effective[x]` itself (a date alone would be written as midnight and pair; `issued`
 *   is when it was recorded, not when it was measured), a real date and time, and a period only when
 *   closed, start not after end;
 * - exactly one systolic and one diastolic component, each a plain number with no comparator ("<130" is
 *   not 130), in UCUM mm[Hg].
 * All or nothing: half a panel is never written, so nothing is dropped without a reason.
 */
function bloodPressureExportProblem(r: FhirResource): string | null {
  if (!FINAL_STATUSES.has(r.status ?? "")) {
    return `a blood pressure whose status is '${r.status ?? "absent"}' is not final, so it is not written as completed readings`;
  }
  const time = bloodPressureTime(r);
  if (time.effectiveDateTime === undefined && time.effectivePeriod === undefined) {
    return r.effectiveTiming !== undefined
      ? "a blood pressure timed by a schedule (effectiveTiming) is not written: a reading is taken at a time"
      : "a blood pressure with no stated time (effective[x]) is not written: `issued` is when it was recorded, not measured";
  }
  if (time.effectivePeriod && time.effectivePeriod.start === undefined) return "a blood pressure over a period with no start is not written";
  const when = time.effectiveDateTime ?? time.effectivePeriod?.start;
  if (!when?.includes("T")) return "a blood pressure with no time of day is not written: a date alone is no time two readings share";
  const start = hl7TsKeepingFraction(when);
  if (start === null) return unwritableTimeReason(when);
  if (time.effectivePeriod) {
    // The import pairs a period only when it states both bounds (LOCKED §4A.8), and a date-only end would be
    // written as midnight, a time the panel never stated (Codex, #787).
    if (!time.effectivePeriod.end?.includes("T")) return "a blood pressure over a period with no end, or an end with no time of day, is not written";
    const end = hl7TsKeepingFraction(time.effectivePeriod.end);
    if (end === null) return unwritableTimeReason(time.effectivePeriod.end);
    // A bound in a stated zone and a bound in none are in two frames: they cannot be ordered or written as
    // one period (review, #787).
    const zoned = (t: string) => /(Z|[+-]\d{2}:\d{2})$/.test(t);
    if (zoned(when) !== zoned(time.effectivePeriod.end)) return "a blood pressure over a period with a time zone on only one bound is not written";
    const whole = [start.slice(0, 14), end.slice(0, 14)];
    if (whole[0]! > whole[1]! || (whole[0] === whole[1] && Number(`0${start.slice(14)}`) > Number(`0${end.slice(14)}`))) {
      return "a blood pressure whose period ends before it starts is not written";
    }
  }
  const systolic = readingComponents(r, "8480-6");
  const diastolic = readingComponents(r, "8462-4");
  if (systolic.length !== 1 || diastolic.length !== 1 || systolic[0] === diastolic[0]) {
    return "a blood pressure is written only when it states exactly one systolic and one diastolic reading";
  }
  // CMS165 reads a reading's code only as `http://loinc.org`: written in another spelling, the document
  // would carry a blood pressure the run could not read, and a receiver would score what the run did not
  // (review, #787).
  for (const [component, code] of [[systolic[0]!, "8480-6"], [diastolic[0]!, "8462-4"]] as const) {
    if (!(component.code?.coding ?? []).some((c) => c.system === "http://loinc.org" && c.code === code)) {
      return "a blood-pressure reading not coded in LOINC's own system (http://loinc.org) is not written: CMS165 cannot read it in another spelling";
    }
  }
  for (const component of [systolic[0]!, diastolic[0]!]) {
    const q = component.valueQuantity;
    const unit = q?.code ?? q?.unit;
    if (typeof q?.value !== "number" || !Number.isFinite(q.value) || q.comparator !== undefined) {
      return "a blood-pressure reading without a plain numeric value (missing, or a comparator such as '<') is not written";
    }
    if (unit !== "mm[Hg]" || (q.system !== undefined && q.system !== "http://unitsofmeasure.org")) {
      return "a blood-pressure reading not in UCUM mm[Hg] is not written";
    }
  }
  return null;
}

/** Why a blood pressure's time of day cannot be written: each is a time FHIR or the import cannot state. */
function unwritableTimeReason(t: string): string {
  if (/:\d{2}\.\d{10,}/.test(t)) return "a blood pressure whose time states more than nine digits of a second, which FHIR cannot, is not written";
  const offset = /[+-](\d{2}):(\d{2})$/.exec(t);
  if (offset && Number(offset[2]) < 60 && Number(offset[1]) * 60 + Number(offset[2]) > 14 * 60) {
    return "a blood pressure whose time zone offset is beyond 14 hours, which FHIR cannot state, is not written";
  }
  return "a blood pressure whose time is not a real date and time is not written";
}

/**
 * Panel fields the readings carry, or that say nothing about the reading (`meta`, `text`, `language`).
 * `identifier` is checked on its own: the readings' ids carry the ones this exporter writes.
 */
const BLOOD_PRESSURE_FIELDS_WRITTEN = new Set([
  "resourceType", "id", "meta", "text", "language", "status", "category", "code", "identifier",
  "effectiveDateTime", "effectivePeriod", "effectiveInstant", "component", "bodySite", "method", "subject",
]);
/** A reading's (component's) fields the Physical Exam entry carries; `id` is the element's own handle. */
const READING_FIELDS_WRITTEN = new Set(["id", "code", "valueQuantity"]);

/**
 * A blood-pressure panel as QDM states it: one Physical Exam, Performed per reading, each with its own
 * code (8480-6, 8462-4) and value, at the panel's own time (#591), with the panel's method and body site
 * (QDM's method and Anatomical Location Site, the same on both). The inverse of the import's pairing
 * (LOCKED §4A.8): written only when `bloodPressureExportProblem` finds nothing, and then as both readings
 * or neither. Imported again it is one panel again, unless another blood pressure's stated time could fall
 * within its own: §4A.8 then keeps every reading at that time separate (two arms, an orthostatic set), and
 * the import counts them. The systolic reading carries the panel's own id and the diastolic
 * `<id>-8462-4`, so a round trip gives the panel its id back (review, #787). Whatever else the panel states
 * that this exporter does not write (another component, the performer, the recorded time, the encounter
 * link, a note, an amended status, ...) is named in `caveats`, without the panel's id so a run's caveats
 * tally (review, #787). `null` when the resource is not a blood-pressure panel, so the caller routes it as
 * any other Observation.
 */
function bloodPressureReadings(r: FhirResource, i: number, pad: string, caveats: string[]): string[] | null {
  if (!isBloodPressurePanel(r)) return null;
  if (bloodPressureExportProblem(r) !== null) return [];
  const timed: FhirResource = { resourceType: "Observation", ...bloodPressureTime(r) };
  const id = r.id ?? `observation-${i}`;
  const written = new Set([readingComponents(r, "8480-6")[0], readingComponents(r, "8462-4")[0]]);
  for (const other of (r.component ?? []).filter((c) => !written.has(c))) {
    const codes = (other.code?.coding ?? []).map((c) => c.code).filter(Boolean).join("/") || "uncoded";
    caveats.push(`a blood pressure's component ${codes} is not written by this exporter`);
  }
  for (const field of Object.keys(r).filter((k) => !BLOOD_PRESSURE_FIELDS_WRITTEN.has(k) && (r as Record<string, unknown>)[k] !== undefined)) {
    caveats.push(`a blood pressure's ${field} is not written by this exporter`);
  }
  // The readings' `<id>`s carry this exporter's own identifiers (a round-tripped panel's, which the import
  // names by the root's URI form), never another.
  const writtenIds = new Set([id, `${id}-8462-4`]);
  const ownSystems = new Set([`urn:uuid:${FHIR_RESOURCE_ID_ROOT.toLowerCase()}`, `urn:oid:${FHIR_RESOURCE_ID_ROOT}`]);
  if ((r.identifier ?? []).some((x) => !(ownSystems.has(x.system ?? "") && writtenIds.has(x.value ?? "")))) {
    caveats.push("a blood pressure's identifier is not written by this exporter");
  }
  if (r.status !== "final") caveats.push(`a blood pressure whose status is '${r.status}' is written as completed`);
  // The panel's own code is not written (QDM states its readings): anything it says beyond the panel code is
  // named.
  if (r.code?.text !== undefined || (r.code?.coding ?? []).some((c) => !loincCodesOf({ coding: [c] }).some((code) => BLOOD_PRESSURE_PANELS.has(code)))) {
    caveats.push("a blood pressure's own code says more than the panel code, and is not written by this exporter");
  }
  for (const reading of written) {
    for (const [field, value] of Object.entries((reading ?? {}) as Record<string, unknown>)) {
      if (!READING_FIELDS_WRITTEN.has(field) && value !== undefined) caveats.push(`a blood pressure reading's ${field} is not written by this exporter`);
    }
    const codings = reading?.code?.coding ?? [];
    if (codings.some((c) => cdaCodes({ coding: [c] }).length === 0 && loincCodesOf({ coding: [c] }).length === 0)) {
      caveats.push("a blood pressure reading's coding in a system CDA does not carry is not written");
    }
    if (reading?.code?.text !== undefined) caveats.push("a blood pressure reading's code text is not written by this exporter");
  }
  // FHIR states one body site and one method on an Observation; a list is read as written, and named,
  // because the import carries a site or method back only when exactly one is written.
  const listOf = (v: unknown) => (Array.isArray(v) ? (v as FhirCodeableConcept[]) : v ? [v as FhirCodeableConcept] : []);
  const sites = listOf(r.bodySite);
  const methods = listOf(r.method);
  if (sites.filter((site) => cdaCodes(site).length > 0).length > 1) caveats.push("a blood pressure with more than one body site is written with each, and a re-import carries none");
  if (methods.filter((method) => cdaCodes(method).length > 0).length > 1) caveats.push("a blood pressure with more than one method is written with each, and a re-import carries none");
  if (sites.some((site) => cdaCodes(site).length === 0)) caveats.push("a blood pressure's body site in no code system CDA carries is not written");
  if (methods.some((method) => cdaCodes(method).length === 0)) caveats.push("a blood pressure's method in no code system CDA carries is not written");
  const methodCodes = methods
    .map((method) => cdaCodes(method))
    .filter((codes) => codes.length > 0)
    .map(([first, ...rest]) =>
      rest.length === 0
        ? `\n${pad}    <methodCode ${first}/>`
        : `\n${pad}    <methodCode ${first}>${rest.map((t) => `\n${pad}      <translation ${t}/>`).join("")}\n${pad}    </methodCode>`,
    )
    .join("");
  const siteCodes = targetSites({ bodySite: sites }, `${pad}    `);
  return (["8480-6", "8462-4"] as const).map((readingCode) => {
    const component = readingComponents(r, readingCode)[0]!;
    // The reading's LOINC code first (`bloodPressureExportProblem` requires it in LOINC's own system), then
    // every other mapped coding as a translation, so the import recognises the reading whatever the
    // codings' order (Codex, #787).
    const codings = component.code?.coding ?? [];
    const own = codings.filter((c) => loincCodesOf({ coding: [c] }).includes(readingCode));
    const loinc = { system: "http://loinc.org", code: readingCode, ...(own[0]?.display ? { display: own[0].display } : {}) };
    const [code, ...translations] = cdaCodes({ coding: [loinc, ...codings.filter((c) => !own.includes(c))] });
    const entryResource = { ...r, id: readingCode === "8480-6" ? id : `${id}-${readingCode}` };
    return `${pad}<entry typeCode="DRIV">
${pad}  <observation classCode="OBS" moodCode="EVN">
${pad}    <templateId root="2.16.840.1.113883.10.20.22.4.13" extension="2014-06-09"/>
${pad}    <templateId root="2.16.840.1.113883.10.20.24.3.59" extension="2021-08-01"/>
${pad}    ${cdaId(entryResource, `observation-${i}-${readingCode}`)}
${pad}    ${translations.length === 0 ? `<code ${code}/>` : `<code ${code}>${translations.map((t) => `\n${pad}      <translation ${t}/>`).join("")}\n${pad}    </code>`}
${pad}    <text>Physical Exam, Performed</text>
${pad}    ${COMPLETED}
${pad}    ${effectiveTime(timed, `${pad}    `, hl7TsKeepingFraction)}
${pad}    <value xsi:type="PQ" value="${esc(String(component.valueQuantity!.value))}" unit="mm[Hg]"/>${methodCodes}${siteCodes}
${pad}  </observation>
${pad}</entry>`;
  });
}

/** FHIR `Observation.category` codes that mean "this is a diagnostic study", not a lab result. */
const IMAGING_CATEGORIES = new Set(["imaging", "procedure"]);
const LAB_CATEGORIES = new Set(["laboratory", "vital-signs", "survey", "exam"]);

/**
 * Every QDM entry for one subject's bundle, in resource order.
 *
 * Resource order is deliberate: it is the order the bundle presented, so two exports of the same bundle
 * are byte-identical and a diff between them means the DATA moved, not that the exporter did.
 */
/**
 * Why one resource produced no entry — the ACTUAL cause, in the operator's terms.
 *
 * Getting this wrong is worse than saying nothing, because it sends someone to the wrong place. Two
 * cases were measurably misreported (review, #362): an Observation whose category is outside both sets
 * (`social-history`, `activity`, `therapy`) was blamed on terminology even when its code was plain
 * LOINC; and an Encounter was ALWAYS reported as having "an absent code", because the reason string read
 * `code` while `encounterPerformed` reads `type[0] ?? code`.
 */
function dropReason(resource: FhirResource, type: string): string {
  // The three types the IMPORT reads and the export has no entry template for (ADR-055). Named
  // explicitly, because the code-system reason below would be computed off `resource.code` — which none
  // of these three carries (`codeCodeableConcept`, `medicationCodeableConcept`) — and would report "no
  // code to carry" about a resource that is fully coded.
  if (!(QDM_MAPPED_RESOURCE_TYPES as readonly string[]).includes(type)) {
    return `no QDM entry template — this exporter maps ${QDM_MAPPED_RESOURCE_TYPES.join(", ")} only (ADR-055)`;
  }
  if (isNegated(resource)) return "excluded — its status says the event did not happen or was retracted";
  if (type === "Observation" && isBloodPressurePanel(resource)) {
    return bloodPressureExportProblem(resource) ?? "a blood pressure that could not be written";
  }
  if (type === "Observation") {
    const cats = categoryCodes(resource);
    if (cats.length === 0) return "no category, so its QDM datatype (laboratory vs diagnostic study) is undetermined";
    if (!cats.some((c) => IMAGING_CATEGORIES.has(c) || LAB_CATEGORIES.has(c))) {
      return `category '${cats.join("/")}' is not a QDM datatype this mapper routes (it maps laboratory and imaging only)`;
    }
  }
  // Read the SAME field the builder reads, or the reason describes a different resource than the one
  // that was dropped.
  const concept = type === "Encounter" ? (resource.type?.[0] ?? resource.code) : resource.code;
  const systems = [...new Set((concept?.coding ?? []).map((c) => c.system).filter(Boolean))];
  if (systems.length === 0) return "no code to carry — CDA needs a coded value";
  return `no CDA code system OID for ${systems.join(", ")} — CDA cannot carry it`;
}

export interface QdmTranslation {
  entries: string[];
  /**
   * Resources this mapper could not express in CDA, as `"<ResourceType>: <why>"`.
   *
   * The largest cause is not a bug: a code carrying **no CDA code system OID** cannot appear in a QRDA
   * at all. WorkWell's authored measures bind synthetic `urn:workwell:vs:*` value sets, so their bundles
   * translate to *nothing* — which means a QRDA Category I is only a meaningful artifact for measures
   * whose data carries real terminology (LOINC/SNOMED/CPT/ICD), i.e. the official ones. Discovered by
   * the round-trip route test, which is precisely what it was written to catch.
   */
  untranslatable: string[];
  /**
   * What a WRITTEN entry does not carry, as `"<ResourceType>: <what>"`, with no resource id so a run's
   * caveats tally (a blood pressure's performer, recorded time, another component, ...). Not a conformance
   * failure: the document is valid, and a recalculation from it may still differ from the run (#787).
   */
  caveats?: string[];
}

/** Entries plus the reasons anything was dropped — see `QdmTranslation.untranslatable`. */
export function translateQdm(bundle: unknown, pad = "          "): QdmTranslation {
  const raw = (bundle as { entry?: unknown } | undefined)?.entry;
  const items = Array.isArray(raw) ? raw : [];
  const entries: string[] = [];
  const untranslatable: string[] = [];
  const caveats: string[] = [];
  items.forEach((item, i) => {
    const resource = (item as { resource?: FhirResource } | null)?.resource;
    const type = resource?.resourceType;
    let produced: string[] = [];
    // What a written entry does not carry (a blood pressure's third component, its performer, ...).
    const notCarried: string[] = [];
    try {
      produced = entryFor(item, i, pad, notCarried);
    } catch {
      if (type) untranslatable.push(`${type}: could not be translated (malformed field)`);
      return;
    }
    if (produced.length > 0) {
      entries.push(...produced);
      // Once per resource: two uncoded components are one panel's caveat, not two resources'.
      caveats.push(...[...new Set(notCarried)].map((caveat) => `${type}: ${caveat}`));
      return;
    }
    // Nothing produced. Say WHY, for the cases an operator can act on; stay silent for the ones that are
    // simply out of scope, where a "gap" would be noise.
    if (!type || type === "Patient" || !(QDM_REPORTABLE_RESOURCE_TYPES as readonly string[]).includes(type)) return;
    // Guarded as `entryFor` is: a malformed field must cost this resource its reason, never the run its
    // export (review, #787).
    let reason: string;
    try {
      reason = dropReason(resource!, type);
    } catch {
      reason = "could not be translated (malformed field)";
    }
    untranslatable.push(`${type}: ${reason}`);
  });
  return { entries, untranslatable, caveats };
}

export function qdmEntriesFor(bundle: unknown, pad = "          "): string[] {
  return translateQdm(bundle, pad).entries;
}

/**
 * The QDM entries for ONE bundle item — zero, one, or (never yet) more.
 *
 * Per-resource isolation lives in `translateQdm`'s try/catch around this call, and it has to be a real
 * try/catch rather than input validation. This module's own contract is "an export that throws on one
 * junk item loses the whole run's documents, where skipping the item loses one" — but the structural
 * guard implements that only for shape junk (`entry: [null]`). VALUE junk is the larger half: a
 * malformed date or a numeric id used to reach the worker's catch-all and turn a 500-subject export into
 * `{"error":"internal_error"}`, losing the 499 documents that were fine (review, #361).
 */
function entryFor(item: unknown, i: number, pad: string, caveats: string[]): string[] {
  const out: string[] = [];
  {
    const resource = (item as { resource?: FhirResource } | null)?.resource;
    if (!resource?.resourceType) return out;
    // A retracted or did-not-happen record must never become a *Performed* entry.
    if (isNegated(resource)) return out;
    switch (resource.resourceType) {
      case "Encounter":
        out.push(encounterPerformed(resource, i, pad) ?? "");
        break;
      case "Condition":
        out.push(diagnosis(resource, i, pad) ?? "");
        break;
      case "Procedure":
        out.push(procedurePerformed(resource, i, pad) ?? "");
        break;
      case "Observation": {
        const readings = bloodPressureReadings(resource, i, pad, caveats);
        if (readings !== null) {
          out.push(...readings);
          break;
        }
        const cats = categoryCodes(resource);
        // Unclassifiable is SKIPPED, not guessed. An Observation with no category could be either
        // datatype, and picking one silently is how a mammogram becomes invisible to a numerator that
        // retrieves the other (the ADR-044 failure, in the opposite direction).
        const template = cats.some((c) => IMAGING_CATEGORIES.has(c))
          ? "2.16.840.1.113883.10.20.24.3.18"
          : cats.some((c) => LAB_CATEGORIES.has(c))
            ? "2.16.840.1.113883.10.20.24.3.38"
            : null;
        if (!template) break;
        const isStudy = template.endsWith(".18");
        out.push(
          observationPerformed(
            resource,
            i,
            pad,
            template,
            isStudy ? "Diagnostic Study, Performed" : "Laboratory Test, Performed",
            isStudy ? { baseTemplate: "2.16.840.1.113883.10.20.22.4.13", outerValue: true } : {},
          ) ?? "",
        );
        break;
      }
      default:
        break; // a resource type no measure of ours reads — silence is correct, not a gap
    }
  }
  return out.filter(Boolean);
}

/** Resource types this mapper can translate — used by the export to explain what it dropped. */
/**
 * Resource types the EXPORT knows how to turn into a QDM entry — and therefore the only ones whose
 * omission it can report.
 *
 * `ServiceRequest`, `DeviceRequest` and `MedicationRequest` are deliberately absent: the export has no QDM
 * mapping for them (ADR-055). Since #713 a live WebChart bundle can carry the first and the last, so an
 * export of such a run reports them as untranslatable, as a re-exported IMPORTED document always did —
 * reported, never dropped in silence (review, #388).
 */
export const QDM_MAPPED_RESOURCE_TYPES = ["Encounter", "Condition", "Observation", "Procedure"] as const;

/** Reported-but-not-exported: known clinical types the QDM translator has no entry template for. */
export const QDM_REPORTABLE_RESOURCE_TYPES = [
  ...QDM_MAPPED_RESOURCE_TYPES,
  "ServiceRequest",
  "DeviceRequest",
  "MedicationRequest",
] as const;
