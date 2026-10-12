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
  medicationOrder: "2.16.840.1.113883.10.20.24.3.47",
  assessmentPerformed: "2.16.840.1.113883.10.20.24.3.144",
  physicalExamPerformed: "2.16.840.1.113883.10.20.24.3.59",
  symptom: "2.16.840.1.113883.10.20.24.3.136",
  result: "2.16.840.1.113883.10.20.24.3.87",
  encounterDiagnosis: "2.16.840.1.113883.10.20.24.3.168",
  rank: "2.16.840.1.113883.10.20.24.3.166",
  negationRationale: "2.16.840.1.113883.10.20.24.3.88",
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
  T.rank,
  "2.16.840.1.113883.10.20.24.3.162", // Participant
  T.encounterDiagnosis,
  T.negationRationale,
  "2.16.840.1.113883.10.20.24.3.137", // Diagnosis Concern Act (wrapper)
  "2.16.840.1.113883.10.20.24.3.138", // Symptom Concern Act (wrapper)
  "2.16.840.1.113883.10.20.24.3.130", // Device Order Act (wrapper; the datatype is on the <supply>)
  T.result,
]);

/** SNOMED sex concept → FHIR `Patient.gender`, inverting the export's `SEX_CONCEPTS`. */
const GENDER_FOR_SNOMED: Record<string, string> = { "248152002": "female", "248153007": "male" };

export class Qrda1ImportError extends Error {}

/**
 * `negationInd` true, in either XML Schema boolean spelling (`true`, `1`) and any case or padding: read as
 * positive, a negated act becomes a fact the document denies (Codex + review, #787).
 */
function isNegatedNode(node: CdaNode): boolean {
  const negation = node.attrs.negationInd?.trim().toLowerCase();
  return negation === "true" || negation === "1";
}

/** CDA's act classes: the elements whose `negationInd` says the act itself did not happen. */
const ACT_CLASSES = new Set(["act", "observation", "procedure", "encounter", "substanceAdministration", "supply", "organizer", "observationMedia", "regionOfInterest"]);

/**
 * HL7 `YYYYMMDDHHMMSS[±ZZZZ]` → ISO-8601, or undefined when absent/nullFlavored/unparseable.
 *
 * The **offset is kept as stated** (#788): `20251231200000-1000` is `2025-12-31T20:00:00-10:00`, the
 * instant the document states, on the day it states. Dropping the offset would move the instant (Codex,
 * #362). Converting to UTC kept the instant but moved the day, and the year on 31 December: CMS's FHIR logic
 * can read an event's day in its own offset, so a Maui visit at 5 pm on 31 December (03:00 UTC on 1
 * January) left the measurement year and took the patient out of the population. C-CDA's US Realm Date
 * and Time asks for an offset (CONF:81-10130, a SHOULD) and CMS_0121 asks a document to state offsets
 * everywhere or nowhere, so a conformant document may well carry one. A time with no offset is read as UTC
 * (`Z`), as before. An offset beyond ±14:00 is no zone FHIR can state, so it makes the value no timestamp.
 */
