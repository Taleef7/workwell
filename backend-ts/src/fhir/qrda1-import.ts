/**
 * QRDA Category I → FHIR R4 — the "import" half of §170.315(c)(2) "import and calculate" (M-B).
 *
 * ## Why this is the shape of the criterion
 *
 * (c)(2) requires a Health IT Module to **import a QRDA Category I file and compute the measure from
 * it**. That is only meaningful because Category I carries patient DATA rather than an answer (ADR-050):
 * the receiving engine recalculates. This module turns the QDM entries back into the FHIR the engine
 * already evaluates, so "calculate" is the existing, unchanged evaluation path — not a second engine.
 *
 * ## Exactly inverts `qdm-entries.ts`
 *
 * The two are a matched pair and a **round trip is the strongest test available**, since both halves are
 * ours: export a bundle, import the document, and the clinically load-bearing fields must survive. What
 * a round trip cannot prove is that our reading of the IG is right — only Cypress CVU+ can, and it has
 * not run. Nothing here may be described as certified.
 *
 * ## What it refuses rather than guesses
 *
 * A document that is not a QRDA Category I, or whose Patient Data section is empty, is **rejected**. An
 * empty section is precisely the non-conformant state our own exporter marks (CONF:67-14567) and
 * importing it would produce a bundle that computes an out-of-population answer for every measure —
 * indistinguishable from a genuinely ineligible patient, which is the hazard ADR-043 exists for.
 */
import { child, childrenNamed, descendants, hasTemplate, parseXml, type CdaNode } from "./cda-parse.ts";

/**
 * OID → FHIR system URL. A superset of `qdm-entries.ts`'s `CODE_SYSTEMS`, deliberately.
 *
 * The export only has to emit the systems OUR bundles carry; the import has to read whatever a third
 * party wrote. Measured against Cypress's own generated patients: 4 of CMS125's 10 `Procedure, Performed`
 * entries are coded in **ICD-10-PCS**, which this map did not carry — and because `concept()` returns
 * undefined for an unmapped system, the whole Procedure was dropped, taking a mastectomy exclusion with
 * it (`docs/evidence/CVU_CALCULATION_CHECK_SPIKE_2026-08-02.md` §16.2).
 *
 * **Every URL here is the one the vendored expansions actually use**, not the one a specification says
 * they should — `cql-execution` matches `system` by exact string equality, so a near-miss imports the
 * resource and leaves it invisible to every retrieve, which is strictly worse than dropping it (the drop
 * at least shows up in `untranslatedTemplates`). Pinned by `qrda1-import-official.test.ts`, which reads
 * the artifacts' own terminology. Speculative entries are deliberately absent for the same reason: a
 * mapping nothing can validate is a landmine, and an unmapped system is a visible gap.
 */
export const SYSTEM_FOR_OID: Record<string, string> = {
  "2.16.840.1.113883.6.96": "http://snomed.info/sct",
  "2.16.840.1.113883.6.1": "http://loinc.org",
  "2.16.840.1.113883.6.12": "http://www.ama-assn.org/go/cpt",
  "2.16.840.1.113883.6.90": "http://hl7.org/fhir/sid/icd-10-cm",
  "2.16.840.1.113883.6.103": "http://hl7.org/fhir/sid/icd-9-cm",
  // HCPCS. The URN form this used to carry matches NOTHING: `cql-execution` compares `system` by exact
  // string equality, and the vendored expansions express HCPCS as the CMS URL (103 codes across the two
  // measures — Annual Wellness Visit `G0438`, Hospice Care Ambulatory `G0182`, Frailty and Hospice
  // Encounters). Measured: an identical Encounter coded `G0438` gives `initial-population: false` under
  // the URN and `true` under this URL. It never surfaced as a divergence because the IPP is `exists(...)`
  // and those patients carry other qualifying encounters — a right answer for the wrong reason, and the
  // same defect class as the ICD-10-PCS one this change was written to fix (review, #388).
  "2.16.840.1.113883.6.285": "http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets",
  "2.16.840.1.113883.6.4": "http://www.cms.gov/Medicare/Coding/ICD10",
  "2.16.840.1.113883.6.88": "http://www.nlm.nih.gov/research/umls/rxnorm",
};

