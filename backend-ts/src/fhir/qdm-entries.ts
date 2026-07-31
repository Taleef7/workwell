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
import { LOINC, esc, hl7TsOrNull } from "./qrda-common.ts";

/** Code systems a QDM entry can carry. Keyed by FHIR system URL — the only mapping direction we need. */
const CODE_SYSTEMS: Record<string, { oid: string; name: string }> = {
  "http://snomed.info/sct": { oid: "2.16.840.1.113883.6.96", name: "SNOMEDCT" },
  "http://loinc.org": { oid: LOINC, name: "LOINC" },
  "http://www.ama-assn.org/go/cpt": { oid: "2.16.840.1.113883.6.12", name: "CPT" },
  "http://hl7.org/fhir/sid/icd-10-cm": { oid: "2.16.840.1.113883.6.90", name: "ICD10CM" },
  "http://hl7.org/fhir/sid/icd-9-cm": { oid: "2.16.840.1.113883.6.103", name: "ICD9CM" },
  "urn:oid:2.16.840.1.113883.6.285": { oid: "2.16.840.1.113883.6.285", name: "HCPCS" },
  "https://bluebutton.cms.gov/resources/codesystem/hcpcs": { oid: "2.16.840.1.113883.6.285", name: "HCPCS" },
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
  category?: FhirCodeableConcept | FhirCodeableConcept[];
  type?: FhirCodeableConcept[];
  subject?: { reference?: string };
  patient?: { reference?: string };
  effectiveDateTime?: string;
  effectivePeriod?: { start?: string; end?: string };
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
}

/** A `<code>`/`<value xsi:type="CD">` attribute string for the first coding we can map, else null. */
function cdaCode(concept: FhirCodeableConcept | undefined): string | null {
  for (const coding of concept?.coding ?? []) {
    const sys = coding.system ? CODE_SYSTEMS[coding.system] : undefined;
    if (!sys || !coding.code) continue;
    const display = coding.display ? ` displayName="${esc(coding.display)}"` : "";
    return `code="${esc(coding.code)}" codeSystem="${sys.oid}" codeSystemName="${sys.name}"${display}`;
  }
  return null;
}

/**
 * The QDM "relevant period" for a resource, as CDA `<effectiveTime>`.
 *
 * `nullFlavor="NA"` on the high bound is the IG's own idiom for an interval that has not ended (the CMS
 * sample uses it for an ongoing diagnosis) — as against omitting `high`, which asserts nothing about
 * whether the interval is open.
 */
function effectiveTime(resource: FhirResource, indent: string): string {
  const period = resource.effectivePeriod ?? resource.performedPeriod ?? resource.period ?? resource.onsetPeriod;
  // Every date goes through the non-throwing conversion: these strings come from third-party FHIR, and a
  // MariaDB zero-date must degrade this ONE field rather than lose every subject's document (#361).
  const low = hl7TsOrNull(period?.start ?? resource.effectiveDateTime ?? resource.performedDateTime ?? resource.onsetDateTime ?? resource.issued);
  const end = hl7TsOrNull(period?.end ?? resource.abatementDateTime);
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

/** The FHIR `category` codings, flattened — `category` is 0..* on Observation but 0..1 in some shims. */
function categoryCodes(resource: FhirResource): string[] {
  const cats = Array.isArray(resource.category) ? resource.category : resource.category ? [resource.category] : [];
  return cats.flatMap((c) => (c.coding ?? []).map((coding) => coding.code ?? "").filter(Boolean));
}

/** A stable CDA `<id>` — the FHIR id when there is one, so two exports of one resource agree. */
function cdaId(resource: FhirResource, fallback: string): string {
  return `<id root="urn:workwell:fhir" extension="${esc(resource.id ?? fallback)}"/>`;
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
${pad}        <value xsi:type="CD" ${value}/>
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
${pad}    ${effectiveTime(r, `${pad}    `)}
${pad}  </procedure>
${pad}</entry>`;
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
}

/** Entries plus the reasons anything was dropped — see `QdmTranslation.untranslatable`. */
export function translateQdm(bundle: unknown, pad = "          "): QdmTranslation {
  const raw = (bundle as { entry?: unknown } | undefined)?.entry;
  const items = Array.isArray(raw) ? raw : [];
  const entries: string[] = [];
  const untranslatable: string[] = [];
  items.forEach((item, i) => {
    const resource = (item as { resource?: FhirResource } | null)?.resource;
    const type = resource?.resourceType;
    let produced: string[] = [];
    try {
      produced = entryFor(item, i, pad);
    } catch {
      if (type) untranslatable.push(`${type}: could not be translated (malformed field)`);
      return;
    }
    if (produced.length > 0) {
      entries.push(...produced);
      return;
    }
    // Nothing produced. Say WHY, for the cases an operator can act on; stay silent for the ones that are
    // simply out of scope, where a "gap" would be noise.
    if (!type || type === "Patient" || !(QDM_MAPPED_RESOURCE_TYPES as readonly string[]).includes(type)) return;
    if (resource && isNegated(resource)) {
      untranslatable.push(`${type}: excluded — its status says the event did not happen or was retracted`);
    } else if (type === "Observation" && categoryCodes(resource!).length === 0) {
      untranslatable.push(`${type}: no category, so its QDM datatype (laboratory vs diagnostic study) is undetermined`);
    } else {
      const systems = [...new Set((resource?.code?.coding ?? []).map((c) => c.system).filter(Boolean))];
      untranslatable.push(
        `${type}: no CDA code system OID for ${systems.length ? systems.join(", ") : "an absent code"} — CDA cannot carry it`,
      );
    }
  });
  return { entries, untranslatable };
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
function entryFor(item: unknown, i: number, pad: string): string[] {
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
export const QDM_MAPPED_RESOURCE_TYPES = ["Encounter", "Condition", "Observation", "Procedure"] as const;