function isoFromHl7(value: string | undefined): string | undefined {
  // The WHOLE value must be an HL7 TS: a date, an optional time to the second with an optional fraction,
  // and, after a time, an optional ±HHMM offset (the CDA schema allows none on a date). A colon in the
  // offset or anything trailing makes it no timestamp, rather than a different instant than the one stated
  // (review, #787).
  if (!value || !/^\d{8}(\d{2}(\d{2}(\d{2}(\.\d+)?)?)?([+-]\d{4})?)?$/.test(value)) return undefined;
  const [y, mo, d] = [value.slice(0, 4), value.slice(4, 6), value.slice(6, 8)];
  if (y === "0000") return undefined; // FHIR has no year zero
  const offset = /([+-])(\d{2})(\d{2})$/.exec(value);
  const digits = offset ? value.slice(0, value.length - 5) : value;
  // An hour without minutes keeps the date only, and an hour that is not one makes it no timestamp.
  if (digits.length >= 10 && Number(digits.slice(8, 10)) > 23) return undefined;
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
  if (Number.isNaN(parsed.getTime())) return undefined;
  // The components must survive the parse. `new Date` rolls an impossible day over instead of failing
  // (`20250230120000` became 2 March), which would import a date the document never stated (Codex, #787).
  const offsetMinutes = offset ? (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) : 0;
  // Written as stated, so checked here rather than left to what `new Date` happens to refuse (review, #788).
  if (Math.abs(offsetMinutes) > 14 * 60 || (offset && Number(offset[3]) > 59)) return undefined;
  const local = new Date(parsed.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 19);
  if (local !== `${y}-${mo}-${d}T${h}:${mi}:${s}`) return undefined;
  return `${local}${zone}`;
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
function times(node: CdaNode | undefined): { point?: string; start?: string; end?: string; endUnknown?: boolean } {
  if (!node) return {};
  const point = isoFromHl7(node.attrs.value);
  if (point) return { point };
  const high = child(node, "high");
  const end = isoFromHl7(high?.attrs.value);
  // THREE states, not two (#594). An absent `<high>` and a `<high nullFlavor="UNK"/>` both yield no
  // end date, and collapsing them loses the only thing that says whether the source made an
  // assertion: `nullFlavor="UNK"` is an explicit "this has not ended, and I do not know when it
  // will" - QDM open prevalence - while an absent element is silence. One licenses reporting the
  // condition as active; the other licenses nothing.
  //
  // **It is the nullFlavor that says so, not the absence of a parsed date** (Codex review). The first
  // cut asked `high !== undefined && end === undefined`, which is also true of `<high
  // value="20240230"/>` - a value the source DID assert and this importer could not parse. Reading
  // that as an open interval would report `active` for a diagnosis whose end date we simply failed to
  // understand, and that status can put the condition into a measure population. A malformed value is
  // neither a closed interval nor an open one: it is a parse failure, and it says nothing.
  const endUnknown = end === undefined && typeof high?.attrs.nullFlavor === "string" && high.attrs.nullFlavor.length > 0;
  return {
    start: isoFromHl7(child(node, "low")?.attrs.value),
    end,
    ...(endUnknown ? { endUnknown: true } : {}),
  };
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

/**
 * The CDA `<id>` as a FHIR identifier: the root names the assigning authority, the extension the id
 * within it. The FHIR `id` is deliberately root-agnostic (`idOf`), so this is what keeps two authorities'
 * entry "1" apart, and the batch merge compares it when deciding whether two documents repeat one entry.
 * A root that is an OID or a UUID gets its URN (a UUID lower-cased, as RFC 4122 compares it); any other
 * root that is a URI is used as it is; anything else is left out rather than turned into a system it is
 * not. A root with no extension is a complete identifier on its own (HL7 V3 II), carried as the URI value
 * of an `urn:ietf:rfc:3986` identifier. A null-flavored id is the sender saying it has none.
 */
function identifierOf(node: CdaNode): { identifier?: Array<{ system: string; value: string }> } {
  const asUri = (root: string): string | undefined =>
    /^\d+(\.\d+)+$/.test(root)
      ? `urn:oid:${root}`
      : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(root)
        ? `urn:uuid:${root.toLowerCase()}`
        : /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(root)
          ? root
          : undefined;
  const ids = childrenNamed(node, "id");
  // The same element `idOf` names the resource by: the first id with an extension.
  const withExtension = ids.find((n) => n.attrs.extension);
  if (withExtension) {
    const root = withExtension.attrs.root;
    const system = root && !withExtension.attrs.nullFlavor ? asUri(root) : undefined;
    return system ? { identifier: [{ system, value: withExtension.attrs.extension! }] } : {};
  }
  const rootOnly = ids.find((n) => n.attrs.root && !n.attrs.nullFlavor);
  const value = rootOnly ? asUri(rootOnly.attrs.root!) : undefined;
  return value ? { identifier: [{ system: "urn:ietf:rfc:3986", value }] } : {};
}

/**
 * An Encounter, Performed → the Encounter, plus one Condition per QDM Encounter Diagnosis it carries.
 *
 * QI-Core links an encounter to its diagnoses by reference to `encounter-diagnosis` Conditions, and
 * that link is how CMS137 finds an earlier substance-use diagnosis made at a visit
 * (`CQMCommon.encounterDiagnosis`). Dropped, a patient whose history is an
 * encounter diagnosis looks like a new episode and enters the population (Cypress 2027 deck: 3 of 3
 * over-counts). The Condition carries what the entry says, the code and the rank, and nothing it does
 * not: an Encounter Diagnosis has no onset or verification status of its own, so neither is given.
 *
 * Condition ids are unique within the document even when a sender repeats an encounter id: the library
 * resolves each reference with `singleton from`, which throws on two matches. `conditionIds` is the
 * document's running set.
 */
function encounterFrom(node: CdaNode, i: string, conditionIds: Set<string>): unknown[] {
  const id = idOf(node, `qrda1-encounter-${i}`);
  const diagnoses = descendants(node, "observation")
    .filter((n) => hasTemplate(n, T.encounterDiagnosis))
    .map((n) => {
      const code = concept(child(n, "value"));
      if (!code) return undefined;
      const rankNode = descendants(n, "observation").find((r) => hasTemplate(r, T.rank));
      const rank = Number(child(rankNode, "value")?.attrs.value);
      return { code, ...(Number.isInteger(rank) && rank > 0 ? { rank } : {}) };
    })
    .filter((d): d is { code: NonNullable<ReturnType<typeof concept>>; rank?: number } => d !== undefined);
  const conditions = diagnoses.map((d, k) => {
    // A FHIR id is `[A-Za-z0-9.-]{1,64}`, and a `/` in it would also break the reference match. The
    // fallback is built from the candidate key, which is unique within the document.
    const preferred = `${id}-dx-${k + 1}`;
    let conditionId =
      /^[A-Za-z0-9.-]{1,64}$/.test(preferred) && !conditionIds.has(preferred) ? preferred : `qrda1-condition-${i}-dx-${k + 1}`;
    for (let n = 2; conditionIds.has(conditionId); n++) conditionId = `qrda1-condition-${i}-dx-${k + 1}-${n}`;
    conditionIds.add(conditionId);
    return {
      resourceType: "Condition",
      id: conditionId,
      category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "encounter-diagnosis" }] }],
      code: d.code,
    };
  });
  const encounter = encounterResource(node, id);
  if (conditions.length > 0) {
    // `reasonReference` is what `CQMCommon.encounterDiagnosis` (CMS137's history) follows.
    // `diagnosis` is where FHIR records an encounter diagnosis with its rank; no routed measure reads it
    // today (`PrincipalDiagnosis` would also need a `use` the document does not state).
    encounter.reasonReference = conditions.map((c) => ({ reference: `Condition/${c.id}` }));
    encounter.diagnosis = conditions.map((c, k) => ({
      condition: { reference: `Condition/${c.id}` },
      ...(diagnoses[k]!.rank !== undefined ? { rank: diagnoses[k]!.rank } : {}),
    }));
  }
  return [encounter, ...conditions];
}

function encounterResource(node: CdaNode, id: string): Record<string, unknown> {
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
    id,
    ...identifierOf(node),
    status: "finished",
    ...(type ? { type: [type] } : {}),
    ...(dischargeDisposition ? { hospitalization: { dischargeDisposition } } : {}),
    ...(t.start || t.end || t.point
      ? { period: { ...(t.start ?? t.point ? { start: t.start ?? t.point } : {}), ...(t.end ? { end: t.end } : {}) } }
      : {}),
  };
}

const CONDITION_CLINICAL = "http://terminology.hl7.org/CodeSystem/condition-clinical";

