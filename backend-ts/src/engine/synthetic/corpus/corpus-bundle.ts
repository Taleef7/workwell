/**
 * `bundleForPatient(patient, evaluationDate)` — one corpus patient as a QI-Core FHIR bundle, plus the
 * `Practitioner` and `Organization` resources the whole corpus references.
 *
 * ## Profiles are stamped for the ARTIFACT, not for convenience
 *
 * Each resource carries the `meta.profile` the official artifact actually retrieves on, read off the
 * artifacts' own ELM (`official-only-bundles.ts` documents the same mapping):
 *
 * - a depression screening Observation is `qicore-observation-screening-assessment`, NOT the generic
 *   `qicore-observation-clinical-result` the binding builder uses
 * - an HbA1c and an FOBT are `qicore-observation-lab`; a mammogram is `qicore-observation-clinical-result`
 *   (an imaging result, which is exactly the profile CMS125's `[Observation: "Mammography"]` retrieve
 *   names — it carried the lab profile with an `imaging` category until 2026-09-06, a resource
 *   contradicting itself)
 * - a blood pressure is `us-core-blood-pressure` — a US Core profile, not a QI-Core one
 * - a problem-list Condition is `qicore-condition-problems-health-concerns`; the SUD episode diagnosis
 *   is `qicore-condition-encounter-diagnosis`, recorded DURING its encounter, because that is the only
 *   profile CMS137 retrieves it through and its denominator is "an encounter during which the diagnosis
 *   starts" — a diagnosis on its own, however coded, puts nobody in the initial population
 * - a Coverage is `qicore-coverage`, a MedicationRequest `qicore-medicationrequest`
 *
 * The executor runs with `trustMetaProfile: false` today, so these stamps do not change retrieval yet.
 * They are still worth getting right, and not only for tidiness: CMS165's decisive retrieve identifies
 * a blood pressure by PROFILE ALONE with no code filter, so stamping `us-core-blood-pressure` correctly
 * is the precondition for ever trusting profiles for official routing (ADR-072's consequences).
 * Emitting a plausible-but-wrong profile now would quietly foreclose that.
 *
 * ## The Patient carries what the artifacts actually read
 *
 * `Patient.gender` is NOT what CMS125 reads. Its initial population compares the `us-core-sex`
 * extension's `valueCode` to SNOMED 248152002 (Female), and every one of its steward test patients
 * carries that extension. A corpus Patient with only `gender: "female"` put the entire roster out of
 * CMS125's initial population — measured in the credentialed CI job: `inIPP=0` over 200 subjects,
 * while every other measure found its cohort. The `us-core-race` and `us-core-ethnicity` extensions
 * and a `Coverage` are emitted for the same reason: the four supplemental data elements every vendored
 * artifact declares (`SDE Sex`/`Race`/`Ethnicity`/`Payer`) read exactly those, and a QRDA I without
 * them is not a conformant submission.
 *
 * ## What is deliberately NOT emitted
 *
 * A fact with no verified code is SKIPPED rather than stamped with an invented one — an omission is
 * visible in the bundle and an invented code is not, and only one of the two can quietly move a
 * measure's denominator. As of generator 4.0.0 every condition the parameter table draws IS emitted;
 * `pregnancy`, which no vendored measure reads, was removed from the table rather than kept as a count
 * nothing could act on.
 *
 * Nothing here decides an outcome. CQL alone does (AI_GUARDRAILS §1, ADR-008).
 */
import { SUD_CONDITION_CODES, ECQM_CANONICAL_CODES, MAMMOGRAPHY_PROCEDURE_CPT, US_CORE_SEX_CODES } from "../../cql/bundled-ecqm-expansions.ts";
import { CLINICS, CORPUS_GENERATOR_VERSION, DEFAULT_CORPUS_SEED, PCPS } from "./corpus-parameters.ts";
import type { CorpusEvent, CorpusPatient } from "./corpus-patient.ts";

const QICORE = "http://hl7.org/fhir/us/qicore/StructureDefinition/";
const USCORE = "http://hl7.org/fhir/us/core/StructureDefinition/";
const V3_ACT_CODE = "http://terminology.hl7.org/CodeSystem/v3-ActCode";
const CONDITION_VER_STATUS = "http://terminology.hl7.org/CodeSystem/condition-ver-status";
const CONDITION_CLINICAL = "http://terminology.hl7.org/CodeSystem/condition-clinical";
const OBSERVATION_CATEGORY = "http://terminology.hl7.org/CodeSystem/observation-category";
const CONDITION_CATEGORY = "http://terminology.hl7.org/CodeSystem/condition-category";
const PROVENANCE_AGENT_TYPE = "http://terminology.hl7.org/CodeSystem/provenance-participant-type";

