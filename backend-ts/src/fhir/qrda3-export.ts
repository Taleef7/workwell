/**
 * QRDA Category III (aggregate quality report) export (#91 / E3.3). Builds an HL7 CDA R2 QRDA III
 * document for a completed single-measure run's aggregate results, reusing the E3.1 proportion counts
 * (countPopulations). Hand-built XML, balanced by construction (no FHIR/CDA runtime, no new dep),
 * mirroring src/fhir/mat-export.ts.
 *
 * **It was a "structurally representative" stub until 2026-08-02, and Cypress CVU+ measured the gap at
 * 48 findings** (`docs/evidence/CVU_VALIDATION_RUN_2026-08-02.md` §5.4). Three kinds of wrong, none of
 * which a well-formedness check could see:
 *
 *  1. **The whole CDA header was missing** — no `recordTarget`, `author` or `custodian`, all SHALL. For
 *     an aggregate report `recordTarget` is present with `<id nullFlavor="NA"/>`: CDA requires a patient
 *     identifier and this document is about a population, so it is nulled rather than invented.
 *  2. **The population templates were INVERTED.** `…27.3.3` is the *Aggregate Count* template and sat on
 *     the OUTER assertion observation, with `…27.3.24` on the inner one. So the validator applied
 *     Aggregate Count's rules to the outer element (missing `MSRAGG`, `methodCode`, `INT` value — three
 *     findings per population) while the inner element that satisfied all three was validated as nothing.
 *     Correct nesting is Measure Data `…27.3.5` wrapping Aggregate Count `…27.3.3`.
 *  3. **TemplateId version drift** — `2017-06-01` where R2.1 wants `2020-12-01`, and `…27.3.5` needs
 *     `2016-09-01`. The performance rate was `…27.3.4` + `code="REASON"`; it is `…27.3.14`/`…27.3.30`
 *     with LOINC `72510-1` and a `reference` to the numerator it rates.
 *
 * Also **dropped: `…27.1.2`**, which this document claimed with extension `2017-06-01`. It is
 * "QRDA Category III Report - **CMS** (V4)" (extension `2022-12-01`), appearing only in Cypress's CMS
 * fixture and not its HL7 one — the same misdeclaration ADR-050 corrected for Category I's `…24.1.3`.
 * The HL7 ruler never flagged it because the extension was wrong too, so it matched no rule at all.
 *
 * **The reference for all of this is Cypress's own conformant fixture**
 * (`test/fixtures/qrda/cat_III/ep_test_qrda_cat3_good_invalid_id.xml`), read out of the running
 * container — derived, not guessed. Like Category I, there is deliberately no `legalAuthenticator`: it
 * would require an `assignedPerson` no real person stands behind, and the HL7 ruler does not require it.
 *
 * ## Multi-rate and stratified measures (ADR-074, 2026-09-06)
 *
 * CMS137 (MIPS 305) declares TWO groups over one denominator — Initiation and Engagement — and three
 * age strata per group. Until 2026-09-06 this exporter took ONE set of counts, so the route refused a
 * multi-rate measure with a 501 rather than emit rate 1 under the measure's identity. It now takes every
 * rate: one Performance Rate observation per group, each `reference`ing ITS numerator criterion
 * (`Numerator_2`, not `Numerator_1`), one Measure Data observation per population per group naming the
 * group's own criterion (`InitialPopulation_2`…), and — where the group declares strata — one
 * **Reporting Stratum (V2)** observation (`…27.3.4`, extension `2016-09-01`) nested in each Measure Data
 * observation per stratum, with its own Aggregate Count and a `reference` naming the stratum criterion
 * (`Stratification_1_1`). CMS requires every declared stratum to be reported for a stratified measure;
 * a document without them is a wrong submission that looks complete.
 *
 * The Reporting Stratum shape (ASSERTION code, `nullFlavor="OTH"` value with `originalText`, Aggregate
 * Count via `SUBJ`/`inversionInd`, `externalObservation` reference) is derived from the QRDA III R2.1
 * IG and the `cqm-reports` reference exporter's `_stratification` template, NOT yet from a CVU+ run —
 * the 0-findings claim in `docs/STANDARDS_CONFORMANCE.md` covers the single-rate, unstratified document.
 * A stratified document must be re-validated before that claim is extended to it.
 *
 * See docs/STANDARDS_CONFORMANCE.md for the current measured level.
 */