/**
 * The clinical status this document actually asserts, or nothing (#594).
 *
 * Until 2026-09-21 no `clinicalStatus` was emitted here at all and `prepareForQiCore` minted `active`
 * for every imported Condition - including one carrying an `abatementDateTime`, i.e. one this very
 * function had just recorded as ended. Preparation may no longer invent it, so the mapping belongs
 * where the source semantics are known, which is here.
 *
 * Derived from the effective time and nothing else, because that is the only thing a QRDA-I Diagnosis
 * entry says about it:
 * - a `<high>` with a real value closes the interval, so the condition ENDED - `resolved`, matching
 *   the `abatementDateTime` emitted from the same value;
 * - a `<high nullFlavor="UNK"/>` is QDM open prevalence: the source states there is no known end, so
 *   `active` is a faithful reading of an explicit assertion;
 * - no `<high>` at all is SILENCE, and silence authorizes nothing. The field is omitted, the QI-Core
 *   profile is unsatisfied, and the condition is not retrieved - the honest outcome for a document
 *   that did not say.
 *
 * The system is written here rather than left for preparation to add, so the value this file emits is
 * bindable on its own terms.
 */
function clinicalStatusFrom(t: { end?: string; endUnknown?: boolean }): unknown {
  if (t.end) return { coding: [{ system: CONDITION_CLINICAL, code: "resolved" }] };
  if (t.endUnknown) return { coding: [{ system: CONDITION_CLINICAL, code: "active" }] };
  return undefined;
}

/**
 * QDM "Anatomical Location Site" (`<targetSiteCode>`, one per site) → `bodySite`, on a Diagnosis and a
 * Procedure (#784).
 *
 * CMS125 reads it in both years: CMS125FHIR v1.0.000 counts an "Unilateral Mastectomy, Unspecified
 * Laterality" condition as left or right by its `bodySite` qualifier, and the 2027 translation counts an
 * "Unilateral Mastectomy" procedure by its "Entire left/right breast" `bodySite`. Dropped, an imported
 * patient with a mastectomy on each side stayed in the denominator.
 *
 * Only the element's direct children are read, so a site belonging to a nested observation is never
 * lifted onto its parent. Each site goes through `concept()`, so an unmapped system is dropped and no
 * site at all leaves `bodySite` absent.
 */
function bodySiteOf(node: CdaNode): { bodySite: unknown[] } | Record<string, never> {
  const sites = childrenNamed(node, "targetSiteCode")
    .map((site) => concept(site))
    .filter((site) => site !== undefined);
  return sites.length > 0 ? { bodySite: sites } : {};
}

function conditionFrom(node: CdaNode, i: string): unknown {
  const t = times(child(node, "effectiveTime"));
  // The patient's condition is the VALUE; `<code>` says only "this entry is a diagnosis".
  const code = concept(child(node, "value"));
  if (!code) return undefined;
  const clinicalStatus = clinicalStatusFrom(t);
  return {
    resourceType: "Condition",
    id: idOf(node, `qrda1-condition-${i}`),
    ...identifierOf(node),
    verificationStatus: { coding: [{ code: "confirmed" }] },
    ...(clinicalStatus ? { clinicalStatus } : {}),
    code,
    ...bodySiteOf(node),
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
  const nested = ownResultsOf(node)[0];
  const valueNode = child(nested ?? node, "value") ?? child(node, "value");
  // Only a value that IS a number. `Number("")` and `Number(" ")` are 0, so an empty `value` attribute
  // would otherwise import as a result of zero, a fact the document never stated (Codex, #787).
  // And a value carrying a nullFlavor states that the value is missing, whatever number sits beside it.
  const number = valueNode?.attrs["xsi:type"] === "PQ" && !valueNode.attrs.nullFlavor ? decimalOf(valueNode.attrs.value) : undefined;
  const quantity = number !== undefined ? { value: number, ...(valueNode!.attrs.unit ? { unit: valueNode!.attrs.unit } : {}) } : undefined;
  const coded = valueNode?.attrs["xsi:type"] === "CD" ? concept(valueNode) : undefined;
  // A result written as text. CMS130 asks only that a stool test HAS a result (`value is not null`), and
  // Cypress writes those results as `<value xsi:type="ST">Negative</value>`: dropped, 12 of 16 of its
  // numerator patients read as unscreened.
  const text = valueNode?.attrs["xsi:type"] === "ST" && valueNode.text ? valueNode.text : undefined;
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
    ...identifierOf(node),
    status: "final",
    category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: category }] }],
    code,
    ...when,
    ...(quantity ? { valueQuantity: quantity } : {}),
    ...(coded ? { valueCodeableConcept: coded } : {}),
    ...(text ? { valueString: text } : {}),
  };
}

/**
 * A node's OWN Results: Result observations under its direct `entryRelationship`s, never one belonging to
 * another observation nested further down, which would lend this reading someone else's value (review,
 * #787). A negated Result, or one under a negated relationship, is not this node's result (review, #787).
 */
function ownResultsOf(node: CdaNode): CdaNode[] {
  return childrenNamed(node, "entryRelationship")
    .filter((relationship) => !isNegatedNode(relationship))
    .map((relationship) => child(relationship, "observation"))
    .filter((n): n is CdaNode => n !== undefined && hasTemplate(n, T.result) && !isNegatedNode(n));
}

/** Every value a reading states: its own `<value>`s and its own Results'. One blood-pressure half states one. */
function statedValuesOf(node: CdaNode): CdaNode[] {
  return [...childrenNamed(node, "value"), ...ownResultsOf(node).flatMap((result) => childrenNamed(result, "value"))];
}

/**
 * The number a CDA REAL / PQ value states, or undefined when it states none: the lexical form is a decimal,
 * optionally signed, optionally with an exponent; one too large for a double is no number, and one too small
 * is not zero (review, #787).
 */
function decimalOf(lexical: string | undefined): number | undefined {
  if (lexical === undefined || !DECIMAL.test(lexical)) return undefined;
  const n = Number(lexical);
  if (!Number.isFinite(n)) return undefined;
  return n === 0 && /[1-9]/.test(lexical.split(/[eE]/)[0]!) ? undefined : n;
}

