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
 * - an HbA1c is `qicore-observation-lab`
 * - a blood pressure is `us-core-blood-pressure` — a US Core profile, not a QI-Core one
 * - a Condition is `qicore-condition-problems-health-concerns`, not the generic `qicore-condition`
 *
 * The executor runs with `trustMetaProfile: false` today, so these stamps do not change retrieval yet.
 * They are still worth getting right, and not only for tidiness: CMS165's decisive retrieve identifies
 * a blood pressure by PROFILE ALONE with no code filter, so stamping `us-core-blood-pressure` correctly
 * is the precondition for ever trusting profiles for official routing (ADR-072's consequences).
 * Emitting a plausible-but-wrong profile now would quietly foreclose that.
 *
 * ## What is deliberately NOT emitted
 *
 * The generator produces `sudEpisode` / `sudInitiation` / `sudEngagement` events for CMS137. No FHIR is
 * emitted for them: CMS137 is not approved (measure 305 may be removed from APP Plus for PY2027) and
 * this repo has no verified codes for those events. Inventing codes would put resources in the bundle
 * that no artifact retrieves, which reads as data and is not.
 *
 * Nothing here decides an outcome. CQL alone does (AI_GUARDRAILS §1, ADR-008).
 */
import { ECQM_CANONICAL_CODES, MAMMOGRAPHY_PROCEDURE_CPT } from "../../cql/bundled-ecqm-expansions.ts";
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
  procedure: `${QICORE}qicore-procedure`,
  observationLab: `${QICORE}qicore-observation-lab`,
  observationScreening: `${QICORE}qicore-observation-screening-assessment`,
  bloodPressure: `${USCORE}us-core-blood-pressure`,
  serviceRequest: `${QICORE}qicore-servicerequest`,
  provenance: `${QICORE}qicore-provenance`,
} as const;

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

/** The SNOMED code a documented exception is recorded with, keyed by the generator's exception name. */
const EXCEPTION_CODES: Record<string, { code: string; system: string; display: string }> = {
  // The artifact's own direct-reference code for a declined depression screen (cms2 denominator
  // exception). Sourced from the ELM's codes.def, like the negative/positive result codes.
  depressionScreeningRefused: {
    code: "720834000",
    system: "http://snomed.info/sct",
    display: "Refused depression screening",
  },
};

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
      who: { display: "Outside laboratory (HIE)" },
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
    period: { start: `${day}T09:00:00`, end: `${day}T09:30:00` },
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
    onsetDateTime: `${Number(patient.dateOfBirth.slice(0, 4)) + Math.max(patient.age - 2, 0)}-01-15T00:00:00Z`,
  };
}

/** The condition keys the corpus can express as coded FHIR, and the code each one carries. */
const CONDITION_CODES: Record<string, { code: string; system: string; display?: string }> = {
  diabetes: ECQM_CANONICAL_CODES.diabetes,
  hypertension: ECQM_CANONICAL_CODES.essentialHypertension,
  bipolar: ECQM_CANONICAL_CODES.bipolarDisorder,
  colorectalCancer: ECQM_CANONICAL_CODES.colorectalCancer,
  esrd: ECQM_CANONICAL_CODES.esrd,
};

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
        code: codeable(ECQM_CANONICAL_CODES.depressionScreenPositive),
      }];

    case "mammogram":
      // DUAL-STAMPED (ADR-044). The official artifact's numerator is `[Observation: "Mammography"]`,
      // whose members are all LOINC; the authored cms125 retrieves the CPT `Procedure`. A real EHR
      // records both, and emitting only one makes the other path read the patient as unscreened — a
      // false OVERDUE nobody would trace back to the corpus.
      return [
        {
          resourceType: "Observation",
          meta: { profile: [PROFILE.observationLab] },
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

    // CMS137's events, deliberately unrepresented — see the header.
    case "sudEpisode":
    case "sudInitiation":
    case "sudEngagement":
      return [];

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

  // The Patient carries no Provenance: it is the subject the other resources are about, not a clinical
  // fact somebody recorded, and pairing one with it would make `provenances.length` stop meaning
  // "one per clinical fact".
  entry.push({
    resource: {
      resourceType: "Patient",
      meta: { profile: [PROFILE.patient] },
      id: patient.externalId,
      name: [{ text: patient.name }],
      gender: patient.sex === "F" ? "female" : "male",
      birthDate: patient.dateOfBirth,
      managingOrganization: { reference: `Organization/${clinicId}` },
      generalPractitioner: [{ reference: `Practitioner/${patient.providerId}` }],
    },
  });

  const clinical: Array<{ resource: Record<string, unknown>; date: string; external: boolean }> = [];

  for (const [index, day] of patient.visits.entries()) {
    clinical.push({ resource: encounterResource(patient, day, index), date: day, external: false });
  }

  for (const condition of patient.conditions) {
    const coding = CONDITION_CODES[condition];
    // A condition with no verified code (pregnancy, hospice, frailty, sudEpisode) is a real fact about
    // the patient that this corpus cannot yet express as a retrievable resource. It is skipped rather
    // than stamped with an invented code — the omission is visible in the bundle, an invented code is
    // not, and only one of the two can quietly change a measure's denominator.
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
    const coding = EXCEPTION_CODES[exception];
    if (!coding) continue;
    clinical.push({
      resource: {
        resourceType: "Observation",
        meta: { profile: [PROFILE.observationScreening] },
        id: `${patient.externalId}-exception-${index + 1}`,
        status: "final",
        category: [{ coding: [{ system: OBSERVATION_CATEGORY, code: "survey" }] }],
        subject: { reference: `Patient/${patient.externalId}` },
        code: codeable(coding),
        effectiveDateTime: `${patient.visits[0] ?? evaluationDate}T09:15:00Z`,
      },
      date: patient.visits[0] ?? evaluationDate,
      external: false,
    });
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
