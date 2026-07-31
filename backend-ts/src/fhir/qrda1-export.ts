/**
 * QRDA Category I (patient-level quality report) export — M-B.
 *
 * ## What QRDA Category I actually is (ADR-050, correcting ADR-049)
 *
 * A QRDA Category I document carries a patient's **clinical data** plus a **reference to the measure**.
 * It does NOT state which populations the patient landed in — the receiving engine RECALCULATES that.
 * §170.315(c)(2) is literally "import and calculate". Measured: not one of the four CMS RY2026 Cat I
 * sample files contains a single `IPOP`, `DENOM`, `NUMER` or `MSRAGG`, and the Patient Data Section QDM
 * SHALL contain at least one entry (CONF:67-14567).
 *
 * ADR-049 shipped the inverse of that — population membership and an empty Patient Data section — which
 * is Category III machinery in a Category I envelope. The membership assertions are gone. Membership is
 * still exported, by the two artifacts that have a place for it: the FHIR MeasureReport and QRDA
 * Category III.
 *
 * ## Conformance level, stated up front
 *
 * The bar is the **HL7 QRDA I R1 STU 5.3 US Realm** IG — the standard at 45 CFR 170.205(h)(2), which
 * (c)(1) "record and export" and (c)(2) "import and calculate" both reference, and which Cypress
 * validates Category I against. It is NOT the CMS QRDA I IG: that one is titled "for Hospital Quality
 * Reporting" and governs IQR/PI/OQR, whereas CMS122 and CMS125 are Eligible Clinician measures, whose
 * CMS *submission* format is Category III. So this document deliberately does not claim the CMS
 * document template (`…24.1.3`, "QRDA Category I Report CMS") — claiming a template whose IG we do not
 * conform to is the misdeclaration this codebase keeps refusing.
 *
 * Conformance is MEASURED, not asserted: `scripts/qrda-schematron-check.py` runs the published
 * Schematron and partitions failures into base-HL7 (our bar) and CMS-hospital-only (not our bar).
 * `docs/STANDARDS_CONFORMANCE.md` carries the current numbers. Cypress **CVU+** has not run; it needs
 * Docker and remains the M-B bar.
 *
 * ## Without a bundle, this is not a QRDA I and says so
 *
 * The QDM entries come from the subject's evaluated FHIR bundle. When the caller cannot supply one the
 * Patient Data section is empty, the document is NOT conformant (CONF:67-14567), and its `<text>` says
 * exactly that. It is deliberately not reconstructed from the persisted outcome: `deriveExamConfig`'s
 * own contract says the target is a distribution BUCKET that can converge to a different status (CMS122
 * DUE_SOON → MISSING_DATA), so status → bundle is not injective and a reconstruction would be fiction
 * dressed as provenance.
 */
import type { RunRecord } from "../stores/run-store.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";
import { employeeById } from "../engine/synthetic/employee-catalog.ts";
import { loadOfficialArtifact, officialMeasureIdentifiers } from "../wiring/official-artifacts.ts";
import { officialReportIdentity } from "./measure-report.ts";
import { EMEASURE_ID_ROOT, LOINC, esc, hl7Date, hl7Ts, qrdaMeasureReference } from "./qrda-common.ts";
import { qdmEntriesFor } from "./qdm-entries.ts";

/** SNOMED CT concept ids for administrative sex, as US Core / QI-Core carry them (ADR-042). */
const SEX_CONCEPTS: Record<string, { code: string; display: string }> = {
  female: { code: "248152002", display: "Female" },
  male: { code: "248153007", display: "Male" },
};

/**
 * A CDA address whose children are all `nullFlavor`.
 *
 * MEASURED, and it corrects the #360 finding that there is "no nullFlavor escape" for `<addr>`: an
 * element-level `<addr nullFlavor="NI"/>` does NOT satisfy CONF:81-7291/7292 (streetAddressLine and
 * city are SHALL), but an `<addr>` carrying nullFlavor CHILDREN does. So a subject with no address on
 * file is representable, and an address is NOT an ingest prerequisite for validation.
 */