const OBSERVATION_CATEGORY = "http://terminology.hl7.org/CodeSystem/observation-category";
/** The lexical form of a CDA REAL / PQ value: a decimal, optionally signed, optionally with an exponent. */
const DECIMAL = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/;
const LOINC = "http://loinc.org";
const UCUM = "http://unitsofmeasure.org";
const SYSTOLIC = "8480-6";
const DIASTOLIC = "8462-4";

type ObservationShape = {
  id?: string;
  identifier?: unknown[];
  code?: { coding?: Array<{ system?: string; code?: string }> };
  valueQuantity?: { value?: number; unit?: string };
};

/** A blood-pressure-coded Observation the walk imported: its index in the import's entries, and its CDA element. */
interface BloodPressureReading {
  index: number;
  node: CdaNode;
}

/**
 * Which half of a blood pressure an Observation's own code states: "systolic" (8480-6), "diastolic"
 * (8462-4), "both" when it states both (it says neither which half it is: it pairs with nothing, and blocks
 * a pair at its time, review #787), or undefined. These are the two codes §4A.8 names and the two CMS165's
 * own logic reads; a reading under another code (sitting, standing, invasive, a SNOMED concept) is neither
 * half, and neither pairs nor blocks.
 */
function bloodPressureHalfOf(resource: unknown): "systolic" | "diastolic" | "both" | undefined {
  const codes = ((resource as ObservationShape).code?.coding ?? []).filter((c) => c.system === LOINC).map((c) => c.code);
  if (codes.includes(SYSTOLIC) && codes.includes(DIASTOLIC)) return "both";
  if (codes.includes(SYSTOLIC)) return "systolic";
  if (codes.includes(DIASTOLIC)) return "diastolic";
  return undefined;
}

/**
 * Blood-pressure readings left as separate Observations, of any template: CMS165 reads a blood pressure only
 * as a panel, so it does not read one of these as a blood pressure (in a batch, the same reading may also sit
 * in a panel another of the person's documents formed). A "not done" (`status: cancelled`) is no reading.
 * Counted on a finished bundle, so a person's documents merged into one count each reading once (review,
 * #787).
 */
export function unpairedBloodPressureReadingsIn(resources: readonly unknown[]): number {
  return resources.filter((r) => {
    const o = r as { resourceType?: unknown; status?: unknown } | null;
    return o?.resourceType === "Observation" && o.status !== "cancelled" && bloodPressureHalfOf(r) !== undefined;
  }).length;
}

/** One HL7 timestamp as the document states it. */
interface StatedTimestamp {
  /** The first UTC instant its stated precision covers, in nanoseconds: a date is a whole day, `…1710` a whole
   *  minute, `…00.25` a hundredth of a second. With no offset it is read as UTC, the convention every
   *  imported entry follows. */
  start: bigint;
  /** The end of that precision, exclusive. */
  end: bigint;
  /** What identity compares: the precision (a minute, a second and a tenth of a second are different
   *  statements), and either the instant, when an offset is stated, or the digits as written, when none is:
   *  without an offset a time names no instant, so it never equals one that does (review, #787). */
  key: string;
  /** For a time of day, the FHIR dateTime IN THE STATED OFFSET (`Z` only when none is stated). CMS165 reads a
   *  reading's day in its own offset, so `20251231200000-0500` written as `2026-01-01T01:00:00Z` would move
   *  it into the next measurement year (review, #787). */
  fhir?: string;
  fractionDigits: number;
  offsetMinutes?: number;
}

const TIMESTAMP = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:\.(\d+))?)?)?(?:([+-])(\d{2})(\d{2}))?)?$/;
const NS_PER_MS = 1_000_000n;

/** A timestamp as stated, or undefined when it is not a real one (`isoFromHl7` decides that). */
function statedTimestamp(value: string | undefined): StatedTimestamp | undefined {
  if (value === undefined || isoFromHl7(value) === undefined) return undefined;
  const m = TIMESTAMP.exec(value);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, fraction, sign, oh, om] = m;
  const offsetMinutes = sign ? (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om)) : undefined;
  // `setUTCFullYear`, not `Date.UTC`, which reads the years 0-99 as 1900-1999.
  const local = new Date(0);
  local.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  local.setUTCHours(Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0), 0);
  const digits = fraction?.replace(/0+$/, "") ?? "";
  const start = BigInt(local.getTime() - (offsetMinutes ?? 0) * 60_000) * NS_PER_MS + BigInt(`${digits}000000000`.slice(0, 9));
  const unit =
    h === undefined ? 86_400_000_000_000n
    : mi === undefined ? 3_600_000_000_000n
    : s === undefined ? 60_000_000_000n
    : 10n ** BigInt(Math.max(0, 9 - (fraction?.length ?? 0)));
  const precision =
    h === undefined ? "date" : mi === undefined ? "hour" : s === undefined ? "minute" : `second${fraction !== undefined ? `.${fraction.length}` : ""}`;
  const written = `${y}${mo}${d}${h ?? ""}${mi ?? ""}${s ?? ""}${fraction !== undefined ? `.${fraction}` : ""}`;
  return {
    start,
    end: start + unit,
    key: `${precision} ${offsetMinutes === undefined ? `as written ${written}` : `instant ${start}`}`,
    ...(mi !== undefined
      ? { fhir: `${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}${fraction !== undefined ? `.${fraction}` : ""}${sign ? `${sign}${oh}:${om}` : "Z"}` }
      : {}),
    fractionDigits: fraction?.length ?? 0,
    ...(offsetMinutes !== undefined ? { offsetMinutes } : {}),
  };
}