/**
 * QDM template roots this importer understands, keyed to what they become in FHIR.
 *
 * **Each FHIR target is read off what the official artifacts' ELM actually RETRIEVES**, not off a
 * QDM-to-QI-Core mapping table — the ELM is what the executed measure will look for, and a plausible
 * second-hand answer that retrieves nothing is indistinguishable from a patient with no data. Measured
 * across CMS122/CMS125 (`cvu-workdir/dbg-retrieves.mjs` in the C2 evidence):
 *
 * | QDM datatype | retrieved as | value sets that prove it |
 * |---|---|---|
 * | Intervention, Performed | `Procedure` | Hospice Care Ambulatory, Palliative Care Intervention |
 * | Intervention, Order | `ServiceRequest` | Hospice Care Ambulatory |
 * | Device, Order | `DeviceRequest` | Frailty Device |
 * | Medication, Active | `MedicationRequest` | Dementia Medications |
 * | Symptom | `Observation` | Frailty Symptom |
 * | Assessment, Performed | `Observation` | (screening/assessment) |
 *
 * The libraries read `authoredOn` (orders), `performed` (Procedure), `effective` (Observation) and
 * `value`. **They also read `status` and `intent`** — every retrieve on the exclusion paths is wrapped in
 * a `Status.is*` predicate (`isMedicationActive`, `isEncounterPerformed`, `isProcedurePerformed`,
 * `isSymptom`, `isAssessmentPerformed`), and the `Status` library reads `status` 22 times and `intent` 6.
 * So the status values below are chosen **to satisfy those predicates**, not merely to state the QDM
 * shape — an earlier draft of this comment claimed the opposite, and the margins are thin:
 * `isMedicationActive` is an `Equal` on `"active"`, so a plausible-looking edit to `"completed"` would
 * silently kill the dementia exclusion (review, #388). `status-predicates` in the test file pins every
 * one of them.
 */
const T = {
  encounterPerformed: "2.16.840.1.113883.10.20.24.3.23",
  diagnosis: "2.16.840.1.113883.10.20.24.3.135",
  labPerformed: "2.16.840.1.113883.10.20.24.3.38",
  studyPerformed: "2.16.840.1.113883.10.20.24.3.18",
  procedurePerformed: "2.16.840.1.113883.10.20.24.3.64",
  interventionPerformed: "2.16.840.1.113883.10.20.24.3.32",
  interventionOrder: "2.16.840.1.113883.10.20.24.3.31",
  deviceOrder: "2.16.840.1.113883.10.20.24.3.9",
  medicationActive: "2.16.840.1.113883.10.20.24.3.41",
  assessmentPerformed: "2.16.840.1.113883.10.20.24.3.144",
  symptom: "2.16.840.1.113883.10.20.24.3.136",
  result: "2.16.840.1.113883.10.20.24.3.87",
  patientDataSection: "2.16.840.1.113883.10.20.24.2.1",
  measureSection: "2.16.840.1.113883.10.20.24.2.2",
  eMeasureReference: "2.16.840.1.113883.10.20.24.3.97",
} as const;

/**
 * QDM templates that describe an ATTRIBUTE of an entry rather than a datatype.
 *
 * Used only to name what was dropped. The previous diagnostic reported the LAST `templateId` found
 * anywhere in the entry, which is routinely one of these — measured on Cypress's CMS122 archive, it
 * blamed Author dateTime 31 times for entries whose real datatype was Assessment or Intervention. A
 * diagnostic that names the wrong thing is worse than a count, because it sends the reader somewhere.
 */
const ATTRIBUTE_TEMPLATES = new Set([
  "2.16.840.1.113883.10.20.24.3.155", // Author dateTime
  "2.16.840.1.113883.10.20.24.3.166", // Rank
  "2.16.840.1.113883.10.20.24.3.162", // Participant
  "2.16.840.1.113883.10.20.24.3.168", // Encounter Diagnosis
  "2.16.840.1.113883.10.20.24.3.137", // Diagnosis Concern Act (wrapper)
  "2.16.840.1.113883.10.20.24.3.138", // Symptom Concern Act (wrapper)
  "2.16.840.1.113883.10.20.24.3.130", // Device Order Act (wrapper; the datatype is on the <supply>)
  T.result,
]);