const NULL_ADDR = (use: string, pad: string) =>
  `<addr use="${use}">
${pad}  <streetAddressLine nullFlavor="NI"/>
${pad}  <city nullFlavor="NI"/>
${pad}  <state nullFlavor="NI"/>
${pad}  <postalCode nullFlavor="NI"/>
${pad}  <country nullFlavor="NI"/>
${pad}</addr>`;

/** The measure reference for one document — see `qrdaMeasureReference` for the sha/identity rules. */
function measureReference(measureId: string, evidence: unknown): string {
  return qrdaMeasureReference(
    measureId,
    officialReportIdentity(evidence),
    loadOfficialArtifact(measureId),
    officialMeasureIdentifiers,
    "                  ",
  );
}

/** The bundle's `Patient`, if there is one — the only resource the header reads. */
function patientOf(bundle: unknown): { gender?: string; birthDate?: string } | undefined {
  const entries = (bundle as { entry?: Array<{ resource?: { resourceType?: string } }> } | undefined)?.entry ?? [];
  return entries.find((e) => e.resource?.resourceType === "Patient")?.resource as
    | { gender?: string; birthDate?: string }
    | undefined;
}

/**
 * `<recordTarget>` — the patient this document is about.
 *
 * `administrativeGenderCode` uses the IG's own idiom (`nullFlavor="OTH"` + a SNOMED `<translation>`)
 * rather than an HL7 AdministrativeGender code, matching the CMS sample file. `raceCode` and
 * `ethnicGroupCode` are SHALL (CONF:1198-5322/5323, CONF:4509-27573/27574) and are satisfied by
 * `nullFlavor="UNK"` — measured, not assumed. The synthetic directory holds neither, and inventing a
 * race for a patient is exactly the fabrication ADR-037 forbids.
 */
function recordTarget(subjectId: string, bundle: unknown): string {
  const employee = employeeById(subjectId);
  const name = employee?.name ?? subjectId;
  const [given, ...rest] = name.split(" ");
  const family = rest.join(" ") || subjectId;
  const sex = SEX_CONCEPTS[patientOf(bundle)?.gender ?? ""];
  const birthDate = employee?.dateOfBirth ?? patientOf(bundle)?.birthDate;
  const gender = sex
    ? `<administrativeGenderCode nullFlavor="OTH">
          <translation code="${sex.code}" displayName="${sex.display}" codeSystem="2.16.840.1.113883.6.96" codeSystemName="SNOMEDCT"/>
        </administrativeGenderCode>`
    : `<administrativeGenderCode nullFlavor="UNK"/>`;
  return `  <recordTarget>
    <patientRole>
      <id root="urn:workwell:employee" extension="${esc(subjectId)}"/>
      ${NULL_ADDR("HP", "      ")}
      <telecom use="HP" nullFlavor="NI"/>
      <patient>
        <name>
          <given>${esc(given ?? subjectId)}</given>
          <family>${esc(family)}</family>
        </name>
        ${gender}
        ${birthDate ? `<birthTime value="${hl7Date(birthDate)}"/>` : `<birthTime nullFlavor="UNK"/>`}
        <raceCode nullFlavor="UNK"/>
        <ethnicGroupCode nullFlavor="UNK"/>
        <languageCommunication>
          <languageCode code="en"/>
        </languageCommunication>
      </patient>
    </patientRole>
  </recordTarget>`;
}

/**
 * `<author>` + `<custodian>` — both SHALL (CONF:1198-5444, CONF:1198-5519 / 3343-12914 / 4509-16600),
 * and both absent before ADR-050.
 *
 * The author is an `assignedAuthoringDevice`, not a person: WorkWell is software that generated this
 * document, and naming a clinician who did not author it would be a fabricated attestation. For the
 * same reason there is **no `legalAuthenticator`** — it is only a SHOULD (CONF:1198-5579), and
 * including it forces an `assignedPerson` with a US Realm name (CONF:1198-5598, CONF:81-9368) that no
 * real person stands behind. One warning is the honest price.
 */