/** Attributes an `<effectiveTime>` or a bound may carry; any other is not a time this importer reads. */
const TIME_ATTRIBUTES = new Set(["value", "xsi:type", "operator"]);
const BOUND_ATTRIBUTES = new Set(["value", "inclusive", "xsi:type"]);
const onlyAttributes = (n: CdaNode, allowed: Set<string>) => Object.keys(n.attrs).every((k) => allowed.has(k) || k.startsWith("xmlns"));
/** An absent `xsi:type`, or one naming a type the element's schema type already is (`IVL_TS`, …). */
const timeTypeIs = (n: CdaNode, types: readonly string[]) => {
  const type = n.attrs["xsi:type"]?.trim();
  return type === undefined || types.includes(type.slice(type.indexOf(":") + 1));
};

/** The panel's time and the key both halves must share. */
interface PanelTime {
  effective: { effectiveDateTime: string } | { effectivePeriod: { start: string; end: string } };
  key: string;
}

/**
 * The time a reading pairs on, under §4A.8's "an identical time that includes a time of day: the same
 * instant, or the same low and high", or undefined when it states no such time. Read off the CDA
 * `<effectiveTime>` itself, never the FHIR value built from it, which is lossy (Codex, #787):
 * - an instant: a `value`, with nothing under it;
 * - a closed interval: one `<low>` and one `<high>` and nothing else, each a timestamp, neither exclusive,
 *   both or neither stating an offset, the low not after the high.
 * Each timestamp needs a time of day (an hour and a minute), at most nine digits of a second (FHIR's limit)
 * and an offset FHIR can state. An open interval (`<high nullFlavor="UNK"/>`, or no `<high>`) states no
 * high: the import's general conversion reads it as an instant at its low, and a panel built from that would
 * state a time the document did not (Codex, #787). A width, a center, a nullFlavor, an exclusive bound or an
 * `operator` other than inclusion has no FHIR Period form. Two spellings of one statement (a redundant
 * `xsi:type="IVL_TS"`, `inclusive="true"`, another offset for the same instant) share a key (review, #787).
 */
function panelTimeOf(node: CdaNode): PanelTime | undefined {
  const time = child(node, "effectiveTime");
  if (!time || !onlyAttributes(time, TIME_ATTRIBUTES) || !timeTypeIs(time, ["IVL_TS", "TS"])) return undefined;
  if (time.attrs.operator !== undefined && time.attrs.operator.trim() !== "I") return undefined;
  const usable = (t: StatedTimestamp | undefined): t is StatedTimestamp & { fhir: string } =>
    t?.fhir !== undefined && t.fractionDigits <= 9 && Math.abs(t.offsetMinutes ?? 0) <= 14 * 60;
  if (time.attrs.value !== undefined) {
    const at = time.children.length === 0 ? statedTimestamp(time.attrs.value) : undefined;
    return usable(at) ? { effective: { effectiveDateTime: at.fhir }, key: `at ${at.key}` } : undefined;
  }
  if (time.children.map((c) => c.local).sort().join() !== "high,low") return undefined;
  const bound = (b: CdaNode) => {
    const inclusive = b.attrs.inclusive?.trim().toLowerCase();
    const closed = inclusive === undefined || inclusive === "true" || inclusive === "1";
    return closed && b.children.length === 0 && onlyAttributes(b, BOUND_ATTRIBUTES) && timeTypeIs(b, ["IVXB_TS", "TS"])
      ? statedTimestamp(b.attrs.value)
      : undefined;
  };
  const low = bound(child(time, "low")!);
  const high = bound(child(time, "high")!);
  if (!usable(low) || !usable(high) || (low.offsetMinutes === undefined) !== (high.offsetMinutes === undefined) || low.start > high.start) {
    return undefined;
  }
  return { effective: { effectivePeriod: { start: low.fhir, end: high.fhir } }, key: `from ${low.key} to ${high.key}` };
}

/** The instants a reading's stated time could cover; an absent bound is unbounded. */
interface TimeRange {
  start?: bigint;
  end?: bigint;
  /** Whether its timestamps state an offset; undefined when it states no timestamp. */
  zoned?: boolean;
}

/**
 * Every instant a reading's `<effectiveTime>` could mean, whatever its shape: an instant covers its stated
 * precision, an interval runs from its low's start to its high's end, an open side is unbounded, and a time
 * that cannot be placed (none, a nullFlavor, a center or a width, an unparseable value) could be any time.
 */
function rangeOf(node: CdaNode): TimeRange {
  const time = child(node, "effectiveTime");
  if (!time || time.attrs.nullFlavor !== undefined) return {};
  if (time.attrs.value !== undefined) {
    const at = time.children.length === 0 ? statedTimestamp(time.attrs.value) : undefined;
    return at ? { start: at.start, end: at.end, zoned: at.offsetMinutes !== undefined } : {};
  }
  if (child(time, "center") || child(time, "width")) return {};
  const low = statedTimestamp(child(time, "low")?.attrs.value);
  const high = statedTimestamp(child(time, "high")?.attrs.value);
  // Bounds that disagree on stating a zone, or that run backwards, place the reading nowhere in particular:
  // it could be any time (review, #787).
  if (low && high && ((low.offsetMinutes === undefined) !== (high.offsetMinutes === undefined) || low.start > high.start)) return {};
  const stated = low ?? high;
  return {
    ...(low ? { start: low.start } : {}),
    ...(high ? { end: high.end } : {}),
    ...(stated ? { zoned: stated.offsetMinutes !== undefined } : {}),
  };
}

/** The widest offset either side of UTC a time with no zone could have been stated in. */
const ZONE_UNCERTAINTY = 14n * 3_600_000_000_000n;

/**
 * A range stated with no zone, met with one stated in a zone, could be in any zone: it is widened by the
 * widest offset either way. A date with no zone (`20251231`) is then still the same day as a pair at
 * `20251231200000-0500`, which CMS165 reads on 31 December, though in UTC the two never meet (review,
 * #787). Two ranges both with or both without a zone are compared as they stand.
 */
const widenedFor = (r: TimeRange, other: TimeRange): TimeRange =>
  r.zoned === false && other.zoned === true
    ? { ...(r.start !== undefined ? { start: r.start - ZONE_UNCERTAINTY } : {}), ...(r.end !== undefined ? { end: r.end + ZONE_UNCERTAINTY } : {}) }
    : r;