import type { RunRecord } from "../stores/run-store.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";
import { loadOfficialArtifact, officialMeasureIdentifiers } from "../wiring/official-artifacts.ts";
import {
  ACT,
  CUSTODIAN_ID_ROOT,
  DEVICE_ID_ROOT,
  LOINC,
  MEASURE_CRITERION_ID_ROOT,
  esc,
  hl7Ts,
  qrdaMeasureReference,
} from "./qrda-common.ts";
import {
  aggregateByRate,
  officialReportIdentity,
  type PopulationCounts,
  type OfficialReportIdentity,
  type StratumCounts,
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
  return qrdaMeasureReference(
    measureId,
    official,
    loadOfficialArtifact(measureId),
    officialMeasureIdentifiers,
    "                  ",
  );
}

/** The published `Measure.group` list, when the artifact that produced these counts is the one vendored. */
function publishedGroups(
  measureId: string,
  official: OfficialReportIdentity | null,
): Array<{ population?: Array<{ id?: string; code?: { coding?: Array<{ code?: string }> } }>; stratifier?: Array<{ id?: string }> }> {
  if (!official) return [];
  try {
    const artifact = loadOfficialArtifact(measureId);
    // The SAME sha gate `qrdaMeasureReference` applies to the measure identity (ADR-046 decision 3).
    // Without it, exporting a historical run after a re-vendor would name criteria out of the CURRENT
    // artifact while the measure identity beside them had already fallen back to a version-qualified
    // local id — one document asserting "these counts are not from the artifact I have" and "these are
    // its criterion names" at the same time. Falling back to the population codes keeps the whole
    // document consistent about which artifact it can and cannot speak for (review, #384).
    const shaMatches =
      artifact && (!official.artifactSha256 || artifact.manifest.sha256 === official.artifactSha256);
    if (!shaMatches) return [];
    const bundle = artifact.bundle as
      | { entry?: Array<{ resource?: { resourceType?: string; group?: unknown[] } }> }
      | undefined;
    const measure = bundle?.entry?.map((e) => e.resource).find((r) => r?.resourceType === "Measure");
    return (measure?.group ?? []) as ReturnType<typeof publishedGroups>;
  } catch {
    // A missing or malformed artifact must not fail the export — the fallback is honest.
    return [];
  }
}

/**
 * Maps a CDA population code (`IPOP`) to the name of the criterion it counts, FOR ONE GROUP.
 *
 * Official measures resolve to the published `Measure.group[i].population.id` (`InitialPopulation_1`,
 * `InitialPopulation_2`…); everything else — an authored measure, a missing artifact, a group whose
 * populations are unnamed — falls back to the CDA code itself. The fallback is deliberate rather than a
 * throw: a QRDA III for an authored measure is already structurally non-conformant in its measure
 * identity (ADR-046 d3), and refusing to build it here would trade a nameable limitation for an outage.
 */
function criterionNamer(
  groups: ReturnType<typeof publishedGroups>,
  groupIndex: number,
): (code: string) => string {
  const byLabel = new Map<string, string>();
  for (const p of groups[groupIndex]?.population ?? []) {
    const label = p.code?.coding?.[0]?.code;
    if (label && p.id) byLabel.set(label, p.id);
  }
  const labelOf = new Map(POPULATIONS.map(({ code, label }) => [code, label]));
  return (code) => byLabel.get(labelOf.get(code) ?? "") ?? code;
}