function authorAndCustodian(now: string): string {
  return `  <author>
    <time value="${now}"/>
    <assignedAuthor>
      <id root="urn:workwell:device" extension="workwell-measure-studio"/>
      ${NULL_ADDR("WP", "      ")}
      <telecom use="WP" nullFlavor="NI"/>
      <assignedAuthoringDevice>
        <manufacturerModelName>WorkWell Measure Studio</manufacturerModelName>
        <softwareName>WorkWell Measure Studio QRDA Category I exporter</softwareName>
      </assignedAuthoringDevice>
    </assignedAuthor>
  </author>
  <custodian>
    <assignedCustodian>
      <representedCustodianOrganization>
        <id root="urn:workwell:custodian" extension="workwell-measure-studio"/>
        <name>WorkWell Measure Studio</name>
        <telecom use="WP" nullFlavor="NI"/>
        ${NULL_ADDR("WP", "        ")}
      </representedCustodianOrganization>
    </assignedCustodian>
  </custodian>`;
}

/**
 * One QRDA Category I document for one subject.
 *
 * `patientBundle` is the FHIR bundle the subject was evaluated against. Omitting it produces a document
 * that is explicitly NOT conformant — see the module docblock.
 */
export function buildQrda1Document(
  run: RunRecord,
  measureId: string,
  outcome: OutcomeRecord,
  patientBundle?: unknown,
): string {
  const now = hl7Ts(new Date().toISOString());
  const low = hl7Ts(run.measurementPeriodStart);
  const high = hl7Ts(run.measurementPeriodEnd);
  const entries = patientBundle ? qdmEntriesFor(patientBundle) : [];
  const reference = measureReference(measureId, outcome.evidence);
  const official = reference.includes(EMEASURE_ID_ROOT);
  // An eMeasure Reference QDM SHALL identify the measure by its published eMeasure Identifier root
  // (CONF:67-12811). An AUTHORED measure has no such identifier — by definition, it was never published
  // — and ADR-046 decision 3 forbids inventing one, so the document falls back to WorkWell's urn and is
  // structurally non-conformant. That is the correct outcome rather than a defect: QRDA I is a format
  // for reporting PUBLISHED eCQMs, so a measure outside that set is outside the format.
  const localIdentityNote = official
    ? ""
    : `\n            NOT CONFORMANT: measure ${esc(measureId)} was evaluated from WorkWell-authored logic, which has no
            published eMeasure Identifier. QRDA I requires one (CONF:67-12811) and this document will not
            claim an identity the run did not use.`;

  // The Patient Data section is where a receiver recalculates from. When it is empty the document says
  // so in prose — `nullFlavor` on a `<section>` is measurably INERT (identical Schematron output with
  // and without it, #360), so the claim has to live somewhere a human will read.
  const patientData = entries.length
    ? `<text>QDM patient data for measure ${esc(measureId)}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}.</text>
${entries.join("\n")}`
    : `<text>EMPTY: no FHIR bundle was available for this subject at export time, so no QDM patient
            data elements could be translated. QRDA Category I requires at least one entry here
            (CONF:67-14567); without them this document is NOT conformant and a receiving engine CANNOT
            recalculate the measure. See docs/STANDARDS_CONFORMANCE.md.</text>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <realmCode code="US"/>
  <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>
  <templateId root="2.16.840.1.113883.10.20.22.1.1" extension="2015-08-01"/>
  <templateId root="2.16.840.1.113883.10.20.24.1.1" extension="2017-08-01"/>
  <templateId root="2.16.840.1.113883.10.20.24.1.2" extension="2021-08-01"/>
  <id root="${crypto.randomUUID()}"/>
  <code code="55182-0" codeSystem="${LOINC}" codeSystemName="LOINC" displayName="Quality Measure Report"/>
  <title>WorkWell QRDA Category I — ${esc(measureId)} — ${esc(outcome.subjectId)}</title>
  <effectiveTime value="${now}"/>
  <confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25"/>
  <languageCode code="en"/>
${recordTarget(outcome.subjectId, patientBundle)}
${authorAndCustodian(now)}
  <component>
    <structuredBody>
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.17.2.1"/>
          <code code="55187-9" codeSystem="${LOINC}" displayName="Reporting Parameters"/>
          <title>Reporting Parameters</title>
          <text>Measurement period ${esc(run.measurementPeriodStart)} to ${esc(run.measurementPeriodEnd)}.</text>
          <entry typeCode="DRIV">
            <act classCode="ACT" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.17.3.8"/>
              <id root="${crypto.randomUUID()}"/>
              <code code="252116004" codeSystem="2.16.840.1.113883.6.96" displayName="Observation Parameters"/>
              <effectiveTime>
                <low value="${low}"/>
                <high value="${high}"/>
              </effectiveTime>
            </act>
          </entry>
        </section>
      </component>
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.24.2.2"/>
          <templateId root="2.16.840.1.113883.10.20.24.2.3"/>
          <code code="55186-1" codeSystem="${LOINC}" displayName="Measure Section"/>
          <title>Measure Section</title>
          <text>Measure evaluated for this patient (run ${esc(run.id)}).${localIdentityNote}</text>
          <entry>
            <organizer classCode="CLUSTER" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.24.3.98"/>
              <templateId root="2.16.840.1.113883.10.20.24.3.97"/>
              <id root="${crypto.randomUUID()}"/>
              <statusCode code="completed"/>
              <reference typeCode="REFR">
                <externalDocument classCode="DOC" moodCode="EVN">
                  ${reference}
                  <text>${esc(measureId)}</text>
                </externalDocument>
              </reference>
            </organizer>
          </entry>
        </section>
      </component>
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.17.2.4"/>
          <templateId root="2.16.840.1.113883.10.20.24.2.1" extension="2021-08-01"/>
          <code code="55188-7" codeSystem="${LOINC}" displayName="Patient Data"/>
          <title>Patient Data</title>
          ${patientData}
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>
`;
}