const rangesOverlap = (x: TimeRange, y: TimeRange) => {
  const [a, b] = [widenedFor(x, y), widenedFor(y, x)];
  return (a.start === undefined || b.end === undefined || a.start < b.end) && (b.start === undefined || a.end === undefined || b.start < a.end);
};

/**
 * What a reading states about who, how, where and with what. Two halves of one panel state the same.
 * Compared as written (`statedContentOf`), never through the import's code-system map: a method in a system
 * the map does not carry is still a stated method, and two different ones are still different (Codex, #787).
 * Every repetition and everything under it counts: a second method, a laterality qualifier on a site, an
 * originalText behind a nullFlavor (review, #787).
 */
function statedContextOf(node: CdaNode): string {
  return JSON.stringify({
    // Everything a performer element states, not just its ids: two performers who share a null-flavored id
    // and differ by name are different people (Codex, #787).
    performers: childrenNamed(node, "performer").map(statedContentOf),
    // Every participant, whatever its role: QRDA I states a QDM Performer as `participant typeCode="PRF"`
    // (Participant, …24.3.162) and a device as `typeCode="DEV"` (standards review, #787).
    participants: childrenNamed(node, "participant").map(statedContentOf),
    methods: childrenNamed(node, "methodCode").map(statedContentOf),
    sites: childrenNamed(node, "targetSiteCode").map(statedContentOf),
  });
}

/** An element and everything under it, as stated: names, attributes in a fixed order, and text. */
function statedContentOf(node: CdaNode): unknown {
  const attrs = Object.keys(node.attrs).sort().map((k) => [k, node.attrs[k]]);
  return [node.local, attrs, node.text, node.children.map(statedContentOf)];
}

/**
 * Pair a document's blood-pressure readings into US Core panels, under LOCKED §4A.8 and nowhere else.
 *
 * QRDA states a blood pressure as two Physical Exam, Performed entries, a systolic (8480-6) and a
 * diastolic (8462-4) at the same time; CMS165's FHIR logic reads one only as a panel (85354-9) carrying
 * both as components. Two readings become one panel only when every condition holds:
 * - both are `candidates`: Physical Exam readings that are their entry's own act, never one inside an
 *   organizer or another act, whose wrapper can state a performer, a device or a status of its own
 *   (review, #787);
 * - one systolic and one diastolic share an identical time (`panelTimeOf`), and no other blood-pressure
 *   reading of any template (`blockers`) states a time that could fall within it: an instant inside the
 *   pair's interval, an interval or open interval touching it, or a time that cannot be placed at all
 *   (review, #787);
 * - each states exactly one value, a number in mm[Hg] (a second value, or a value from a Result beside its
 *   own, is not one blood pressure, review #787);
 * - each is an event that happened (`moodCode="EVN"`, `statusCode="completed"`), and both state the same
 *   performer, participants, method and site.
 * The panel takes the systolic's place and id, keeps both readings' source identifiers (the batch merge
 * recognises a repeated entry by them) and their shared site and method when one of each is stated, and
 * states nothing the two readings did not: their codes and values, their time in its stated offset,
 * `final`. `prepareForQiCore` then stamps `us-core-blood-pressure` from those codes. A negated reading never
 * reaches here (the walk skips it), and no `Observation.encounter` is supplied: the document does not state
 * one.
 *
 * Mutates `entries`: each panel replaces its systolic, and its diastolic is removed.
 */
function pairBloodPressures(entries: Array<{ resource: unknown }>, candidates: BloodPressureReading[], blockers: BloodPressureReading[]): void {
  const byTime = new Map<string, Array<{ reading: BloodPressureReading; time: PanelTime }>>();
  for (const reading of candidates) {
    const time = panelTimeOf(reading.node);
    if (time !== undefined) byTime.set(time.key, [...(byTime.get(time.key) ?? []), { reading, time }]);
  }
  const removed = new Set<number>();
  for (const group of byTime.values()) {
    if (group.length !== 2) continue;
    const half = (r: BloodPressureReading) => bloodPressureHalfOf(entries[r.index]!.resource);
    const s = group.find((g) => half(g.reading) === "systolic");
    const d = group.find((g) => half(g.reading) === "diastolic");
    if (!s || !d) continue;
    const at = rangeOf(s.reading.node);
    const pair = new Set([s.reading.index, d.reading.index]);
    if (blockers.some((b) => !pair.has(b.index) && rangesOverlap(rangeOf(b.node), at))) continue;
    // One value, the reading's own: a Result is this reading's only when its code states the same half and
    // only that half, read as a reading's own code is (`bloodPressureHalfOf`). A Result coded as the other
    // half, or as both (one code and the other as a translation), is not (review, #787).
    const mmHg = (r: BloodPressureReading) => {
      const q = (entries[r.index]!.resource as ObservationShape).valueQuantity;
      const resultsAreOwn = ownResultsOf(r.node).every((result) => bloodPressureHalfOf({ code: concept(child(result, "code")) }) === half(r));
      return statedValuesOf(r.node).length === 1 && resultsAreOwn && typeof q?.value === "number" && Number.isFinite(q.value) && q.unit === "mm[Hg]";
    };
    // A reading that happened: an event (not an intent), completed (not aborted or nullified) (review, #787).
    const happened = (r: BloodPressureReading) => r.node.attrs.moodCode === "EVN" && child(r.node, "statusCode")?.attrs.code === "completed";
    if (!mmHg(s.reading) || !mmHg(d.reading) || !happened(s.reading) || !happened(d.reading)) continue;
    if (statedContextOf(s.reading.node) !== statedContextOf(d.reading.node)) continue;
    const sys = entries[s.reading.index]!.resource as ObservationShape;
    const dia = entries[d.reading.index]!.resource as ObservationShape;
    const component = (o: ObservationShape) => ({
      code: o.code,
      valueQuantity: { value: o.valueQuantity!.value, unit: "mm[Hg]", system: UCUM, code: "mm[Hg]" },
    });
    const identifier = [...new Map([...(sys.identifier ?? []), ...(dia.identifier ?? [])].map((id) => [JSON.stringify(id), id])).values()];
    // The site and method both halves state (the context rule makes them the same), when one of each is
    // stated and mapped: a FHIR Observation carries one of each.
    const sites = childrenNamed(s.reading.node, "targetSiteCode");
    const methods = childrenNamed(s.reading.node, "methodCode");
    const bodySite = sites.length === 1 ? concept(sites[0]) : undefined;
    const method = methods.length === 1 ? concept(methods[0]) : undefined;
    entries[s.reading.index] = {
      resource: {
        resourceType: "Observation",
        id: sys.id,
        ...(identifier.length > 0 ? { identifier } : {}),
        status: "final",
        category: [{ coding: [{ system: OBSERVATION_CATEGORY, code: "vital-signs" }] }],
        code: { coding: [{ system: LOINC, code: "85354-9", display: "Blood pressure panel with all children optional" }] },
        // The time as the document states it, offset included (both halves share it).
        ...s.time.effective,
        ...(bodySite ? { bodySite } : {}),
        ...(method ? { method } : {}),
        component: [component(sys), component(dia)],
      },
    };
    removed.add(d.reading.index);
  }
  if (removed.size > 0) {
    const kept = entries.filter((_, i) => !removed.has(i));
    entries.length = 0;
    entries.push(...kept);
  }
}
const QICORE_NOT_DONE_REASON = "http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-notDoneReason";