/** SNOMED sex concept → FHIR `Patient.gender`, inverting the export's `SEX_CONCEPTS`. */
const GENDER_FOR_SNOMED: Record<string, string> = { "248152002": "female", "248153007": "male" };

export class Qrda1ImportError extends Error {}

/**
 * HL7 `YYYYMMDDHHMMSS[±ZZZZ]` → ISO-8601, or undefined when absent/nullFlavored/unparseable.
 *
 * The **offset is applied, not discarded** (Codex, #362). `20251231230000-0500` is
 * `2026-01-01T04:00:00Z`, a different day and a different YEAR — and a measurement period is a
 * half-open interval on exactly that boundary, so dropping the offset silently moves events in and out
 * of populations. Base HL7 asks for the offset (CONF:81-10130) even though the CMS Hospital IG asks for
 * its absence (CMS_0121), so a conformant document may well carry one.
 */
function isoFromHl7(value: string | undefined): string | undefined {
  if (!value || !/^\d{8}/.test(value)) return undefined;
  const [y, mo, d] = [value.slice(0, 4), value.slice(4, 6), value.slice(6, 8)];
  const offset = /([+-])(\d{2})(\d{2})$/.exec(value);
  const digits = offset ? value.slice(0, value.length - 5) : value;
  if (digits.length < 12) {
    // Validate the date-only path too. `00000000` (a MariaDB zero date) used to become
    // `"0000-00-00"` and flow into `Patient.birthDate`, where CMS125's IPP feeds it to `AgeAt(...)`.
    // The export has `hl7TsOrNull` guarding the other direction; this branch had nothing (review, #362).
    const probe = new Date(`${y}-${mo}-${d}T00:00:00Z`);
    if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== `${y}-${mo}-${d}`) return undefined;
    return `${y}-${mo}-${d}`;
  }
  const [h, mi, s] = [digits.slice(8, 10), digits.slice(10, 12), digits.slice(12, 14) || "00"];
  const zone = offset ? `${offset[1]}${offset[2]}:${offset[3]}` : "Z";
  const parsed = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A CDA coded element → a FHIR CodeableConcept, or undefined when it is nullFlavored/unmapped. */
/**
 * `<code>` → a FHIR `CodeableConcept` carrying EVERY coding the element expresses.
 *
 * Two properties, both of which the single-coding version got wrong (measured, §16.2):
 *
 * 1. **`<translation>` children are codings too.** CDA's translation is "the same concept in another
 *    vocabulary", which is precisely what a `CodeableConcept` with multiple `coding` entries means — so
 *    they are additional codings, not a fallback. A mastectomy coded in ICD-10-PCS with a SNOMED
 *    translation is a real Cypress document, and the SNOMED code is the one CMS125's exclusion value set
 *    contains.
 * 2. **An unmappable primary code no longer discards the element.** Previously any code system outside
 *    the six mapped ones made this return `undefined`, and the caller dropped the whole resource — a
 *    silent data loss whose only trace was an entry counted as "untranslated".
 *
 * Returns undefined only when NOTHING resolved, which is the honest signal that the element carries no
 * code the engine could ever match.
 */
function concept(node: CdaNode | undefined): { coding: Array<{ system: string; code: string; display?: string }> } | undefined {
  if (!node) return undefined;
  const coding: Array<{ system: string; code: string; display?: string }> = [];
  const push = (n: CdaNode) => {
    const code = n.attrs.code;
    const system = n.attrs.codeSystem ? SYSTEM_FOR_OID[n.attrs.codeSystem] : undefined;
    if (!code || !system) return;
    // A translation can repeat the primary coding verbatim; two identical codings are harmless to
    // matching but noise in persisted evidence.
    if (coding.some((c) => c.system === system && c.code === code)) return;
    coding.push({ system, code, ...(n.attrs.displayName ? { display: n.attrs.displayName } : {}) });
  };
  push(node);
  for (const translation of childrenNamed(node, "translation")) push(translation);
  return coding.length > 0 ? { coding } : undefined;
}

