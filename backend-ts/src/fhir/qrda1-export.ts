/**
 * QRDA Category I (patient-level quality report) export — M-B.
 *
 * The roadmap's audit recorded that "QRDA-I does not exist anywhere"; this is it. One CDA document per
 * SUBJECT, carrying that subject's population membership for one measure, as against Category III's one
 * document per run carrying aggregate counts.
 *
 * ## Conformance level, stated up front
 *
 * **Well-formed and structurally representative of QRDA Category I; NOT validated against the QRDA I IG
 * or its Schematron.** That is the same honesty level `qrda3-export.ts` carries (ADR-009), and it stays
 * that way until Cypress **CVU+** actually runs — which is the M-B bar and needs Docker. Nothing here
 * may be described as conformant on the strength of the templateIds alone; `docs/STANDARDS_CONFORMANCE.md`
 * says so in the row that matters.
 *
 * ## Where the content comes from
 *
 * Population membership is read through `membershipFor`, which is evidence-first: an official-routed
 * outcome's populations come from `evidence.official.populationResults` — the regulatory truth — and never
 * from the 5-bucket workflow status, which cannot express DENEXCEP and inverts for an inverse measure
 * like cms122 (ADR-031). The measure is referenced by its published eMeasure UUIDs when the outcome was
 * scored officially, exactly as Category III does since ADR-046: a receiver resolves the measure (and
 * therefore its numerator orientation) from that identity, so naming WorkWell's urn over CMS's
 * populations would misdescribe the document.
 *
 * ## What is deliberately NOT emitted
 *
 * The **Patient Data section's QDM entries** — the encounters, diagnoses and results a measure's logic
 * consumed. QRDA I's purpose in a certification setting is to carry those so a receiving engine can
 * recalculate; emitting a hollow section would look conformant while making recalculation impossible,
 * which is the failure this codebase keeps naming. The section is present with an explicit
 * `nullFlavor="NI"` marker rather than absent or fabricated, and `docs/STANDARDS_CONFORMANCE.md` records
 * it as the gap it is. Populating it is the QRDA-I *import* loop's counterpart and its own piece of work.
 */
import type { RunRecord } from "../stores/run-store.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";
import { employeeById } from "../engine/synthetic/employee-catalog.ts";
import { loadOfficialArtifact, officialMeasureIdentifiers } from "../wiring/official-artifacts.ts";
import { membershipFor, officialReportIdentity, type PopulationMembership } from "./measure-report.ts";
import { ACT, LOINC, esc, hl7Date, hl7Ts, qrdaMeasureReference } from "./qrda-common.ts";

/** QRDA population codes, in report order, keyed to our membership vector. */
const POPULATIONS: ReadonlyArray<{ code: string; label: string; key: keyof PopulationMembership }> = [
  { code: "IPOP", label: "initial population", key: "ipp" },
  { code: "DENOM", label: "denominator", key: "denom" },
  { code: "DENEX", label: "denominator exclusion", key: "denex" },
  { code: "DENEXCEP", label: "denominator exception", key: "denexcep" },
  { code: "NUMER", label: "numerator", key: "numer" },
];

/**
 * The measure reference for one document.
 *
 * Version-specific UUID under the eMeasure Identifier root, version-independent as `setId` — read from
 * the vendored bundle, since `manifest.cmsId` is the PUBLISHER identifier and resolves to nothing
 * (ADR-046). Falls back to WorkWell's urn when the outcome is authored or the artifact carries no typed
 * identifiers: a wrong official identity is worse than an honest local one, because a receiver would
 * resolve it to the wrong measure.
 */
function measureReference(measureId: string, evidence: unknown): string {
  return qrdaMeasureReference(
    measureId,
    officialReportIdentity(evidence),
    loadOfficialArtifact(measureId),
    officialMeasureIdentifiers,
    "              ",
  );
}

/** `<recordTarget>` — the patient this document is about. */
function recordTarget(subjectId: string): string {
  const employee = employeeById(subjectId);
  const name = employee?.name ?? subjectId;
  const [given, ...rest] = name.split(" ");
  const family = rest.join(" ") || subjectId;
  // A synthetic directory carries no address or telecom, and QRDA I requires the elements to be
  // PRESENT. `nullFlavor="NI"` says "no information" — which is true — rather than inventing a street.
  return `  <recordTarget>
    <patientRole>
      <id root="urn:workwell:employee" extension="${esc(subjectId)}"/>
      <addr nullFlavor="NI"/>
      <telecom nullFlavor="NI"/>
      <patient>
        <name>
          <given>${esc(given ?? subjectId)}</given>
          <family>${esc(family)}</family>
        </name>
        <administrativeGenderCode nullFlavor="NI"/>
        ${employee?.dateOfBirth ? `<birthTime value="${hl7Date(employee.dateOfBirth)}"/>` : `<birthTime nullFlavor="NI"/>`}
      </patient>
    </patientRole>
  </recordTarget>`;
}

