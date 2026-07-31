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
import { ROSTER_ELIGIBLE_MEASURES } from "../engine/ingress/enrollment/roster.ts";
import { loadOfficialArtifact, officialMeasureIdentifiers } from "../wiring/official-artifacts.ts";
import { officialReportIdentity } from "./measure-report.ts";
import { EMEASURE_ID_ROOT, LOINC, esc, hl7Date, hl7Ts, qrdaMeasureReference } from "./qrda-common.ts";
import { qdmEntriesFor, translateQdm, type QdmTranslation } from "./qdm-entries.ts";

/**
 * The run evaluated a bundle this document does NOT reproduce, and that has to be said out loud.
 *
 * For a `ROSTER_ELIGIBLE_MEASURES` measure the pipeline evaluates `stampEnrollment(bundle, …)`, which
 * overlays a roster-derived enrollment Condition and — for cms125 — a **synthesized CPT 99213
 * Encounter**, because WebChart supplies none (ADR-042). Codex (#361) asked for that overlay to be
 * reapplied at export so a receiver recalculates our answer. **We deliberately do not**, on the
 * ADR-037 rule that this exporter normalizes and never fabricates: a QDM `Encounter, Performed` asserts
 * a clinical encounter *happened*, the roster's does not, and a receiver has no way to tell which entry
 * was inferred. Exporting real data and naming the omission is the lesser evil — the alternative is a
 * silent false clinical assertion inside a regulatory artifact.
 *
 * The cost is real and is exactly what this string exists to make legible: a receiver recalculating
 * from this document may put the subject OUT of the initial population that WorkWell scored them in.
 */
function rosterEvidenceCaveat(measureId: string): string {
  return (
    `${measureId} is roster-eligible: the run evaluated a bundle carrying roster-derived enrollment ` +
    `evidence (for cms125, a SYNTHESIZED qualifying Encounter — ADR-042) which this document omits ` +
    `because it is not patient data. A receiver recalculating from these entries alone may place the ` +
    `subject outside the initial population.`
  );
}

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

interface HeaderPatient {
  gender?: string;
  birthDate?: string;
  name?: Array<{ given?: string[]; family?: string; text?: string }>;
}

/** The bundle's `Patient`, if there is one — the only resource the header reads. */
function patientOf(bundle: unknown): HeaderPatient | undefined {
  const raw = (bundle as { entry?: unknown } | undefined)?.entry;
  const entries = Array.isArray(raw) ? raw : [];
  for (const item of entries) {
    const resource = (item as { resource?: { resourceType?: string } } | null)?.resource;
    if (resource?.resourceType === "Patient") return resource as HeaderPatient;
  }
  return undefined;
}

/**
 * The subject's `{given, family}` — from the FHIR Patient first, the synthetic catalog second.
 *
 * The catalog is keyed on synthetic external ids, so for a live WebChart subject persisted as
 * `wc|123` it returns nothing and the name used to fall back to the id itself — putting an identifier
 * into a CDA name field and misdescribing the patient in every live export (Codex, #361). The bundle
 * is the better source anyway: it is the record the measure was computed from.
 */