/** `<effectiveTime>` → `{ point, start, end }` in ISO, whichever the element expresses. */
function times(node: CdaNode | undefined): { point?: string; start?: string; end?: string } {
  if (!node) return {};
  const point = isoFromHl7(node.attrs.value);
  if (point) return { point };
  return { start: isoFromHl7(child(node, "low")?.attrs.value), end: isoFromHl7(child(node, "high")?.attrs.value) };
}

/**
 * The FHIR `id` this entry was exported under.
 *
 * Deliberately ROOT-AGNOSTIC: it takes the first `<id>` carrying an `extension`, whatever the root. That
 * is what let the export change its own root (`urn:workwell:fhir` → `FHIR_RESOURCE_ID_ROOT`, so CDA's
 * `uid` type would accept it) without touching ADR-051's round trip, and it is also what lets us import
 * a third party's document, whose root will never be ours.
 */
function idOf(node: CdaNode, fallback: string): string {
  const own = childrenNamed(node, "id").find((n) => n.attrs.extension);
  return own?.attrs.extension ?? fallback;
}

function encounterFrom(node: CdaNode, i: string): unknown {
  const t = times(child(node, "effectiveTime"));
  const type = concept(child(node, "code"));
  // QDM's Discharge Disposition, which the Hospice library reads as
  // `Encounter.hospitalization.dischargeDisposition` — an inpatient stay ending in "discharge to home
  // for hospice care" is a denominator exclusion in both measures. Dropping it left an encounter that
  // retrieves correctly and then fails the only predicate that mattered: measured, it was the LAST
  // remaining cause of divergence from Cypress once the missing datatypes were mapped (9 subjects in
  // each measure). The element carries an `sdtc:` prefix; `cda-parse` matches on local name.
  const dischargeDisposition = concept(child(node, "dischargeDispositionCode"));
  return {
    resourceType: "Encounter",
    id: idOf(node, `qrda1-encounter-${i}`),
    status: "finished",
    ...(type ? { type: [type] } : {}),
    ...(dischargeDisposition ? { hospitalization: { dischargeDisposition } } : {}),
    ...(t.start || t.end || t.point
      ? { period: { ...(t.start ?? t.point ? { start: t.start ?? t.point } : {}), ...(t.end ? { end: t.end } : {}) } }
      : {}),
  };
}

function conditionFrom(node: CdaNode, i: string): unknown {
  const t = times(child(node, "effectiveTime"));
  // The patient's condition is the VALUE; `<code>` says only "this entry is a diagnosis".
  const code = concept(child(node, "value"));
  if (!code) return undefined;
  return {
    resourceType: "Condition",
    id: idOf(node, `qrda1-condition-${i}`),
    verificationStatus: { coding: [{ code: "confirmed" }] },
    code,
    ...(t.start ?? t.point ? { onsetDateTime: t.start ?? t.point } : {}),
    ...(t.end ? { abatementDateTime: t.end } : {}),
  };
}

function observationFrom(node: CdaNode, i: string, category: string): unknown {
  const code = concept(child(node, "code"));
  if (!code) return undefined;
  const t = times(child(node, "effectiveTime"));
  // A Laboratory Test carries its result in a nested Result observation; a Diagnostic Study carries an
  // outer `value` which is `nullFlavor="NA"` for a study with no coded result (ADR-050).
  const nested = descendants(node, "observation").find((n) => hasTemplate(n, T.result));
  const valueNode = child(nested ?? node, "value") ?? child(node, "value");
  const quantity = valueNode?.attrs["xsi:type"] === "PQ" && valueNode.attrs.value !== undefined
    ? { value: Number(valueNode.attrs.value), ...(valueNode.attrs.unit ? { unit: valueNode.attrs.unit } : {}) }
    : undefined;
  const coded = valueNode?.attrs["xsi:type"] === "CD" ? concept(valueNode) : undefined;
  // An interval stays an interval. Collapsing `<low>`+`<high>` to a single `effectiveDateTime` drops the
  // end, and a lab or study whose relevant period OVERLAPS a measurement window is exactly the case
  // temporal CQL predicates turn on (Codex, #362).
  const when =
    t.start && t.end
      ? { effectivePeriod: { start: t.start, end: t.end } }
      : (t.point ?? t.start)
        ? { effectiveDateTime: (t.point ?? t.start)! }
        : t.end
          ? { effectivePeriod: { end: t.end } }
          : {};
  return {
    resourceType: "Observation",
    id: idOf(node, `qrda1-observation-${i}`),
    status: "final",
    category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: category }] }],
    code,
    ...when,
    ...(quantity && Number.isFinite(quantity.value) ? { valueQuantity: quantity } : {}),
    ...(coded ? { valueCodeableConcept: coded } : {}),
  };
}

