/**
 * QRDA Category III (aggregate quality report) export — STUB (#91 / E3.3). Builds a well-formed
 * HL7 CDA R2 QRDA III document for a completed single-measure run's aggregate results, reusing the
 * E3.1 proportion counts (countPopulations). Hand-built XML, balanced by construction (no FHIR/CDA
 * runtime, no new dep), mirroring src/fhir/mat-export.ts. STUB: well-formed + structurally
 * representative of QRDA III, NOT validated against the QRDA III IG/Schematron — see
 * docs/STANDARDS_CONFORMANCE.md. TemplateIds are the well-known QRDA III OIDs.
 */
import type { RunRecord } from "../stores/run-store.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";
import { loadOfficialArtifact, officialMeasureIdentifiers } from "../wiring/official-artifacts.ts";
import { ACT, EMEASURE_ID_ROOT, LOINC, esc, hl7Ts } from "./qrda-common.ts";
import {
  countPopulations,
  officialReportIdentity,
  type PopulationCounts,
  type OfficialReportIdentity,
} from "./measure-report.ts";




const POPULATIONS: Array<{ code: string; label: string }> = [
  { code: "IPOP", label: "initial-population" },
  { code: "DENOM", label: "denominator" },
  { code: "DENEX", label: "denominator-exclusion" },
  { code: "NUMER", label: "numerator" },
  // Exceptions exist only for official-routed measures (CMS68-class); the observation is emitted
  // only when the count is non-zero, so every authored measure's QRDA stays byte-identical.
  { code: "DENEXCEP", label: "denominator-exception" },
];


/**
 * The `externalDocument` measure reference — official identity when the counts came from an official
 * artifact, WorkWell's urn otherwise.
 *
 * `manifest.cmsId` is the PUBLISHER identifier (`"122FHIR"`), not what QRDA III references (Codex, #357).
 * The published Measure carries the two identifiers a receiver resolves: the **version-specific** UUID
 * under the eMeasure Identifier root `2.16.840.1.113883.4.738`, and the **version-independent** UUID as
 * `setId`. Without them a consumer cannot tie this organizer to the published measure version whose logic
 * produced the counts — which is the whole point of labelling an official export.
 *
 * Falls back to the WorkWell urn if the artifact is missing or carries no typed identifiers, because a
 * wrong official identity is worse than an honest local one: it would assert a provenance a receiver
 * would then resolve to the wrong measure.
 */
function officialMeasureReference(measureId: string, official: OfficialReportIdentity | null): string {
  if (!official) return `<id root="urn:workwell:measure" extension="${esc(measureId)}"/>`;
  const artifact = loadOfficialArtifact(measureId);
  const ids = artifact ? officialMeasureIdentifiers(artifact) : {};
  if (!ids.versionSpecific) {
    return `<id root="urn:workwell:measure" extension="${esc(measureId)}"/>`;
  }
  return [
    `<id root="${EMEASURE_ID_ROOT}" extension="${esc(ids.versionSpecific)}"/>`,
    ids.versionIndependent ? `
                  <setId root="${esc(ids.versionIndependent)}"/>` : "",
    official.version ? `
                  <versionNumber value="${esc(official.version)}"/>` : "",
  ].join("");
}

export function buildQrda3Document(run: RunRecord, measureId: string, outcomes: OutcomeRecord[]): string {
  const official = outcomes.map((o) => officialReportIdentity(o.evidence)).find((i) => i !== null) ?? null;
  return buildQrda3DocumentFromCounts(run, measureId, countPopulations(outcomes, measureId), official);
}