/** The profile each emitted resource carries — see the header for why these differ from the binding builder's. */
const PROFILE = {
  patient: `${QICORE}qicore-patient`,
  encounter: `${QICORE}qicore-encounter`,
  condition: `${QICORE}qicore-condition-problems-health-concerns`,
  conditionEncounterDiagnosis: `${QICORE}qicore-condition-encounter-diagnosis`,
  procedure: `${QICORE}qicore-procedure`,
  observationLab: `${QICORE}qicore-observation-lab`,
  observationClinicalResult: `${QICORE}qicore-observation-clinical-result`,
  observationScreening: `${QICORE}qicore-observation-screening-assessment`,
  observationCancelled: `${QICORE}qicore-observationcancelled`,
  bloodPressure: `${USCORE}us-core-blood-pressure`,
  serviceRequest: `${QICORE}qicore-servicerequest`,
  medicationRequest: `${QICORE}qicore-medicationrequest`,
  coverage: `${QICORE}qicore-coverage`,
  provenance: `${QICORE}qicore-provenance`,
} as const;

/**
 * The organizations every patient bundle may reference besides the clinics: one per payer in the
 * PAYER_MIX (a `Coverage.payor` is a REQUIRED reference, 1..*), and the outside source an external
 * event's Provenance names as informant — a resolvable `Organization`, not a display-only string, so
 * "where did this fact come from" has an answer a consumer can follow.
 */
const HIE_ORGANIZATION = { id: "maui-hie-outside-source", name: "Hawaii health information exchange (outside source)" } as const;
const PAYER_ORGANIZATIONS: Record<string, { readonly id: string; readonly name: string; readonly display: string }> = {
  "1": { id: "payer-medicare", name: "Medicare", display: "MEDICARE" },
  "11": { id: "payer-medicare-advantage", name: "Medicare Advantage plan", display: "Medicare Managed Care (Includes Medicare Advantage)" },
  "2": { id: "payer-medicaid", name: "Med-QUEST (Medicaid)", display: "MEDICAID" },
  "5": { id: "payer-commercial", name: "Commercial health plan", display: "PRIVATE HEALTH INSURANCE" },
};

export interface BundleEntry {
  resource: Record<string, unknown>;
}

export interface CorpusBundle {
  resourceType: "Bundle";
  type: "collection";
  entry: BundleEntry[];
}

const clinicIdFor = (site: string): string =>
  CLINICS.find((c) => c.name === site)?.id ?? CLINICS[0]!.id;

/**
 * The REASON a documented exception is recorded with, keyed by the generator's exception name. It is
 * the `qicore-notDoneReason` extension's value on a CANCELLED observation of the screening instrument —
 * not the observation's code. See `exceptionResource`.
 */
const EXCEPTION_REASONS: Record<string, { code: string; system: string; display: string }> = {
  // The artifact's own direct-reference code (cms2 ELM codes.def: "Depression screening declined
  // (situation)"), compared with `~` against the notDoneReason extension.
  depressionScreeningRefused: {
    code: "720834000",
    system: "http://snomed.info/sct",
    display: "Depression screening declined (situation)",
  },
};

/**
 * A documented refusal, in the shape CMS2's denominator exception ACTUALLY retrieves:
 * `[Observation: qicore-observationcancelled]` whose `code` is the screening INSTRUMENT (the adult or
 * adolescent depression-screening LOINC, by age exactly as the numerator bands it), whose `status` is
 * `cancelled`, whose `issued` falls inside a qualifying encounter, and whose `qicore-notDoneReason`
 * extension carries the refusal code. Until 2026-09-06 the corpus emitted a FINAL screening-assessment
 * Observation whose `code` was the refusal code itself — a resource no retrieve in the artifact could
 * match, so every one of the patients who drew a documented refusal (170 at 20,000) sat in the
 * denominator with no screening and no exception, and read OVERDUE. Shape mirrors the steward's own
 * CMS2 test deck, whose cancelled observations carry exactly these elements.
 */