function procedureFrom(node: CdaNode, i: string): unknown {
  const code = concept(child(node, "code"));
  if (!code) return undefined;
  const t = times(child(node, "effectiveTime"));
  return {
    resourceType: "Procedure",
    id: idOf(node, `qrda1-procedure-${i}`),
    status: "completed",
    code,
    ...(t.point ? { performedDateTime: t.point } : {}),
    ...(t.start || t.end
      ? { performedPeriod: { ...(t.start ? { start: t.start } : {}), ...(t.end ? { end: t.end } : {}) } }
      : {}),
  };
}

/**
 * The date an ORDER was authored — `<author><time>`, falling back to the entry's own effectiveTime.
 *
 * The exclusion libraries read `authoredOn` on every request-shaped resource (ServiceRequest,
 * DeviceRequest, MedicationRequest), so an order imported without it retrieves by code and then fails
 * every temporal predicate — present in the bundle, invisible to the measure.
 */
function authoredOn(node: CdaNode): string | undefined {
  const authorTime = isoFromHl7(child(child(node, "author"), "time")?.attrs.value);
  if (authorTime) return authorTime;
  const t = times(child(node, "effectiveTime"));
  return t.point ?? t.start;
}

/** QDM Intervention, Order → `ServiceRequest`. */
function serviceRequestFrom(node: CdaNode, i: string): unknown {
  const code = concept(child(node, "code"));
  if (!code) return undefined;
  return {
    resourceType: "ServiceRequest",
    id: idOf(node, `qrda1-servicerequest-${i}`),
    // Both are READ: `Status.isInterventionOrder` requires `intent = 'order'` and an active-ish status.
    status: "active",
    intent: "order",
    code,
    ...(authoredOn(node) ? { authoredOn: authoredOn(node) } : {}),
  };
}

/**
 * QDM Device, Order → `DeviceRequest`.
 *
 * The device's code is NOT on the element carrying the template. `<supply>` has no `<code>` of its own;
 * the device hangs off `participant/participantRole/playingDevice/code`, and the only `<code>` anywhere
 * up the tree is the wrapping act's ActClass literal `SPLY`. So walking up — the obvious thing to do
 * when an element has no code — yields a DeviceRequest coded "Supply", which matches no value set and
 * looks exactly like a device the patient does not have.
 *
 * Deliberately no fallback to `node`'s own `<code>`: it is absent in this shape, so a fallback would be
 * unreachable code that reads as a safety net. (A first cut had one, and mutation-testing showed the
 * test that claimed to forbid the SPLY reading could not fail.)
 */
function deviceRequestFrom(node: CdaNode, i: string): unknown {
  const code = concept(child(descendants(node, "playingDevice")[0], "code"));
  if (!code) return undefined;
  return {
    resourceType: "DeviceRequest",
    id: idOf(node, `qrda1-devicerequest-${i}`),
    status: "active",
    intent: "order",
    codeCodeableConcept: code,
    ...(authoredOn(node) ? { authoredOn: authoredOn(node) } : {}),
  };
}

/**
 * QDM Medication, Active → `MedicationRequest`.
 *
 * The drug is in `consumable/manufacturedProduct/manufacturedMaterial/code` (RxNorm). Emitted as
 * `medicationCodeableConcept` rather than a contained `Medication` + reference: the retrieve filters the
 * `medication` choice by code, and an inline concept matches it without inventing a second resource.
 */