/**
 * One QRDA Category I document for one subject's outcome.
 *
 * `run` supplies the measurement period; `outcome` supplies the subject and its population membership.
 */
export function buildQrda1Document(run: RunRecord, measureId: string, outcome: OutcomeRecord): string {
  const membership = membershipFor(outcome, measureId);
  const now = hl7Ts(new Date().toISOString());
  const low = hl7Ts(run.measurementPeriodStart);
  const high = hl7Ts(run.measurementPeriodEnd);

  // Every population is emitted, including the ones this subject is NOT in. A receiver must be able to
  // tell "not in the numerator" from "the numerator was not reported", and omitting false members
  // collapses those two into the same document.
  const measureData = POPULATIONS.map(
    ({ code, label, key }) => `
            <component>
              <observation classCode="OBS" moodCode="EVN">
                <templateId root="2.16.840.1.113883.10.20.24.3.98"/>
                <code code="ASSERTION" codeSystem="${ACT}"/>
                <statusCode code="completed"/>
                <value xsi:type="CD" code="${code}" codeSystem="${ACT}" displayName="${esc(label)}"/>
                <entryRelationship typeCode="SUBJ">
                  <observation classCode="OBS" moodCode="EVN">
                    <templateId root="2.16.840.1.113883.10.20.27.3.24"/>
                    <code code="MSRAGG" codeSystem="${ACT}" displayName="rate aggregation"/>
                    <value xsi:type="INT" value="${membership[key] ? 1 : 0}"/>
                    <methodCode code="COUNT" codeSystem="2.16.840.1.113883.5.84"/>
                  </observation>
                </entryRelationship>
              </observation>
            </component>`,
  ).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <realmCode code="US"/>
  <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>
  <templateId root="2.16.840.1.113883.10.20.22.1.1" extension="2015-08-01"/>
  <templateId root="2.16.840.1.113883.10.20.24.1.2" extension="2019-02-01"/>
  <templateId root="2.16.840.1.113883.10.20.24.1.3" extension="2019-02-01"/>
  <id root="${crypto.randomUUID()}"/>
  <code code="55182-0" codeSystem="${LOINC}" codeSystemName="LOINC" displayName="Quality Measure Report"/>
  <title>WorkWell QRDA Category I — ${esc(measureId)} — ${esc(outcome.subjectId)}</title>
  <effectiveTime value="${now}"/>
  <confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25"/>
  <languageCode code="en-US"/>
${recordTarget(outcome.subjectId)}
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
          <code code="55186-1" codeSystem="${LOINC}" displayName="Measure Section"/>
          <title>Measure Section</title>
          <text>Population membership for measure ${esc(measureId)} (run ${esc(run.id)}).</text>
          <entry>
            <organizer classCode="CLUSTER" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.24.3.98"/>
              <id root="${crypto.randomUUID()}"/>
              <statusCode code="completed"/>
              <reference typeCode="REFR">
                <externalDocument classCode="DOC" moodCode="EVN">
                  ${measureReference(measureId, outcome.evidence)}
                </externalDocument>
              </reference>${measureData}
            </organizer>
          </entry>
        </section>
      </component>
      <component>
        <section nullFlavor="NI">
          <templateId root="2.16.840.1.113883.10.20.24.2.1"/>
          <code code="55188-7" codeSystem="${LOINC}" displayName="Patient Data"/>
          <title>Patient Data</title>
          <text>QDM patient data elements are not exported. This document reports population membership
            only; it does not carry the clinical data a receiving engine would need to recalculate the
            measure. See docs/STANDARDS_CONFORMANCE.md.</text>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>
`;
}

/** Every subject's document for one run, in outcome order. */
export function buildQrda1Documents(
  run: RunRecord,
  measureId: string,
  outcomes: readonly OutcomeRecord[],
): Array<{ subjectId: string; xml: string }> {
  return outcomes.map((outcome) => ({
    subjectId: outcome.subjectId,
    xml: buildQrda1Document(run, measureId, outcome),
  }));
}