function exceptionResource(patient: CorpusPatient, key: string, index: number, day: string): Record<string, unknown> | null {
  const reason = EXCEPTION_REASONS[key];
  if (!reason) return null;
  const instrument = patient.age >= 17 ? ECQM_CANONICAL_CODES.depressionScreenAdult : ECQM_CANONICAL_CODES.depressionScreenAdolescent;
  return {
    resourceType: "Observation",
    meta: { profile: [PROFILE.observationCancelled] },
    id: `${patient.externalId}-exception-${index + 1}`,
    extension: [{ url: `${QICORE}qicore-notDoneReason`, valueCodeableConcept: codeable(reason) }],
    status: "cancelled",
    category: [{ coding: [{ system: OBSERVATION_CATEGORY, code: "survey" }] }],
    subject: { reference: `Patient/${patient.externalId}` },
    code: codeable(instrument),
    // `issued`, not `effective`: the artifact's exception join reads `issued` against the encounter's
    // period, and the corpus's encounters run 09:00-09:30.
    issued: `${day}T09:15:00Z`,
  };
}

/** One `Practitioner` per PCP, ids matching what every patient's `generalPractitioner` references. */
export function practitionerResources(): Record<string, unknown>[] {
  return PCPS.map((pcp) => {
    const [prefix, given, ...family] = pcp.name.split(" ");
    return {
      resourceType: "Practitioner",
      meta: { profile: [`${USCORE}us-core-practitioner`] },
      id: pcp.id,
      active: true,
      name: [{ text: pcp.name, family: family.join(" "), given: [given!], prefix: [prefix!] }],
    };
  });
}

/** One `Organization` per clinic. */
export function organizationResources(): Record<string, unknown>[] {
  return CLINICS.map((clinic) => ({
    resourceType: "Organization",
    meta: { profile: [`${USCORE}us-core-organization`] },
    id: clinic.id,
    active: true,
    name: clinic.name,
  }));
}

/** The payers every `Coverage.payor` references, and the outside source every informant agent references. */
export function payerAndSourceOrganizationResources(): Record<string, unknown>[] {
  return [
    ...Object.values(PAYER_ORGANIZATIONS).map((payer) => ({
      resourceType: "Organization",
      meta: { profile: [`${USCORE}us-core-organization`] },
      id: payer.id,
      active: true,
      name: payer.name,
    })),
    {
      resourceType: "Organization",
      meta: { profile: [`${USCORE}us-core-organization`] },
      id: HIE_ORGANIZATION.id,
      active: true,
      name: HIE_ORGANIZATION.name,
    },
  ];
}

/**
 * One `Provenance` per clinical resource (spec §3, D5).
 *
 * `target` points at the resource by `<type>/<id>`, which is what makes the pair resolvable inside the
 * collection bundle. The author is always the patient's own PCP on behalf of their clinic; an
 * `informant` agent appears ONLY for an event the generator marked external, so "where did this come
 * from" is answerable per fact rather than per patient.
 */
export function provenanceFor(
  resource: { resourceType: string; id: string },
  patient: CorpusPatient,
  recordedDate: string,
  external: boolean,
  seed: string,
): Record<string, unknown> {
  const agents: Record<string, unknown>[] = [
    {
      type: { coding: [{ system: PROVENANCE_AGENT_TYPE, code: "author" }] },
      who: { reference: `Practitioner/${patient.providerId}` },
      onBehalfOf: { reference: `Organization/${clinicIdFor(patient.site)}` },
    },
  ];
  if (external) {
    agents.push({
      type: { coding: [{ system: PROVENANCE_AGENT_TYPE, code: "informant" }] },
      // A RESOLVABLE reference, emitted once by `payerAndSourceOrganizationResources`. A display-only
      // `who` is valid FHIR and says nothing a consumer can follow; the whole point of the informant
      // agent is that the source of an outside fact is identifiable.
      who: { reference: `Organization/${HIE_ORGANIZATION.id}`, display: HIE_ORGANIZATION.name },
    });
  }
  return {
    resourceType: "Provenance",
    meta: { profile: [PROFILE.provenance] },
    id: `${resource.id}-prov`,
    target: [{ reference: `${resource.resourceType}/${resource.id}` }],
    recorded: `${recordedDate}T12:00:00Z`,
    agent: agents,
    entity: [
      {
        role: "source",
        what: { display: `WorkWell synthetic corpus ${seed} #${CORPUS_GENERATOR_VERSION}` },
      },
    ],
  };
}