/**
 * QDM Assessment, Not Performed (an Assessment, Performed with `negationInd="true"` and a Negation
 * Rationale) → the QI-Core shape for "not done, for this reason": an Observation with `status:
 * cancelled`, the reason in the `qicore-notDoneReason` extension, and `issued` from the Author dateTime.
 * That is exactly what CMS2's denominator exception retrieves (`qicore-observationcancelled`), and
 * every positive screening read in that measure admits only `final | amended | corrected`, so a
 * cancelled Observation can never count as a screening that happened.
 *
 * Imported only when the source names both the assessment and the reason. A negation stated against a
 * whole value set (`sdtc:valueSet` with no code) or with no reason stays untranslated: there is nothing
 * concrete to put in `code`, and a reasonless "not done" is not an exception.
 */
function assessmentNotDoneFrom(node: CdaNode, i: string): unknown {
  const code = concept(child(node, "code"));
  const rationale = descendants(node, "observation").find((n) => hasTemplate(n, T.negationRationale));
  const reason = concept(child(rationale, "value"));
  if (!code || !reason) return undefined;
  const recorded = authoredOn(node);
  return {
    resourceType: "Observation",
    id: idOf(node, `qrda1-observation-${i}`),
    ...identifierOf(node),
    status: "cancelled",
    category: [{ coding: [{ system: OBSERVATION_CATEGORY, code: "survey" }] }],
    code,
    // `issued` is an instant; a date-only author time is left out rather than padded with a time.
    ...(recorded?.includes("T") ? { issued: recorded } : {}),
    extension: [{ url: QICORE_NOT_DONE_REASON, valueCodeableConcept: reason }],
  };
}