/**
 * Why a document is not a conformant QRDA Category I — empty when it is.
 *
 * Both causes are structural SHALLs, and both are states this exporter deliberately reaches rather than
 * papers over: a bundle it could not read, and a measure with no published identity to name.
 */
export function qrda1NonConformance(outcome: OutcomeRecord, measureId: string, bundle: unknown): string[] {
  const reasons: string[] = [];
  if (bundle === undefined || qdmEntriesFor(bundle).length === 0) {
    reasons.push("no QDM patient data entries (CONF:67-14567) — the measure cannot be recalculated from this document");
  }
  if (!measureReference(measureId, outcome.evidence).includes(EMEASURE_ID_ROOT)) {
    reasons.push(`measure ${measureId} has no published eMeasure Identifier (CONF:67-12811) — it was evaluated from authored logic`);
  }
  return reasons;
}

/**
 * Every subject's document for one run, in outcome order.
 *
 * `bundleFor` resolves a subject's FHIR bundle; subjects it cannot resolve still get a document, marked
 * non-conformant rather than omitted — a missing subject reads as "not in this run", which is a
 * different and worse claim than "we could not export this subject's data".
 */
export function buildQrda1Documents(
  run: RunRecord,
  measureId: string,
  outcomes: readonly OutcomeRecord[],
  bundleFor?: (subjectId: string) => unknown | undefined,
): Array<{ subjectId: string; xml: string; conformant: boolean; nonConformanceReasons: string[] }> {
  return outcomes.map((outcome) => {
    const bundle = bundleFor?.(outcome.subjectId);
    const nonConformanceReasons = qrda1NonConformance(outcome, measureId, bundle);
    return {
      subjectId: outcome.subjectId,
      xml: buildQrda1Document(run, measureId, outcome, bundle),
      conformant: nonConformanceReasons.length === 0,
      nonConformanceReasons,
    };
  });
}