const codeable = (coding: { code: string; system: string; display?: string }) => ({ coding: [coding] });

function encounterResource(patient: CorpusPatient, day: string, index: number): Record<string, unknown> {
  return {
    resourceType: "Encounter",
    meta: { profile: [PROFILE.encounter] },
    id: `${patient.externalId}-visit-${index + 1}`,
    status: "finished",
    class: { system: V3_ACT_CODE, code: "AMB" },
    subject: { reference: `Patient/${patient.externalId}` },
    type: [codeable(ECQM_CANONICAL_CODES.officeVisit)],
    // `Z` is REQUIRED. FHIR R4's dateTime regex demands an offset whenever a time is present, and these
    // two were the only invalid date-times the corpus emitted — in Encounter, the qualifying visit every
    // one of the six measures' denominators reads. A validator rejects the bundle; an engine that
    // tolerates it resolves the instant in an unspecified zone, which on a Jan-1 or Dec-31 visit can
    // move a patient in or out of the measurement period.
    period: { start: `${day}T09:00:00Z`, end: `${day}T09:30:00Z` },
  };
}

function conditionResource(patient: CorpusPatient, key: string, coding: { code: string; system: string; display?: string }): Record<string, unknown> {
  return {
    resourceType: "Condition",
    meta: { profile: [PROFILE.condition] },
    id: `${patient.externalId}-${key}`,
    subject: { reference: `Patient/${patient.externalId}` },
    // A system on clinicalStatus, not a bare code. Without it the binding is unresolvable and QI-Core's
    // `isActive` cannot evaluate, which puts the subject out of the initial population — the repair
    // `qicore-preparation.ts` exists for. Emitting it correctly at the source is cheaper than relying
    // on the repair, and keeps the bundle valid for consumers that never run it (exports, CDS).
    clinicalStatus: { coding: [{ system: CONDITION_CLINICAL, code: "active" }] },
    verificationStatus: { coding: [{ system: CONDITION_VER_STATUS, code: "confirmed" }] },
    category: [
      {
        coding: [{ system: CONDITION_CATEGORY, code: "problem-list-item" }],
      },
    ],
    code: codeable(coding),
    // CLAMPED to the patient's birth date. `birthYear + max(age-2, 0)` on January 15 precedes the birth
    // of anyone aged 0 or 1 born after mid-January — 9 patients at 20,000 carried an onset before they
    // existed, which no validator here catches and any chart view shows.
    onsetDateTime: onsetFor(patient),
  };
}

/** An onset two years before the measurement year, never earlier than the patient's own birth. */
function onsetFor(patient: CorpusPatient): string {
  const candidate = `${Number(patient.dateOfBirth.slice(0, 4)) + Math.max(patient.age - 2, 0)}-01-15`;
  return `${candidate < patient.dateOfBirth ? patient.dateOfBirth : candidate}T00:00:00Z`;
}

/** The condition keys the corpus can express as coded FHIR, and the code each one carries. */
const CONDITION_CODES: Record<string, { code: string; system: string; display?: string }> = {
  diabetes: ECQM_CANONICAL_CODES.diabetes,
  hypertension: ECQM_CANONICAL_CODES.essentialHypertension,
  bipolar: ECQM_CANONICAL_CODES.bipolarDisorder,
  colorectalCancer: ECQM_CANONICAL_CODES.colorectalCancer,
  esrd: ECQM_CANONICAL_CODES.esrd,
  /**
   * HOSPICE is emitted now. It was drawn (87 patients at 20,000), counted in the manifest, published in
   * the JOURNAL — and never turned into a resource, because it had no entry here. The consequence was
   * not cosmetic: hospice is a denominator EXCLUSION on every one of the ACO's measures, 47 of those 87
   * patients had a routine mammogram or colorectal screening inside the period, and the corpus could
   * therefore never exercise a hospice exclusion at all. A regression that broke exclusion handling
   * would have been invisible. `hospiceDx` is SNOMED 170935008, already verified in the canonical table
   * and present in CMS's own CMS137 deck.
   *
   * FRAILTY is emitted since generator 4.0.0, as the "Frailty Diagnosis" member the AIFrailLTCF library
   * retrieves through both Condition profiles. On its own it excludes nobody — the 66+ exclusion also
   * needs a dementia medication or an advanced-illness diagnosis, which are generated as EVENTS among
   * the frail (see `resourcesForEvent`). `palliativeCare`, `bilateralMastectomy` and `totalColectomy`
   * are drawn as conditions too but are PROCEDURES in FHIR, so they are emitted through their events
   * rather than from this table.
   */
  hospice: ECQM_CANONICAL_CODES.hospiceDx,
  frailty: ECQM_CANONICAL_CODES.frailtyDx,
};