function nameOf(subjectId: string, patient: HeaderPatient | undefined): { given: string; family: string } {
  const fhirName = patient?.name?.[0];
  const given = fhirName?.given?.[0];
  const family = fhirName?.family;
  if (given || family) return { given: given ?? family!, family: family ?? given! };
  const display = fhirName?.text ?? employeeById(subjectId)?.name;
  if (display) {
    const [first, ...rest] = display.split(" ");
    return { given: first ?? display, family: rest.join(" ") || display };
  }
  // No name anywhere. `nullFlavor` is not available on the US Realm name parts we emit, so the id is
  // the only remaining truthful token — and it is at least not a DIFFERENT person's name.
  return { given: subjectId, family: subjectId };
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
  const patient = patientOf(bundle);
  const { given, family } = nameOf(subjectId, patient);
  const sex = SEX_CONCEPTS[patient?.gender ?? ""];
  // The BUNDLE wins on birth date for the same reason it wins on name: it is the record evaluated.
  const birthDate = patient?.birthDate ?? employeeById(subjectId)?.dateOfBirth;
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
          <given>${esc(given)}</given>
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
  /** Pre-computed by the batch path so each subject is translated once, never twice. */
  precomputed?: { entries: string[]; reference: string },
): string {
  const now = hl7Ts(new Date().toISOString());
  const low = hl7Ts(run.measurementPeriodStart);
  const high = hl7Ts(run.measurementPeriodEnd);
  const entries = precomputed?.entries ?? (patientBundle ? qdmEntriesFor(patientBundle) : []);
  const reference = precomputed?.reference ?? measureReference(measureId, outcome.evidence);
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
  const rosterCaveat =
    patientBundle !== undefined && ROSTER_ELIGIBLE_MEASURES.has(measureId)
      ? `\n            OMITTED: ${esc(rosterEvidenceCaveat(measureId))}`
      : "";
  const patientData = entries.length
    ? `<text>QDM patient data for measure ${esc(measureId)}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}.${rosterCaveat}</text>
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
 * Index bundles by every subject id an outcome could carry for them.
 *
 * Extracted from the route so the KEY CONTRACT is testable, because that contract is what broke: a live
 * run persists `subjectId` as the roster external id `wc|<patientId>` (`run-pipeline.ts` builds the work
 * item from `profileForId("wc|" + patientId)` and stores `employee.externalId`), while the bundle itself
 * carries the bare `Patient.id`. Keying on one form only made the lookup miss every time on the sole
 * path meant to produce conformant documents — present, plausible, structurally incapable of firing
 * (review + Codex, #361). The unit tests inject `bundleFor` with already-matching keys, which is exactly
 * why they could not see it; `qrda1-export.test.ts` now pins this against the real `profileForId`.
 */
export function indexBundlesBySubject(
  bundles: readonly unknown[],
  patientIdOf: (bundle: unknown) => string | undefined,
): (subjectId: string) => unknown | undefined {
  const bySubject = new Map<string, unknown>();
  for (const bundle of bundles) {
    let id: string | undefined;
    try {
      id = patientIdOf(bundle);
    } catch {
      continue; // `subjectIdOf` reads `bundle.entry` directly and throws on a null payload
    }
    if (id === undefined) continue;
    for (const key of [id, `wc|${id}`]) if (!bySubject.has(key)) bySubject.set(key, bundle);
  }
  return (subjectId: string) => bySubject.get(subjectId);
}

/**
 * Why a document is not a conformant QRDA Category I — empty when it is.
 *
 * Both causes are structural SHALLs, and both are states this exporter deliberately reaches rather than
 * papers over: a bundle it could not read, and a measure with no published identity to name.
 */
export function qrda1NonConformance(outcome: OutcomeRecord, measureId: string, bundle: unknown): string[] {
  const translation = bundle === undefined ? { entries: [], untranslatable: [] } : translateQdm(bundle);
  return nonConformanceFrom(measureId, translation, measureReference(measureId, outcome.evidence));
}

/** The reasons, from already-computed inputs — so the batch path can translate each subject once. */
function nonConformanceFrom(measureId: string, translation: QdmTranslation, reference: string): string[] {
  const reasons: string[] = [];
  if (translation.entries.length === 0) {
    reasons.push("no QDM patient data entries (CONF:67-14567) — the measure cannot be recalculated from this document");
  }
  // WHY nothing translated, when there is a why an operator can act on. Reporting only "no entries" for
  // a bundle that was present and full of resources is the misleading half of the truth: WorkWell's
  // authored measures bind synthetic `urn:workwell:vs:*` value sets, which have no CDA code system OID,
  // so their data cannot be carried by a QRDA at all. Found by the import round trip.
  for (const reason of translation.untranslatable) reasons.push(`not exported — ${reason}`);
  if (!reference.includes(EMEASURE_ID_ROOT)) {
    reasons.push(`measure ${measureId} has no published eMeasure Identifier (CONF:67-12811) — it was evaluated from authored logic`);
  }
  return reasons;
}

/**
 * Fidelity caveats — things a receiver should know that are NOT conformance failures.
 *
 * Kept separate from `qrda1NonConformance` deliberately. A structurally valid QRDA I that omits
 * roster-derived evidence is still a valid QRDA I; folding the two together would make `conformant`
 * mean two different things at once and would mark every live cms125 document non-conformant for a
 * reason no validator would ever raise.
 */
export function qrda1Caveats(measureId: string, bundle: unknown): string[] {
  // Bundles are supplied only on the live path today, which is also the only path that stamps.
  return bundle !== undefined && ROSTER_ELIGIBLE_MEASURES.has(measureId) ? [rosterEvidenceCaveat(measureId)] : [];
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
): Array<{ subjectId: string; xml: string; conformant: boolean; nonConformanceReasons: string[]; caveats: string[] }> {
  return outcomes.map((outcome) => {
    const bundle = bundleFor?.(outcome.subjectId);
    // Translate ONCE and hand the result to both consumers. Recomputing meant `qdmEntriesFor` ran twice
    // per subject and `measureReference` twice — the latter reaching `loadOfficialArtifact`, a
    // `readFileSync` of the vendored bundle, so a 5000-subject run did 10,000 artifact reads (#361).
    const translation = bundle === undefined ? { entries: [], untranslatable: [] } : translateQdm(bundle);
    const reference = measureReference(measureId, outcome.evidence);
    const nonConformanceReasons = nonConformanceFrom(measureId, translation, reference);
    return {
      subjectId: outcome.subjectId,
      xml: buildQrda1Document(run, measureId, outcome, bundle, { entries: translation.entries, reference }),
      conformant: nonConformanceReasons.length === 0,
      nonConformanceReasons,
      caveats: qrda1Caveats(measureId, bundle),
    };
  });
}