/** QRDA III from pre-aggregated proportion counts (the bounded Fable H4 path). */
export function buildQrda3DocumentFromCounts(
  run: RunRecord,
  measureId: string,
  c: PopulationCounts,
  /**
   * The official artifact these counts came from, when they did (ADR-046).
   *
   * QRDA III has **no `improvementNotation` element** — a receiver derives the direction from the
   * measure identity, which is exactly why identity is the fix here rather than a new element. Emitting
   * `urn:workwell:measure|cms122` over counts whose numerator is CMS's *poor glycemic control* tells a
   * receiver to interpret an inverse measure as WorkWell's compliance-oriented one. The counts were
   * already correct (`aggregateCountsForRun` reads provenance from the RUN, not the current flag); the
   * label was not.
   */
  official: OfficialReportIdentity | null = null,
): string {
  const counts: Record<string, number> = {
    IPOP: c.ipp, DENOM: c.denom, DENEX: c.denex, NUMER: c.numer, DENEXCEP: c.denexcep,
  };
  const now = hl7Ts(new Date().toISOString());
  const low = hl7Ts(run.measurementPeriodStart);
  const high = hl7Ts(run.measurementPeriodEnd);
  // Must match `buildSummaryMeasureReportFromCounts` exactly — the two exporters describe the same
  // run and are compared against each other by the certification loop (M-B).
  const effectiveDenominator = c.denom - c.denex - c.denexcep;
  const perfRate = effectiveDenominator > 0 ? (c.numer / effectiveDenominator).toFixed(4) : "0";

  const populationObs = POPULATIONS.filter(({ code }) => code !== "DENEXCEP" || c.denexcep > 0).map(
    ({ code, label }) => `
          <component>
            <observation classCode="OBS" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.27.3.3"/>
              <code code="ASSERTION" codeSystem="${ACT}"/>
              <value xsi:type="CD" code="${code}" codeSystem="${ACT}" displayName="${esc(label)}"/>
              <entryRelationship typeCode="SUBJ">
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.27.3.24"/>
                  <code code="MSRAGG" codeSystem="${ACT}" displayName="rate aggregation"/>
                  <value xsi:type="INT" value="${counts[code]}"/>
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
  <templateId root="2.16.840.1.113883.10.20.27.1.1" extension="2017-06-01"/>
  <templateId root="2.16.840.1.113883.10.20.27.1.2" extension="2017-06-01"/>
  <id root="${crypto.randomUUID()}"/>
  <code code="55184-6" codeSystem="${LOINC}" codeSystemName="LOINC" displayName="Quality Reporting Document Architecture Calculated Summary Report"/>
  <title>WorkWell QRDA Category III — ${esc(measureId)}${official ? ` (official ${esc(official.ecqmId ?? measureId)} v${esc(official.version ?? "?")})` : ""}</title>
  <effectiveTime value="${now}"/>
  <confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25"/>
  <languageCode code="en-US"/>
  <component>
    <structuredBody>
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.27.2.1" extension="2017-06-01"/>
          <code code="55186-1" codeSystem="${LOINC}" codeSystemName="LOINC" displayName="Measure Section"/>
          <title>Measure Section</title>
          <text>Aggregate results for measure ${esc(measureId)} (run ${esc(run.id)}).</text>
          <entry>
            <organizer classCode="CLUSTER" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.27.3.1" extension="2017-06-01"/>
              <statusCode code="completed"/>
              <reference typeCode="REFR">
                <externalDocument classCode="DOC" moodCode="EVN">
                  ${officialMeasureReference(measureId, official)}
                </externalDocument>
              </reference>
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.27.3.5"/>
                  <code code="MSRRPTPER" codeSystem="${ACT}" displayName="measurement period"/>
                  <effectiveTime>
                    <low value="${low}"/>
                    <high value="${high}"/>
                  </effectiveTime>
                </observation>
              </component>${populationObs}
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.27.3.4"/>
                  <code code="REASON" codeSystem="${ACT}" displayName="performance rate"/>
                  <value xsi:type="REAL" value="${perfRate}"/>
                </observation>
              </component>
            </organizer>
          </entry>
        </section>
      </component>
    </structuredBody>
  </component>
</ClinicalDocument>
`;
}