/** The conditions that are drawn from the prevalence table but become Procedures, through their events. */
const PROCEDURE_CONDITIONS = new Set(["palliativeCare", "bilateralMastectomy", "totalColectomy"]);

/**
 * The FHIR resources one generated event becomes — usually one, EMPTY where the corpus has no verified
 * code for that event kind, and TWO for a mammogram, which is dual-stamped (ADR-044): the authored
 * cms125 retrieves the CPT `Procedure` while the official artifact retrieves the LOINC `Observation`,
 * so a real EHR records both and a corpus emitting one would silently fail whichever path it omitted.
 */
function resourcesForEvent(patient: CorpusPatient, event: CorpusEvent, index: number): Record<string, unknown>[] {
  const subject = { reference: `Patient/${patient.externalId}` };
  const id = `${patient.externalId}-${event.kind}-${index + 1}`;

  switch (event.kind) {
    case "hba1c":
      return [{
        resourceType: "Observation",
        meta: { profile: [PROFILE.observationLab] },
        id,
        status: "final",
        category: [{ coding: [{ system: OBSERVATION_CATEGORY, code: "laboratory" }] }],
        subject,
        code: codeable(ECQM_CANONICAL_CODES.hba1c),
        effectiveDateTime: `${event.date}T10:00:00Z`,
        valueQuantity: { value: event.value, unit: "%", system: "http://unitsofmeasure.org", code: "%" },
      }];

    case "bp":
      return [{
        resourceType: "Observation",
        meta: { profile: [PROFILE.bloodPressure] },
        id,
        status: "final",
        category: [{ coding: [{ system: OBSERVATION_CATEGORY, code: "vital-signs" }] }],
        subject,
        code: codeable(ECQM_CANONICAL_CODES.bpPanel),
        effectiveDateTime: `${event.date}T10:00:00Z`,
        component: [
          { code: codeable(ECQM_CANONICAL_CODES.bpSystolic), valueQuantity: { value: event.value, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" } },
          { code: codeable(ECQM_CANONICAL_CODES.bpDiastolic), valueQuantity: { value: event.value2, unit: "mmHg", system: "http://unitsofmeasure.org", code: "mm[Hg]" } },
        ],
      }];

    case "phq9": {
      // The instrument is age-banded, exactly as the artifact's own logic bands it.
      const instrument = patient.age >= 17 ? ECQM_CANONICAL_CODES.depressionScreenAdult : ECQM_CANONICAL_CODES.depressionScreenAdolescent;
      const positive = (event.value ?? 0) >= 10;
      return [{
        resourceType: "Observation",
        meta: { profile: [PROFILE.observationScreening] },
        id,
        status: "final",
        category: [{ coding: [{ system: OBSERVATION_CATEGORY, code: "survey" }] }],
        subject,
        code: codeable(instrument),
        effectiveDateTime: `${event.date}T09:15:00Z`,
        valueCodeableConcept: codeable(
          positive ? ECQM_CANONICAL_CODES.depressionScreenPositive : ECQM_CANONICAL_CODES.depressionScreenNegative,
        ),
      }];
    }

    case "phq9FollowUp":
      return [{
        resourceType: "ServiceRequest",
        meta: { profile: [PROFILE.serviceRequest] },
        id,
        status: "active",
        intent: "order",
        subject,
        authoredOn: `${event.date}T09:20:00Z`,
        // The follow-up ORDER, not the screening finding. See `depressionFollowUpReferral`.
        code: codeable(ECQM_CANONICAL_CODES.depressionFollowUpReferral),
      }];

    case "mammogram":
      // DUAL-STAMPED (ADR-044). The official artifact's numerator is `[Observation: "Mammography"]`,
      // whose members are all LOINC; the authored cms125 retrieves the CPT `Procedure`. A real EHR
      // records both, and emitting only one makes the other path read the patient as unscreened — a
      // false OVERDUE nobody would trace back to the corpus.
      return [
        {
          resourceType: "Observation",
          // CLINICAL RESULT, the profile the artifact's retrieve names (`qicore-observation-clinical-
          // result`), with the `imaging` category an imaging result carries. Until 2026-09-06 this was
          // `qicore-observation-lab` + `imaging` — a resource whose profile and category contradicted
          // each other, which a validator flags and a reader of the chart would not believe.
          meta: { profile: [PROFILE.observationClinicalResult] },
          id,
          status: "final",
          category: [{ coding: [{ system: OBSERVATION_CATEGORY, code: "imaging" }] }],
          subject,
          code: codeable(ECQM_CANONICAL_CODES.mammogram),
          effectiveDateTime: `${event.date}T11:00:00Z`,
        },
        {
          resourceType: "Procedure",
          meta: { profile: [PROFILE.procedure] },
          id: `${id}-procedure`,
          status: "completed",
          subject,
          code: codeable(MAMMOGRAPHY_PROCEDURE_CPT),
          performedDateTime: `${event.date}T11:00:00Z`,
        },
      ];

    case "colorectal":
      // Only the two modalities whose value-set membership is established (COLORECTAL_MODALITIES).
      if (event.modality === "colonoscopy") {
        return [{
          resourceType: "Procedure",
          meta: { profile: [PROFILE.procedure] },
          id,
          status: "completed",
          subject,
          code: codeable(ECQM_CANONICAL_CODES.colonoscopy),
          performedDateTime: `${event.date}T08:30:00Z`,
        }];
      }
      return [{
        resourceType: "Observation",
        meta: { profile: [PROFILE.observationLab] },
        id,
        status: "final",
        category: [{ coding: [{ system: OBSERVATION_CATEGORY, code: "laboratory" }] }],
        subject,
        code: codeable(ECQM_CANONICAL_CODES.fobt),
        // No result value: CMS130 retrieves the TEST (the FOBT value set), and whether it was
        // performed inside the lookback is the whole question. A result code here would be invented
        // data that no part of the measure reads.
        effectiveDateTime: `${event.date}T08:30:00Z`,
      }];

    // CMS137 (MIPS 305). The episode is an ENCOUNTER during which a SUD diagnosis starts — the measure's
    // `First SUD Episode During Measurement Period` is a qualifying encounter WITH an encounter-diagnosis
    // Condition whose prevalence interval STARTS INSIDE the encounter's period. Until 2026-09-06 the
    // corpus emitted the Condition alone, onset at midnight on a day that need not have had a visit at
    // all: the join never matched, and the credentialed CI job measured `inIPP=0` for cms137 over 200
    // subjects — every SUD patient invisible to the measure the ACO is asking about. The episode
    // encounter is an office visit (a member of the artifact's "Office Visit" qualifying set); the
    // diagnosis is stamped `qicore-condition-encounter-diagnosis`, the ONLY profile CMS137 retrieves it
    // through, and references the encounter it was made in. Initiation and engagement are the treatment
    // contacts its two rates count. Codes come from the artifact's own vendored expansion.
    case "sudEpisode": {
      const encounterId = `${id}-encounter`;
      return [
        {
          resourceType: "Encounter",
          meta: { profile: [PROFILE.encounter] },
          id: encounterId,
          status: "finished",
          class: { system: V3_ACT_CODE, code: "AMB" },
          subject,
          type: [codeable(ECQM_CANONICAL_CODES.officeVisit)],
          period: { start: `${event.date}T09:00:00Z`, end: `${event.date}T09:30:00Z` },
        },
        {
          resourceType: "Condition",
          meta: { profile: [PROFILE.conditionEncounterDiagnosis] },
          id,
          subject,
          encounter: { reference: `Encounter/${encounterId}` },
          clinicalStatus: { coding: [{ system: CONDITION_CLINICAL, code: "active" }] },
          verificationStatus: { coding: [{ system: CONDITION_VER_STATUS, code: "confirmed" }] },
          category: [{ coding: [{ system: CONDITION_CATEGORY, code: "encounter-diagnosis" }] }],
          // Which of the two SUD diagnoses is a property of the PATIENT, so it is derived from their
          // index rather than drawn — this function has no stream, and adding one would make a bundle
          // depend on the order it was built in. Roughly a quarter carry the second diagnosis.
          code: codeable(SUD_CONDITION_CODES[patient.index % 4 === 0 ? 1 : 0]!),
          // INSIDE the encounter's period, which is what the measure's join tests.
          onsetDateTime: `${event.date}T09:05:00Z`,
          recordedDate: `${event.date}T09:05:00Z`,
        },
      ];
    }

    // The AIFrailLTCF exclusion's second half, drawn among the frail (see `corpus-patient.ts`).
    case "dementiaMedication":
      return [{
        resourceType: "MedicationRequest",
        meta: { profile: [PROFILE.medicationRequest] },
        id,
        status: "active",
        intent: "order",
        subject,
        medicationCodeableConcept: codeable(ECQM_CANONICAL_CODES.dementiaMedication),
        authoredOn: `${event.date}T10:00:00Z`,
      }];

    case "advancedIllness":
      return [{
        resourceType: "Condition",
        meta: { profile: [PROFILE.condition] },
        id,
        subject,
        clinicalStatus: { coding: [{ system: CONDITION_CLINICAL, code: "active" }] },
        verificationStatus: { coding: [{ system: CONDITION_VER_STATUS, code: "confirmed" }] },
        category: [{ coding: [{ system: CONDITION_CATEGORY, code: "problem-list-item" }] }],
        code: codeable(ECQM_CANONICAL_CODES.advancedIllness),
        // Onset IN the period: the exclusion reads "starts in the year before or during", so an onset
        // here is the case that exercises it.
        onsetDateTime: `${event.date}T00:00:00Z`,
      }];

    // The PalliativeCare library's intervention path; the same `isInterventionPerformed` shape as the
    // SUD treatments. Excludes on cms122/125/130/165 when it overlaps the period.
    case "palliativeCare":
      return [{
        resourceType: "Procedure",
        meta: { profile: [PROFILE.procedure] },
        id,
        status: "completed",
        subject,
        code: codeable(ECQM_CANONICAL_CODES.palliativeProc),
        performedDateTime: `${event.date}T10:00:00Z`,
      }];

    // Surgical history: cms125's and cms130's procedure-based exclusions, performed any time before the
    // end of the period. Dated years back by the generator, as chart history is.
    case "bilateralMastectomy":
      return [{
        resourceType: "Procedure",
        meta: { profile: [PROFILE.procedure] },
        id,
        status: "completed",
        subject,
        code: codeable(ECQM_CANONICAL_CODES.bilateralMastectomy),
        performedDateTime: `${event.date}T08:00:00Z`,
      }];

    case "totalColectomy":
      return [{
        resourceType: "Procedure",
        meta: { profile: [PROFILE.procedure] },
        id,
        status: "completed",
        subject,
        code: codeable(ECQM_CANONICAL_CODES.totalColectomy),
        performedDateTime: `${event.date}T08:00:00Z`,
      }];

    case "sudInitiation":
    case "sudEngagement":
      return [{
        resourceType: "Procedure",
        meta: { profile: [PROFILE.procedure] },
        id,
        status: "completed",
        subject,
        code: codeable(ECQM_CANONICAL_CODES.sudTreatment),
        performedDateTime: `${event.date}T10:00:00Z`,
      }];

    default:
      return [];
  }
}

/** A patient's whole record: identity, panel, encounters, conditions, events, and one Provenance each. */
export function bundleForPatient(
  patient: CorpusPatient,
  evaluationDate: string,
  seed: string = DEFAULT_CORPUS_SEED,
): CorpusBundle {
  const clinicId = clinicIdFor(patient.site);
  const entry: BundleEntry[] = [];

  // The Patient and the Coverage carry no Provenance: they are the subject the other resources are
  // about and their administrative context, not clinical facts somebody recorded, and pairing one with
  // either would make `provenances.length` stop meaning "one per clinical fact".
  const raceDisplay: Record<string, string> = {
    "2106-3": "White", "2028-9": "Asian", "2076-8": "Native Hawaiian or Other Pacific Islander",
    "2131-1": "Other Race", "2054-5": "Black or African American", "1002-5": "American Indian or Alaska Native",
  };
  const ethnicityDisplay: Record<string, string> = { "2135-2": "Hispanic or Latino", "2186-5": "Not Hispanic or Latino" };
  const CDC_RACE_ETHNICITY = ECQM_CANONICAL_CODES.raceWhite.system;
  entry.push({
    resource: {
      resourceType: "Patient",
      meta: { profile: [PROFILE.patient] },
      id: patient.externalId,
      // The three US Core extensions the measures READ. `us-core-sex` is what CMS125's initial
      // population compares (`= '248152002'`), not `gender`; race and ethnicity are what `SDE Race`
      // and `SDE Ethnicity` read. Shaped exactly as the steward's own test patients carry them.
      extension: [
        {
          url: `${USCORE}us-core-race`,
          extension: [
            { url: "ombCategory", valueCoding: { system: CDC_RACE_ETHNICITY, code: patient.race, display: raceDisplay[patient.race] } },
            { url: "text", valueString: raceDisplay[patient.race] },
          ],
        },
        {
          url: `${USCORE}us-core-ethnicity`,
          extension: [
            { url: "ombCategory", valueCoding: { system: CDC_RACE_ETHNICITY, code: patient.ethnicity, display: ethnicityDisplay[patient.ethnicity] } },
            { url: "text", valueString: ethnicityDisplay[patient.ethnicity] },
          ],
        },
        { url: `${USCORE}us-core-sex`, valueCode: US_CORE_SEX_CODES[patient.sex] },
      ],
      name: [{ text: patient.name }],
      gender: patient.sex === "F" ? "female" : "male",
      birthDate: patient.dateOfBirth,
      managingOrganization: { reference: `Organization/${clinicId}` },
      generalPractitioner: [{ reference: `Practitioner/${patient.providerId}` }],
    },
  });

  // `SDE Payer` is `[Coverage: type in "Payer Type"]`, and QRDA I's payer element comes from the same
  // place. One Coverage per patient, active across the year the record describes, paying organization
  // emitted once by `payerAndSourceOrganizationResources`.
  const payer = PAYER_ORGANIZATIONS[patient.payer];
  if (!payer) throw new Error(`[workwell] ${patient.externalId}: payer code ${patient.payer} has no Organization — extend PAYER_ORGANIZATIONS`);
  entry.push({
    resource: {
      resourceType: "Coverage",
      meta: { profile: [PROFILE.coverage] },
      id: `${patient.externalId}-coverage`,
      status: "active",
      type: { coding: [{ system: ECQM_CANONICAL_CODES.payerMedicare.system, code: patient.payer, display: payer.display }] },
      beneficiary: { reference: `Patient/${patient.externalId}` },
      payor: [{ reference: `Organization/${payer.id}`, display: payer.name }],
      period: { start: `${patient.measurementYear}-01-01`, end: `${patient.measurementYear}-12-31` },
    },
  });

  const clinical: Array<{ resource: Record<string, unknown>; date: string; external: boolean }> = [];

  for (const [index, day] of patient.visits.entries()) {
    clinical.push({ resource: encounterResource(patient, day, index), date: day, external: false });
  }

  for (const condition of patient.conditions) {
    // Conditions that are Procedures in FHIR are emitted through their events, not from this table.
    if (PROCEDURE_CONDITIONS.has(condition)) continue;
    const coding = CONDITION_CODES[condition];
    // A condition with no verified code is a real fact about the patient that this corpus cannot express
    // as a retrievable resource. It is skipped rather than stamped with an invented code — the omission
    // is visible in the bundle, an invented code is not, and only one of the two can quietly change a
    // measure's denominator. Since 4.0.0 every key the table draws has a code, so this is a guard.
    if (!coding) continue;
    clinical.push({
      resource: conditionResource(patient, condition, coding),
      date: patient.visits[0] ?? evaluationDate,
      external: false,
    });
  }

  for (const [index, event] of patient.events.entries()) {
    for (const resource of resourcesForEvent(patient, event, index)) {
      clinical.push({ resource, date: event.date, external: event.external });
    }
  }

  for (const [index, exception] of patient.exceptions.entries()) {
    const day = patient.visits[0] ?? evaluationDate;
    const resource = exceptionResource(patient, exception, index, day);
    if (!resource) continue;
    clinical.push({ resource, date: day, external: false });
  }

  for (const item of clinical) {
    entry.push({ resource: item.resource });
    entry.push({
      resource: provenanceFor(
        item.resource as { resourceType: string; id: string },
        patient,
        item.date,
        item.external,
        seed,
      ),
    });
  }

  return { resourceType: "Bundle", type: "collection", entry };
}