function medicationRequestFrom(node: CdaNode, i: string): unknown {
  const material = descendants(node, "manufacturedMaterial")[0];
  const code = concept(child(material, "code"));
  if (!code) return undefined;
  const t = times(child(node, "effectiveTime"));
  return {
    resourceType: "MedicationRequest",
    id: idOf(node, `qrda1-medicationrequest-${i}`),
    status: "active",
    intent: "order",
    medicationCodeableConcept: code,
    ...(authoredOn(node) ? { authoredOn: authoredOn(node) } : {}),
    ...(t.start || t.end
      ? {
          dispenseRequest: {
            validityPeriod: { ...(t.start ? { start: t.start } : {}), ...(t.end ? { end: t.end } : {}) },
          },
        }
      : {}),
  };
}

/**
 * QDM Symptom → `Observation`, with the symptom concept in `code`.
 *
 * Same inversion as Diagnosis: the element's `<code>` says only "this entry is a symptom" (LOINC 75325-1)
 * and the `<value>` carries the symptom itself. `[Observation: "Frailty Symptom"]` filters on
 * `Observation.code`, so the value is what must land there — putting it in `Observation.value` would
 * leave the retrieve matching nothing.
 */
function symptomFrom(node: CdaNode, i: string): unknown {
  // No fallback to the element's own `<code>`: it is the "this entry is a symptom" marker, which is in
  // no value set, so falling back to it would import a Symptom that retrieves nothing while looking
  // present. Mutation testing showed the equivalent fallback in `deviceRequestFrom` was unreachable
  // code that read as a safety net; this one is reachable and actively wrong (review, #388).
  const code = concept(child(node, "value"));
  if (!code) return undefined;
  const t = times(child(node, "effectiveTime"));
  return {
    resourceType: "Observation",
    id: idOf(node, `qrda1-symptom-${i}`),
    status: "final",
    code,
    ...(t.start && t.end
      ? { effectivePeriod: { start: t.start, end: t.end } }
      : (t.point ?? t.start)
        ? { effectiveDateTime: (t.point ?? t.start)! }
        : t.end
          ? { effectivePeriod: { end: t.end } }
          : {}),
  };
}

/** `<recordTarget>` → a FHIR Patient. */
function patientFrom(root: CdaNode): { resource: unknown; id: string } {
  const patientRole = child(child(root, "recordTarget"), "patientRole");
  const patient = child(patientRole, "patient");
  const id = childrenNamed(patientRole, "id").find((n) => n.attrs.extension)?.attrs.extension ?? "qrda1-subject";
  // Sex is the SNOMED `<translation>`, matching how the exporter writes it and how QI-Core reads it.
  const sexCode = child(child(patient, "administrativeGenderCode"), "translation")?.attrs.code;
  const name = child(patient, "name");
  const given = child(name, "given")?.text;
  const family = child(name, "family")?.text;
  // `Patient.birthDate` is a FHIR **date**, and `isoFromHl7` returns the full timestamp for the 14-digit
  // `birthTime` a QRDA carries — so this used to write `"1978-12-24T20:30:00Z"` into a date field.
  // Measured to change no population (the age predicates parsed it anyway), but it is invalid FHIR that
  // our own exporter would never produce.
  const birthDate = isoFromHl7(child(patient, "birthTime")?.attrs.value)?.slice(0, 10);
  return {
    id,
    resource: {
      resourceType: "Patient",
      id,
      ...(GENDER_FOR_SNOMED[sexCode ?? ""] ? { gender: GENDER_FOR_SNOMED[sexCode!] } : {}),
      // **`us-core-sex`, not just `gender`** — and this is the difference between a correct import and a
      // useless one. Official CMS125's initial population reads the US Core sex EXTENSION, never
      // `Patient.gender` (ADR-042 cost a measurement pass establishing exactly that, and
      // `devdb-official-eval.test.ts` pins that stripping it empties the whole roster from the IPP).
      // Writing only `gender` made every imported subject out-of-population for the measure this stack
      // actually routes to official — silently, with a 201 and no untranslated templates (review, #362).
      ...(sexCode
        ? {
            extension: [
              {
                url: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-sex",
                valueCode: sexCode,
              },
            ],
          }
        : {}),
      ...(birthDate ? { birthDate } : {}),
      ...(given || family ? { name: [{ ...(given ? { given: [given] } : {}), ...(family ? { family } : {}) }] } : {}),
    },
  };
}