export function buildQrda3Document(run: RunRecord, measureId: string, outcomes: OutcomeRecord[]): string {
  const official = outcomes.map((o) => officialReportIdentity(o.evidence)).find((i) => i !== null) ?? null;
  const { rates, strata } = aggregateByRate(outcomes, measureId);
  return buildQrda3DocumentFromCounts(run, measureId, rates.length > 1 ? rates : rates[0]!, official, strata);
}

/** The eCQM proportion performance rate, as the fixed-4 string the document carries. */
function performanceRate(c: PopulationCounts): string {
  // Must match `buildSummaryMeasureReportFromCounts` exactly — the two exporters describe the same
  // run and are compared against each other by the certification loop (M-B).
  const effectiveDenominator = c.denom - c.denex - c.denexcep;
  return effectiveDenominator > 0 ? (c.numer / effectiveDenominator).toFixed(4) : "0";
}

/** A Reporting Stratum (V2) for one stratum of one population — nested inside the Measure Data observation. */
function reportingStratum(stratumId: string, count: number): string {
  return `
                  <entryRelationship typeCode="COMP">
                    <observation classCode="OBS" moodCode="EVN">
                      <templateId root="2.16.840.1.113883.10.20.27.3.4" extension="2016-09-01"/>
                      <code code="ASSERTION" codeSystem="${ACT}" codeSystemName="ActCode" displayName="Assertion"/>
                      <statusCode code="completed"/>
                      <value xsi:type="CD" nullFlavor="OTH">
                        <originalText>${esc(stratumId)}</originalText>
                      </value>
                      <entryRelationship typeCode="SUBJ" inversionInd="true">
                        <observation classCode="OBS" moodCode="EVN">
                          <templateId root="2.16.840.1.113883.10.20.27.3.3"/>
                          <code code="MSRAGG" codeSystem="${ACT}" codeSystemName="ActCode" displayName="rate aggregation"/>
                          <value xsi:type="INT" value="${count}"/>
                          <methodCode code="COUNT" codeSystem="2.16.840.1.113883.5.84" codeSystemName="ObservationMethod" displayName="Count"/>
                        </observation>
                      </entryRelationship>
                      <reference typeCode="REFR">
                        <externalObservation classCode="OBS" moodCode="EVN">
                          <id root="${MEASURE_CRITERION_ID_ROOT}" extension="${esc(stratumId)}"/>
                        </externalObservation>
                      </reference>
                    </observation>
                  </entryRelationship>`;
}