function procedureFrom(node: CdaNode, i: string): unknown {
  const code = concept(child(node, "code"));
  if (!code) return undefined;
  const t = times(child(node, "effectiveTime"));
  return {
    resourceType: "Procedure",
    id: idOf(node, `qrda1-procedure-${i}`),
    ...identifierOf(node),
    status: "completed",
    code,
    ...bodySiteOf(node),
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
    ...identifierOf(node),
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
    ...identifierOf(node),
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
 *
 * QDM Medication, Order uses the same mapper with `status: "completed"`. The two datatypes must stay
 * distinguishable after import: `Status.isMedicationActive` is an `Equal` on `"active"`, while
 * `isMedicationOrder` admits `active | completed`. An order imported as `active` would read as a
 * medication the patient is TAKING, and CMS125/CMS122's dementia-medication exclusion reads exactly
 * that. `completed` satisfies every order read (CMS2's follow-up, CMS137's treatment) and no active one.
 * The order's own `<statusCode code="active"/>` is the template's fixed value for any order, not a
 * statement about the medication, so it is deliberately not carried.
 */
function medicationRequestFrom(node: CdaNode, i: string, status: "active" | "completed"): unknown {
  const material = descendants(node, "manufacturedMaterial")[0];
  const code = concept(child(material, "code"));
  if (!code) return undefined;
  const t = times(child(node, "effectiveTime"));
  return {
    resourceType: "MedicationRequest",
    id: idOf(node, `qrda1-medicationrequest-${i}`),
    ...identifierOf(node),
    status,
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
    ...identifierOf(node),
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

/**
 * An HL7 `YYYYMMDD…` timestamp → the FHIR `date` it denotes, taken from the SOURCE digits.
 *
 * Two things this must not do, and the obvious implementation does both. `Patient.birthDate` is a FHIR
 * **date**, so the full timestamp `isoFromHl7` returns is invalid there — that is what this used to
 * write. Truncating `isoFromHl7`'s output was wrong too while it NORMALIZED to UTC (until #788):
 * `20000101010000+1400` became `1999-12-31T11:00:00Z`, the wrong calendar day, and a birth date is a local
 * calendar fact rather than an instant. On a measure boundary that moves a patient between age bands
 * (Codex, #388). So the date is read from the leading digits and validated as a real calendar date — the
 * same round-trip check `isoFromHl7` applies to its own date-only branch — and a birth time whose time of
 * day `isoFromHl7` refuses still gives its date.
 */
function calendarDate(value: string | undefined): string | undefined {
  if (!value || !/^\d{8}/.test(value)) return undefined;
  const [y, mo, d] = [value.slice(0, 4), value.slice(4, 6), value.slice(6, 8)];
  const probe = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== `${y}-${mo}-${d}`) return undefined;
  return `${y}-${mo}-${d}`;
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
  const birthDate = calendarDate(child(patient, "birthTime")?.attrs.value);
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
  /**
   * Systolic and diastolic readings left as separate Observations, of any template, because LOCKED §4A.8's
   * conditions did not all hold (`unpairedBloodPressureReadingsIn`). CMS165 reads a blood pressure only as a
   * panel, so it does not read one of these as a blood pressure.
   */
  unpairedBloodPressureReadings: number;
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
  // Physical Exam readings that may pair, and every blood-pressure reading that can keep a pair from forming.
  const pairable: BloodPressureReading[] = [];
  const bloodPressureReadings: BloodPressureReading[] = [];
  // Every Diagnosis entry's own id is reserved before any encounter-diagnosis id is generated, whichever
  // comes first in the document, so a generated id can never shadow a Condition the source named.
  const conditionIds = new Set<string>(
    descendants(patientData, "observation")
      .filter((n) => hasTemplate(n, T.diagnosis))
      .map((n) => childrenNamed(n, "id").find((own) => own.attrs.extension)?.attrs.extension)
      .filter((own): own is string => typeof own === "string"),
  );

  childrenNamed(patientData, "entry").forEach((entry, i) => {
    // EVERY translatable datatype in the entry, not the first. A Result Organizer carrying two
    // Laboratory Tests, Performed is a standard CDA construct, and stopping at the first one dropped the
    // rest AND reported the entry as fully translated — so an HbA1c that is the second component of a
    // chemistry panel vanished with `untranslatedTemplates: []` (review, #362). Diagnosis is nested
    // inside a Diagnosis Concern Act, so the search descends rather than reading immediate children.
    // Whatever sits inside a negated act did not happen either: an observation wrapped in an act with
    // `negationInd="true"` is not a positive fact (review, #787). Only an act negates what it contains; a
    // negated `entryRelationship` says the RELATIONSHIP does not hold, not that the act it points to did not
    // happen (review, #787).
    const negatesContents = (n: CdaNode) => ACT_CLASSES.has(n.local) && isNegatedNode(n);
    const underNegation = new Set<CdaNode>();
    const markUnder = (n: CdaNode, negated: boolean): void => {
      for (const c of n.children) {
        if (negated) underNegation.add(c);
        markUnder(c, negated || negatesContents(c));
      }
    };
    for (const node of entry.children) markUnder(node, negatesContents(node));
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
      // The one exception is an Assessment, Not Performed with a stated reason, which has a faithful
      // QI-Core form of its own (`assessmentNotDoneFrom`) that no positive read can mistake for the act.
      // Both lexical forms of an XML Schema boolean true: `"1"` says the act did not happen exactly as
      // `"true"` does, and read as positive it would import a negated reading as a fact (Codex, #787).
      if (underNegation.has(candidate)) continue;
      if (isNegatedNode(candidate)) {
        const notDone = hasTemplate(candidate, T.assessmentPerformed) ? assessmentNotDoneFrom(candidate, key) : undefined;
        if (notDone !== undefined) {
          entries.push({ resource: notDone });
          translated++;
        }
        continue;
      }
      const resource: unknown =
        hasTemplate(candidate, T.encounterPerformed) ? encounterFrom(candidate, key, conditionIds)
        : hasTemplate(candidate, T.diagnosis) ? conditionFrom(candidate, key)
        : hasTemplate(candidate, T.labPerformed) ? observationFrom(candidate, key, "laboratory")
        : hasTemplate(candidate, T.studyPerformed) ? observationFrom(candidate, key, "imaging")
        // A screening/assessment Observation keeps its own `<code>` (the instrument) and `<value>` (the
        // result) — unlike Symptom below, which inverts them.
        : hasTemplate(candidate, T.assessmentPerformed) ? observationFrom(candidate, key, "survey")
        // One Observation per reading, with its own code. A blood pressure's two halves are paired into one
        // US Core panel after the walk, under LOCKED §4A.8's conditions only (`pairBloodPressures`).
        : hasTemplate(candidate, T.physicalExamPerformed) ? observationFrom(candidate, key, "exam")
        : hasTemplate(candidate, T.symptom) ? symptomFrom(candidate, key)
        // Intervention, Performed IS a Procedure to the official artifacts — same retrieve, same
        // `performed` property — so it shares the mapper rather than getting a near-copy.
        : hasTemplate(candidate, T.procedurePerformed) || hasTemplate(candidate, T.interventionPerformed)
          ? procedureFrom(candidate, key)
        : hasTemplate(candidate, T.interventionOrder) ? serviceRequestFrom(candidate, key)
        : hasTemplate(candidate, T.deviceOrder) ? deviceRequestFrom(candidate, key)
        : hasTemplate(candidate, T.medicationActive) ? medicationRequestFrom(candidate, key, "active")
        : hasTemplate(candidate, T.medicationOrder) ? medicationRequestFrom(candidate, key, "completed")
        : undefined;
      // An Encounter brings its diagnosis Conditions with it.
      const produced = (Array.isArray(resource) ? resource : [resource]).filter((r) => r !== undefined);
      if (produced.length > 0) {
        // A Physical Exam reading may pair only when it is its entry's own act: one inside an organizer or
        // another act can take a performer, a device or a status from its wrapper (review, #787).
        const pairs = hasTemplate(candidate, T.physicalExamPerformed) && entry.children.includes(candidate);
        for (const r of produced) {
          if ((r as { resourceType?: unknown }).resourceType === "Observation" && bloodPressureHalfOf(r) !== undefined) {
            const reading = { index: entries.length, node: candidate };
            bloodPressureReadings.push(reading);
            if (pairs) pairable.push(reading);
          }
          entries.push({ resource: r });
        }
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

  pairBloodPressures(entries, pairable, bloodPressureReadings);
  const unpairedBloodPressureReadings = unpairedBloodPressureReadingsIn(entries.map((e) => e.resource));

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
    unpairedBloodPressureReadings,
  };
}