export interface Qrda1Import {
  /** The subject's `Patient.id`, as the document identifies them. */
  patientId: string;
  /** A collection Bundle the measure engine can evaluate unchanged. */
  bundle: { resourceType: "Bundle"; type: "collection"; entry: Array<{ resource: unknown }> };
  /** Version-specific eMeasure UUID(s) the document references, in document order. */
  measureIdentifiers: string[];
  /** Local measure id when the document carries WorkWell's own urn (an authored-measure export). */
  localMeasureId?: string;
  /** QDM entries seen but not translated — surfaced so a gap is visible rather than silent. */
  untranslatedTemplates: string[];
}

/**
 * Parse a QRDA Category I document into a FHIR bundle the engine can evaluate.
 *
 * Throws `Qrda1ImportError` for input that is not a usable QRDA I. Refusing beats returning an empty
 * bundle: an empty bundle evaluates to out-of-population for every measure, which is indistinguishable
 * from a genuinely ineligible patient — the silent-failure shape ADR-043 exists to prevent.
 */
export function importQrda1Document(xml: string): Qrda1Import {
  const root = parseXml(xml);
  if (!root || root.local !== "ClinicalDocument") {
    throw new Qrda1ImportError("not a CDA document: no <ClinicalDocument> root");
  }
  const sections = descendants(root, "section");
  const patientData = sections.find((s) => hasTemplate(s, T.patientDataSection));
  if (!patientData) {
    throw new Qrda1ImportError(
      "not a QRDA Category I: no Patient Data Section QDM (2.16.840.1.113883.10.20.24.2.1)",
    );
  }

  const { id: patientId, resource: patient } = patientFrom(root);
  const entries: Array<{ resource: unknown }> = [{ resource: patient }];
  const untranslatedTemplates: string[] = [];

  childrenNamed(patientData, "entry").forEach((entry, i) => {
    // EVERY translatable datatype in the entry, not the first. A Result Organizer carrying two
    // Laboratory Tests, Performed is a standard CDA construct, and stopping at the first one dropped the
    // rest AND reported the entry as fully translated — so an HbA1c that is the second component of a
    // chemistry panel vanished with `untranslatedTemplates: []` (review, #362). Diagnosis is nested
    // inside a Diagnosis Concern Act, so the search descends rather than reading immediate children.
    const candidates = new Set<CdaNode>();
    for (const node of entry.children) {
      candidates.add(node);
      // `supply` and `substanceAdministration` are here because Device, Order and Medication, Active
      // hang their datatype template on those elements — omit them and both datatypes are invisible no
      // matter how good the mapper is.
      for (const kind of ["observation", "encounter", "procedure", "act", "supply", "substanceAdministration"] as const) {
        for (const found of descendants(node, kind)) candidates.add(found);
      }
    }
    let translated = 0;
    let index = 0;
    for (const candidate of candidates) {
      const key = `${i}-${index++}`;
      // QDM negation rationale: `negationInd="true"` means the act did NOT happen. Importing it as a
      // positive Procedure or Intervention would manufacture a denominator exclusion out of a record
      // stating the opposite — the worst failure available here, since it is silent and it fabricates
      // compliance-relevant data. Skipped, and the entry therefore reports its datatype as untranslated
      // (the diagnostic does not distinguish "negated" from other drops, which is a known limit).
      // Cypress's archives carry none, so this is latent rather than measured (review, #388).
      if (candidate.attrs.negationInd === "true") continue;
      const resource =
        hasTemplate(candidate, T.encounterPerformed) ? encounterFrom(candidate, key)
        : hasTemplate(candidate, T.diagnosis) ? conditionFrom(candidate, key)
        : hasTemplate(candidate, T.labPerformed) ? observationFrom(candidate, key, "laboratory")
        : hasTemplate(candidate, T.studyPerformed) ? observationFrom(candidate, key, "imaging")
        // A screening/assessment Observation keeps its own `<code>` (the instrument) and `<value>` (the
        // result) — unlike Symptom below, which inverts them.
        : hasTemplate(candidate, T.assessmentPerformed) ? observationFrom(candidate, key, "survey")
        : hasTemplate(candidate, T.symptom) ? symptomFrom(candidate, key)
        // Intervention, Performed IS a Procedure to the official artifacts — same retrieve, same
        // `performed` property — so it shares the mapper rather than getting a near-copy.
        : hasTemplate(candidate, T.procedurePerformed) || hasTemplate(candidate, T.interventionPerformed)
          ? procedureFrom(candidate, key)
        : hasTemplate(candidate, T.interventionOrder) ? serviceRequestFrom(candidate, key)
        : hasTemplate(candidate, T.deviceOrder) ? deviceRequestFrom(candidate, key)
        : hasTemplate(candidate, T.medicationActive) ? medicationRequestFrom(candidate, key)
        : undefined;
      if (resource !== undefined) {
        entries.push({ resource });
        translated++;
      }
    }
    if (translated === 0) {
      // Named, not counted: an operator needs to know WHICH datatype was dropped to know whether the
      // recalculation can be trusted. A bare count would read as "a few things we don't support".
      //
      // The DATATYPE template, not the last one in the entry. QDM nests attribute templates (Author
      // dateTime, Rank) inside the element carrying the datatype, and they sort last — so reporting the
      // last root blamed Author dateTime for 31 of CMS122's entries whose real gap was Assessment or
      // Intervention. Falls back to the last root only when no datatype template is present at all.
      const roots = descendants(entry, "templateId").map((t) => t.attrs.root).filter((r): r is string => r !== undefined);
      const datatypes = roots.filter((r) => r.startsWith("2.16.840.1.113883.10.20.24.3.") && !ATTRIBUTE_TEMPLATES.has(r));
      untranslatedTemplates.push(datatypes[0] ?? roots[roots.length - 1] ?? "(no templateId)");
    }
  });

  // A Patient-only bundle is the failure this whole module exists to avoid, and the section being
  // PRESENT but empty reaches it just as surely as the section being absent (Codex, #362). Our own
  // no-bundle export is exactly that document — it declares itself non-conformant (CONF:67-14567), so
  // importing it and persisting a plausible out-of-population outcome would launder a document that
  // says it cannot be calculated from.
  if (entries.length <= 1) {
    throw new Qrda1ImportError(
      untranslatedTemplates.length === 0
        ? "QRDA Category I has no Patient Data entries (CONF:67-14567) — nothing to calculate from"
        : `QRDA Category I has no entry this importer can translate; ${untranslatedTemplates.length} ` +
          `untranslated: ${[...new Set(untranslatedTemplates)].slice(0, 5).join(", ")}`,
    );
  }

  const measureSection = sections.find((s) => hasTemplate(s, T.measureSection));
  const references = descendants(measureSection, "externalDocument");
  const measureIdentifiers: string[] = [];
  let localMeasureId: string | undefined;
  for (const ref of references) {
    for (const id of childrenNamed(ref, "id")) {
      if (id.attrs.root === "2.16.840.1.113883.4.738" && id.attrs.extension) measureIdentifiers.push(id.attrs.extension);
      else if (id.attrs.root === "urn:workwell:measure" && id.attrs.extension) localMeasureId ??= id.attrs.extension;
    }
    // `<setId>` carries the VERSION-INDEPENDENT eMeasure id. A document naming its measure only that way
    // would otherwise match nothing, and the route's measure check would refuse a correct request
    // (review, #362).
    for (const setId of childrenNamed(ref, "setId")) {
      if (setId.attrs.root) measureIdentifiers.push(setId.attrs.root);
    }
  }

  return {
    patientId,
    bundle: { resourceType: "Bundle", type: "collection", entry: entries },
    measureIdentifiers,
    ...(localMeasureId ? { localMeasureId } : {}),
    untranslatedTemplates,
  };
}