/** QRDA III from pre-aggregated proportion counts (the bounded Fable H4 path). */
export function buildQrda3DocumentFromCounts(
  run: RunRecord,
  measureId: string,
  /**
   * One rate's counts, or an ARRAY with one entry per rate for a multi-rate measure — every group is
   * reported, each under its own criterion names and with its own performance rate (ADR-074).
   */
  c: PopulationCounts | PopulationCounts[],
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
  /** Per rate, the strata the group declares (empty for an unstratified group). Index-aligned with `c`. */
  strata: StratumCounts[][] = [],
): string {
  const rates = Array.isArray(c) ? c : [c];
  const groups = publishedGroups(measureId, official);
  const now = hl7Ts(new Date().toISOString());
  const low = hl7Ts(run.measurementPeriodStart);
  const high = hl7Ts(run.measurementPeriodEnd);

  const components = rates.map((counts, groupIndex) => {
    const criterionId = criterionNamer(groups, groupIndex);
    const groupStrata = strata[groupIndex] ?? [];
    const countsFor: Record<string, number> = {
      IPOP: counts.ipp, DENOM: counts.denom, DENEX: counts.denex, NUMER: counts.numer, DENEXCEP: counts.denexcep,
    };
    const stratumCount = (s: StratumCounts, code: string): number => {
      const inStratum: Record<string, number> = {
        IPOP: s.inStratum.ipp, DENOM: s.inStratum.denom, DENEX: s.inStratum.denex, NUMER: s.inStratum.numer, DENEXCEP: s.inStratum.denexcep,
      };
      return inStratum[code] ?? 0;
    };
    // The performance rate observation `reference`s the numerator it rates. For a multi-rate measure the
    // reference carries the GROUP's own numerator criterion id, so Engagement's rate cannot be read as
    // Initiation's; the single-rate document keeps the shape CVU+ validated.
    const numeratorReference = rates.length > 1
      ? `<id root="${MEASURE_CRITERION_ID_ROOT}" extension="${esc(criterionId("NUMER"))}"/>`
      : `<id root="${crypto.randomUUID()}"/>`;
    const performance = `
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.27.3.14" extension="2020-12-01"/>
                  <templateId root="2.16.840.1.113883.10.20.27.3.30" extension="2016-09-01"/>
                  <code code="72510-1" codeSystem="${LOINC}" codeSystemName="LOINC" displayName="Performance Rate"/>
                  <statusCode code="completed"/>
                  <value xsi:type="REAL" value="${performanceRate(counts)}"/>
                  <reference typeCode="REFR">
                    <externalObservation classCode="OBS" moodCode="EVN">
                      ${numeratorReference}
                      <code code="NUMER" codeSystem="${ACT}" codeSystemName="ObservationValue" displayName="Numerator"/>
                    </externalObservation>
                  </reference>
                </observation>
              </component>`;
    // Each Measure Data observation SHALL carry a `reference`/`externalObservation`/`id` naming the
    // population CRITERION it counts (CONF:3259-18239/18240/18241). For an official measure that criterion
    // is a real element of CMS's published `Measure` — `InitialPopulation_1`, `Numerator_1` and so on — so
    // the reference points at it by name under WorkWell's own root: the root says whose identifier scheme
    // this is (ours), the extension says which criterion (theirs). For an authored measure no published
    // criterion exists, so it falls back to the population code, which is the most specific thing that is
    // actually true. Note Cypress's own 2018 fixture omits this element entirely — the 2026 Schematron is
    // stricter than the file was written against, so the fixture is a shape reference, not a pass oracle.
    //
    // Measure Data (…27.3.5) wrapping an Aggregate Count (…27.3.3), which is the ORDER the IG defines and
    // the inverse of what this exporter shipped until 2026-08-02: `…27.3.3` sat on the OUTER observation
    // and `…27.3.24` on the inner one. Because `…27.3.3` IS the Aggregate Count template, CVU+ applied
    // Aggregate Count's rules to the outer element and reported it missing `MSRAGG`, `methodCode` and an
    // `INT` value — three findings per population, 12 per document — while the inner element, which
    // actually had all three, was validated as nothing at all. Derived from Cypress's own conformant
    // fixture (`test/fixtures/qrda/cat_III/ep_test_qrda_cat3_good_invalid_id.xml`), not from guesswork.
    const populationObs = POPULATIONS.filter(({ code }) => code !== "DENEXCEP" || counts.denexcep > 0).map(
      ({ code, label }) => `
              <component>
                <observation classCode="OBS" moodCode="EVN">
                  <templateId root="2.16.840.1.113883.10.20.27.3.5" extension="2016-09-01"/>
                  <code code="ASSERTION" codeSystem="${ACT}" codeSystemName="ActCode" displayName="Assertion"/>
                  <statusCode code="completed"/>
                  <value xsi:type="CD" code="${code}" codeSystem="${ACT}" codeSystemName="ActCode" displayName="${esc(label)}"/>
                  <entryRelationship typeCode="SUBJ" inversionInd="true">
                    <observation classCode="OBS" moodCode="EVN">
                      <templateId root="2.16.840.1.113883.10.20.27.3.3"/>
                      <code code="MSRAGG" codeSystem="${ACT}" codeSystemName="ActCode" displayName="rate aggregation"/>
                      <value xsi:type="INT" value="${countsFor[code]}"/>
                      <methodCode code="COUNT" codeSystem="2.16.840.1.113883.5.84" codeSystemName="ObservationMethod" displayName="Count"/>
                    </observation>
                  </entryRelationship>${groupStrata.map((s) => reportingStratum(s.id, stratumCount(s, code))).join("")}
                  <reference typeCode="REFR">
                    <externalObservation classCode="OBS" moodCode="EVN">
                      <id root="${MEASURE_CRITERION_ID_ROOT}" extension="${esc(criterionId(code))}"/>
                    </externalObservation>
                  </reference>
                </observation>
              </component>`,
    ).join("");
    return performance + populationObs;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <realmCode code="US"/>
  <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>
  <templateId root="2.16.840.1.113883.10.20.27.1.1" extension="2020-12-01"/>
  <id root="${crypto.randomUUID()}"/>
  <code code="55184-6" codeSystem="${LOINC}" codeSystemName="LOINC" displayName="Quality Reporting Document Architecture Calculated Summary Report"/>
  <title>WorkWell QRDA Category III — ${esc(measureId)}${official ? ` (official ${esc(official.ecqmId ?? measureId)} v${esc(official.version ?? "?")})` : ""}</title>
  <effectiveTime value="${now}"/>
  <confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25"/>
  <languageCode code="en-US"/>
  <versionNumber value="1"/>
  <recordTarget>
    <patientRole>
      <id nullFlavor="NA"/>
    </patientRole>
  </recordTarget>
  <author>
    <time value="${now}"/>
    <assignedAuthor>
      <id root="${DEVICE_ID_ROOT}" extension="workwell-measure-studio"/>
      <assignedAuthoringDevice>
        <manufacturerModelName>WorkWell Measure Studio</manufacturerModelName>
        <softwareName>WorkWell Measure Studio QRDA Category III exporter</softwareName>
      </assignedAuthoringDevice>
      <representedOrganization>
        <id root="${CUSTODIAN_ID_ROOT}" extension="workwell-measure-studio"/>
        <name>WorkWell Measure Studio</name>
      </representedOrganization>
    </assignedAuthor>
  </author>
  <custodian>
    <assignedCustodian>
      <representedCustodianOrganization>
        <id root="${CUSTODIAN_ID_ROOT}" extension="workwell-measure-studio"/>
        <name>WorkWell Measure Studio</name>
      </representedCustodianOrganization>
    </assignedCustodian>
  </custodian>
  <component>
    <structuredBody>
      <component>
        <section>
          <templateId root="2.16.840.1.113883.10.20.17.2.1"/>
          <templateId root="2.16.840.1.113883.10.20.27.2.2"/>
          <code code="55187-9" codeSystem="${LOINC}" codeSystemName="LOINC" displayName="Reporting Parameters"/>
          <title>Reporting Parameters</title>
          <text>
            <list>
              <item>Reporting period: ${esc(run.measurementPeriodStart)} to ${esc(run.measurementPeriodEnd)}</item>
            </list>
          </text>
          <entry typeCode="DRIV">
            <act classCode="ACT" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.17.3.8" extension="2020-12-01"/>
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
          <templateId root="2.16.840.1.113883.10.20.27.2.1" extension="2020-12-01"/>
          <code code="55186-1" codeSystem="${LOINC}" codeSystemName="LOINC" displayName="Measure Section"/>
          <title>Measure Section</title>
          <text>Aggregate results for measure ${esc(measureId)} (run ${esc(run.id)})${rates.length > 1 ? `, ${rates.length} rates` : ""}.</text>
          <entry>
            <organizer classCode="CLUSTER" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.24.3.98"/>
              <templateId root="2.16.840.1.113883.10.20.27.3.1" extension="2020-12-01"/>
              <id root="${crypto.randomUUID()}"/>
              <statusCode code="completed"/>
              <reference typeCode="REFR">
                <externalDocument classCode="DOC" moodCode="EVN">
                  ${officialMeasureReference(measureId, official)}
                </externalDocument>
              </reference>${components}
            </organizer>
          </entry>
          <entry>
            <act classCode="ACT" moodCode="EVN">
              <templateId root="2.16.840.1.113883.10.20.17.3.8" extension="2020-12-01"/>
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
    </structuredBody>
  </component>
</ClinicalDocument>
`;
}
