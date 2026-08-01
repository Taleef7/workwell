/**
 * QRDA Category I export (M-B / ADR-050).
 *
 * The most important test here is the boring one: the document PARSES. Every other assertion is about
 * content, and content assertions on a string that is not well-formed XML would pass happily while the
 * artifact is unusable — this file builds CDA by hand, so balance is a property to check rather than a
 * property of the tooling.
 *
 * The structural assertions cite CONF numbers from the published CMS RY2026 QRDA I Schematron. They are
 * pinned here in TypeScript because CI has no Python/lxml; `scripts/qrda-schematron-check.py` is how
 * they were derived and how to re-derive them. Against that Schematron the with-bundle document has
 * **0 base-HL7 errors** and 4 CMS-hospital-only findings, which are expected — see ADR-050.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildQrda1Document, buildQrda1Documents, indexBundlesBySubject } from "./qrda1-export.ts";
import { profileForId } from "../engine/ingress/webchart/live-directory.ts";
import { subjectIdOf } from "../engine/ingress/enrollment/roster.ts";
import type { RunRecord } from "../stores/run-store.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";

/**
 * A dependency-free well-formedness check: tags balance and nest correctly, and no raw `<`/`&` survives
 * in text. CLAUDE.md forbids new dependencies without approval, so this stands in for an XML parser —
 * and it is stronger than the regex the Category III test uses, which only checks the root element.
 *
 * Returns null when well-formed, else the first problem.
 */
function xmlProblem(xml: string): string | null {
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  while ((m = tag.exec(xml)) !== null) {
    const text = xml.slice(lastEnd, m.index);
    if (/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(text)) return `unescaped & in text near ${text.slice(0, 40)}`;
    lastEnd = tag.lastIndex;
    const [, closing, name, attrs, selfClose] = m;
    if (m[0].startsWith("<?") || m[0].startsWith("<!")) continue;
    if (/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(attrs ?? "")) return `unescaped & in attributes of <${name}>`;
    if (closing) {
      const open = stack.pop();
      if (open !== name) return `</${name}> closes <${open ?? "nothing"}>`;
    } else if (!selfClose) {
      stack.push(name!);
    }
  }
  return stack.length ? `unclosed <${stack[stack.length - 1]}>` : null;
}

const run = {
  id: "run-qrda1",
  measurementPeriodStart: "2025-01-01T00:00:00.000Z",
  measurementPeriodEnd: "2025-12-31T00:00:00.000Z",
} as RunRecord;

const outcome = (status: string, official?: Record<string, unknown>): OutcomeRecord =>
  ({
    id: "o1", runId: run.id, subjectId: "emp-006", measureId: "cms125",
    evaluationPeriod: "2025-12-31", status,
    evidence: official ? { official } : {},
    evaluatedAt: "2025-12-31T00:00:00.000Z",
  }) as OutcomeRecord;

const officialEvidence = (numer: boolean) => ({
  ecqmId: "CMS125FHIR",
  version: "1.0.000",
  engine: "fqm-execution",
  artifactSha256: undefined,
  populationResults: [
    { populationType: "initial-population", result: true },
    { populationType: "denominator", result: true },
    { populationType: "numerator", result: numer },
  ],
});

const bundle = {
  resourceType: "Bundle",
  type: "collection",
  entry: [
    { resource: { resourceType: "Patient", id: "emp-006", gender: "female", birthDate: "1975-03-12" } },
    {
      resource: {
        resourceType: "Observation", id: "obs-img",
        category: [{ coding: [{ code: "imaging" }] }],
        code: { coding: [{ system: "http://loinc.org", code: "24606-6", display: "MG Breast Screening" }] },
        effectiveDateTime: "2025-05-10T10:00:00Z",
      },
    },
  ],
};

test("QRDA I: the document is well-formed XML, with and without patient data", () => {
  for (const [label, xml] of [
    ["with bundle", buildQrda1Document(run, "cms125", outcome("COMPLIANT"), bundle)],
    ["without bundle", buildQrda1Document(run, "cms125", outcome("COMPLIANT"))],
  ] as const) {
    assert.equal(xmlProblem(xml), null, `hand-built CDA must be well-formed (${label})`);
    assert.match(xml, /<ClinicalDocument[\s\S]*<\/ClinicalDocument>\s*$/, `balanced (${label})`);
  }
});

test("QRDA I: it reports NO population membership — Category I has no place for it (ADR-050)", () => {
  // The correction that reshaped ADR-049. Measured: not one of the four CMS RY2026 Cat I sample files
  // contains an IPOP/DENOM/NUMER/MSRAGG, because the receiving engine RECALCULATES from the patient
  // data. §170.315(c)(2) is literally "import and calculate". What shipped first was Category III
  // machinery in a Category I envelope; membership now lives only in MeasureReport and QRDA III.
  const xml = buildQrda1Document(run, "cms125", outcome("OVERDUE", officialEvidence(false)), bundle);
  for (const code of ["IPOP", "DENOM", "DENEX", "DENEXCEP", "NUMER", "MSRAGG"]) {
    assert.ok(!xml.includes(`"${code}"`), `${code} must NOT appear in a Category I document`);
  }
  assert.ok(!xml.includes("2.16.840.1.113883.10.20.27.3.24"), "the Cat III Measure Data template is gone");
});

test("QRDA I: it does NOT claim the CMS Hospital document template", () => {
  // `…24.1.3` is "QRDA Category I Report CMS" — the Hospital Quality Reporting IG, which governs
  // IQR/PI/OQR. CMS122/CMS125 are Eligible Clinician measures whose CMS submission format is Category
  // III. Claiming a template whose IG we do not conform to is a misdeclaration.
  const xml = buildQrda1Document(run, "cms125", outcome("COMPLIANT"), bundle);
  assert.ok(!xml.includes("2.16.840.1.113883.10.20.24.1.3"), "no CMS-flavoured document template");
  for (const [root, ext] of [
    ["2.16.840.1.113883.10.20.22.1.1", "2015-08-01"],
    ["2.16.840.1.113883.10.20.24.1.1", "2017-08-01"],
    ["2.16.840.1.113883.10.20.24.1.2", "2021-08-01"],
  ]) {
    assert.ok(xml.includes(`<templateId root="${root}" extension="${ext}"/>`), `base HL7 ${root} @ ${ext}`);
  }
});

test("QRDA I: author and custodian are present (CONF:1198-5444, CONF:1198-5519)", () => {
  // Both were absent before ADR-050 and both are SHALL. The author is a DEVICE: WorkWell is software
  // that generated this document, and naming a clinician who did not author it would be a fabricated
  // attestation.
  const xml = buildQrda1Document(run, "cms125", outcome("COMPLIANT"), bundle);
  assert.match(xml, /<author>[\s\S]*<assignedAuthoringDevice>[\s\S]*<\/author>/);
  assert.match(xml, /<custodian>[\s\S]*<representedCustodianOrganization>[\s\S]*<\/custodian>/);
  assert.ok(!xml.includes("<assignedPerson>"), "no person is named as author");
});

test("QRDA I: there is deliberately NO legalAuthenticator", () => {
  // It is only a SHOULD (CONF:1198-5579), and including it forces an assignedPerson carrying a US Realm
  // name (CONF:1198-5598, CONF:81-9368) that no real person stands behind. One warning is the honest
  // price; a fabricated attester is not.
  const xml = buildQrda1Document(run, "cms125", outcome("COMPLIANT"), bundle);
  assert.ok(!xml.includes("<legalAuthenticator>"));
});

test("QRDA I: <addr> uses nullFlavor CHILDREN — element-level nullFlavor does not satisfy the SHALLs", () => {
  // This corrects the #360 finding that `<addr>` has "no nullFlavor escape, so a patient without an
  // address cannot validate (an INGEST prerequisite)". Measured against the Schematron:
  // `<addr nullFlavor="NI"/>` still fails CONF:81-7291 (streetAddressLine) and CONF:81-7292 (city);
  // an `<addr>` whose CHILDREN carry nullFlavor passes both. Address is not an ingest prerequisite.
  const xml = buildQrda1Document(run, "cms125", outcome("COMPLIANT"), bundle);
  assert.ok(!xml.includes('<addr nullFlavor='), "element-level nullFlavor is measurably not enough");
  assert.match(xml, /<addr use="HP">[\s\S]*<streetAddressLine nullFlavor="NI"\/>[\s\S]*<city nullFlavor="NI"\/>/);
});

test("QRDA I: raceCode and ethnicGroupCode are present as UNK (CONF:1198-5322/5323, CONF:4509-27573/27574)", () => {
  // Both are SHALL and both were absent before ADR-050. `nullFlavor="UNK"` satisfies them — measured,
  // not assumed. The synthetic directory holds neither, and inventing a race for a patient is exactly
  // the fabrication ADR-037 forbids.
  const xml = buildQrda1Document(run, "cms125", outcome("COMPLIANT"), bundle);
  assert.ok(xml.includes('<raceCode nullFlavor="UNK"/>'));
  assert.ok(xml.includes('<ethnicGroupCode nullFlavor="UNK"/>'));
});

test("QRDA I: sex is the IG's SNOMED translation idiom when known, and UNK when not", () => {
  // ADR-042 made `us-core-sex` load-bearing for CMS125's official IPP; the same SNOMED concept is what
  // QRDA carries. An `administrativeGenderCode` with no translation is indistinguishable from absent.
  const known = buildQrda1Document(run, "cms125", outcome("COMPLIANT"), bundle);
  assert.match(known, /<administrativeGenderCode nullFlavor="OTH">[\s\S]*code="248152002"/);
  const unknown = buildQrda1Document(run, "cms125", outcome("COMPLIANT"));
  assert.ok(unknown.includes('<administrativeGenderCode nullFlavor="UNK"/>'));
});

test("QRDA I: the Patient Data section carries QDM entries from the bundle", () => {
  const xml = buildQrda1Document(run, "cms125", outcome("COMPLIANT"), bundle);
  assert.ok(xml.includes('<templateId root="2.16.840.1.113883.10.20.17.2.4"/>'), "base Patient Data Section");
  assert.ok(
    xml.includes('<templateId root="2.16.840.1.113883.10.20.24.2.1" extension="2021-08-01"/>'),
    "Patient Data Section QDM (V8) — the extension was missing entirely before ADR-050",
  );
  assert.ok(xml.includes("2.16.840.1.113883.10.20.24.3.18"), "the imaging Observation became a Diagnostic Study");
  assert.ok(!xml.includes("EMPTY:"), "a populated section makes no emptiness claim");
});

test("QRDA I: with NO bundle the section is empty and the document SAYS it is not conformant", () => {
  // QRDA I SHALL contain at least one Patient Data entry (CONF:67-14567). Without one the document
  // cannot be recalculated from, and that has to be legible to a human — `nullFlavor` on a `<section>`
  // is measurably INERT (identical Schematron output either way, #360), so the claim lives in `<text>`.
  const xml = buildQrda1Document(run, "cms125", outcome("COMPLIANT"));
  assert.match(xml, /EMPTY: no FHIR bundle was available/);
  assert.match(xml, /CONF:67-14567/);
  assert.match(xml, /NOT conformant/);
  assert.match(xml, /CANNOT\s+recalculate the measure/);
  assert.ok(!xml.includes("<section nullFlavor"), "nullFlavor on a section buys nothing and must not imply it does");
});

test("QRDA I: the Measure Section carries the QDM flavour and an eMeasure Reference QDM", () => {
  const xml = buildQrda1Document(run, "cms125", outcome("COMPLIANT"), bundle);
  assert.ok(xml.includes('<templateId root="2.16.840.1.113883.10.20.24.2.3"/>'), "Measure Section QDM");
  assert.ok(xml.includes('<templateId root="2.16.840.1.113883.10.20.24.3.97"/>'), "eMeasure Reference QDM");
  assert.match(xml, /<externalDocument[\s\S]*<text>cms125<\/text>/, "the reference names the measure");
});

test("QRDA I: an OFFICIAL outcome references the published eMeasure UUIDs", () => {
  const xml = buildQrda1Document(run, "cms125", outcome("COMPLIANT", officialEvidence(true)), bundle);
  assert.match(xml, /<id root="2\.16\.840\.1\.113883\.4\.738" extension="[0-9a-f-]{36}"\/>/);
  assert.match(xml, /<setId root="[0-9a-f-]{36}"\/>/);
  assert.match(xml, /<versionNumber value="1\.0\.000"\/>/);
  assert.ok(!xml.includes('root="urn:workwell:measure"'), "an official document must not claim WorkWell's urn");
});

test("QRDA I: an AUTHORED outcome references WorkWell's urn and no eMeasure identity", () => {
  const xml = buildQrda1Document(run, "cms125", outcome("COMPLIANT"), bundle);
  assert.match(xml, /<id root="urn:workwell:measure" extension="cms125"\/>/);
  assert.ok(!xml.includes("2.16.840.1.113883.4.738"), "no official identity over authored membership");
});

test("QRDA I: a RE-VENDORED artifact does not relabel an old outcome (Codex, #360)", () => {
  // The identity is claimed only when the vendored artifact's sha matches the one the outcome was
  // scored under — the rule ADR-046 decision 3 applies to MeasureReport's canonical.
  const stale = outcome("COMPLIANT", { ...officialEvidence(true), artifactSha256: "sha256:not-the-vendored-one" });
  const xml = buildQrda1Document(run, "cms125", stale, bundle);
  assert.match(xml, /<id root="urn:workwell:measure" extension="cms125:official:1\.0\.000"\/>/);
  assert.ok(!xml.includes("2.16.840.1.113883.4.738"), "must not claim a published identity it cannot verify");
  assert.equal(xmlProblem(xml), null);
});

test("QRDA I: a MISSING artifact degrades instead of crashing (Codex, #360)", () => {
  const orphan = { ...outcome("COMPLIANT", officialEvidence(true)), measureId: "cms999" } as OutcomeRecord;
  const xml = buildQrda1Document(run, "cms999", orphan, bundle);
  assert.match(xml, /<id root="urn:workwell:measure" extension="cms999:official:1\.0\.000"\/>/);
  assert.equal(xmlProblem(xml), null);
});

test("QRDA I: the reporting period is the RUN's measurement period", () => {
  const xml = buildQrda1Document(run, "cms125", outcome("COMPLIANT"), bundle);
  assert.match(xml, /<low value="20250101\d{6}"\/>/);
  assert.match(xml, /<high value="20251231\d{6}"\/>/);
});

test("QRDA I: XML special characters in a subject id cannot break the document", () => {
  const nasty = { ...outcome("COMPLIANT"), subjectId: 'emp<&"006' } as OutcomeRecord;
  const xml = buildQrda1Document(run, "cms125", nasty, bundle);
  assert.equal(xmlProblem(xml), null, "escaping must hold for hostile input");
  assert.ok(!xml.includes('emp<&"006'), "raw special characters must not reach the document");
});

test("QRDA I: one document per subject, and `conformant` reports which are actually conformant", () => {
  // A subject whose bundle cannot be resolved still gets a document — omitting it would read as "not in
  // this run", which is a different and worse claim than "we could not export this subject's data".
  const bundles: Record<string, unknown> = { "emp-006": bundle };
  const docs = buildQrda1Documents(
    run,
    "cms125",
    [
      outcome("COMPLIANT", officialEvidence(true)),
      { ...outcome("OVERDUE", officialEvidence(false)), id: "o2", subjectId: "emp-007" } as OutcomeRecord,
    ],
    (subjectId) => bundles[subjectId],
  );
  assert.deepEqual(docs.map((d) => d.subjectId), ["emp-006", "emp-007"]);
  assert.deepEqual(docs.map((d) => d.conformant), [true, false]);
  assert.match(docs[1]!.nonConformanceReasons[0]!, /CONF:67-14567/);
  for (const d of docs) assert.equal(xmlProblem(d.xml), null, `${d.subjectId} must be well-formed`);
  assert.notEqual(docs[0]!.xml, docs[1]!.xml, "documents must differ by subject");
});

test("QRDA I: a bundle that maps to NO QDM entries is not reported as conformant", () => {
  // The flag tracks entries, not the mere presence of a bundle: a bundle of nothing-we-map still leaves
  // the Patient Data section empty, and CONF:67-14567 does not care why.
  const empty = { resourceType: "Bundle", type: "collection", entry: [{ resource: { resourceType: "Patient", id: "emp-006" } }] };
  const [doc] = buildQrda1Documents(run, "cms125", [outcome("COMPLIANT", officialEvidence(true))], () => empty);
  assert.equal(doc!.conformant, false);
  assert.match(doc!.xml, /EMPTY/);
});

test("QRDA I: a Patient-only fallback reports the source retrieval failure distinctly", () => {
  const degraded = {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { resource: { resourceType: "Patient", id: "emp-006" } },
      {
        resource: {
          resourceType: "OperationOutcome",
          issue: [{ severity: "warning", code: "processing", diagnostics: "WebChart request failed: 403 Forbidden" }],
        },
      },
    ],
  };
  const [doc] = buildQrda1Documents(run, "cms125", [outcome("COMPLIANT", officialEvidence(true))], () => degraded);
  assert.equal(doc!.conformant, false);
  assert.equal(doc!.nonConformanceReasons.length, 1);
  assert.match(doc!.nonConformanceReasons[0]!, /subject data could not be retrieved from the source system/);
  assert.match(doc!.nonConformanceReasons[0]!, /WebChart request failed: 403 Forbidden/);
  assert.doesNotMatch(doc!.nonConformanceReasons[0]!, /no QDM patient data entries/);
});

test("QRDA I: an AUTHORED measure is non-conformant BECAUSE it has no published identity (CONF:67-12811)", () => {
  // An eMeasure Reference QDM SHALL name the measure by its published eMeasure Identifier root. An
  // authored measure has none — it was never published — and ADR-046 decision 3 forbids inventing one.
  // So the document falls back to WorkWell's urn and SAYS why, rather than minting a plausible UUID.
  // This is the correct outcome, not a defect: QRDA I is a format for reporting PUBLISHED eCQMs.
  const [doc] = buildQrda1Documents(run, "cms125", [outcome("COMPLIANT")], () => bundle);
  assert.equal(doc!.conformant, false, "patient data alone is not enough");
  assert.equal(doc!.nonConformanceReasons.length, 1, "the ONLY problem is the identity");
  assert.match(doc!.nonConformanceReasons[0]!, /CONF:67-12811/);
  assert.match(doc!.xml, /NOT CONFORMANT: measure cms125 was evaluated from WorkWell-authored logic/);
  assert.equal(xmlProblem(doc!.xml), null);
});

test("QRDA I: an OFFICIAL outcome with patient data has NO non-conformance reasons", () => {
  const [doc] = buildQrda1Documents(run, "cms125", [outcome("COMPLIANT", officialEvidence(true))], () => bundle);
  assert.deepEqual(doc!.nonConformanceReasons, []);
  assert.ok(!doc!.xml.includes("NOT CONFORMANT"), "a conformant document makes no such claim");
});

test("QRDA I: the patient NAME comes from the FHIR Patient, not from an identifier (Codex, #361)", () => {
  // `employeeById` only knows the synthetic catalog, so a live WebChart subject persisted as `wc|123`
  // used to fall back to the id itself — putting an identifier into a CDA name field and misdescribing
  // the patient in every live export.
  const live = { ...outcome("COMPLIANT", officialEvidence(true)), subjectId: "wc|123" } as OutcomeRecord;
  const named = {
    ...bundle,
    entry: [{ resource: { resourceType: "Patient", id: "123", gender: "female", name: [{ given: ["Ada"], family: "Lovelace" }] } }, bundle.entry[1]!],
  };
  const xml = buildQrda1Document(run, "cms125", live, named);
  assert.match(xml, /<given>Ada<\/given>\s*<family>Lovelace<\/family>/);
  assert.ok(!xml.includes("<given>wc|123</given>"), "an identifier must never be used as a name");
});

test("QRDA I: the BUNDLE's birth date wins over the synthetic catalog's", () => {
  // The bundle is the record the measure was computed from; the catalog is a directory.
  const withDob = { ...bundle, entry: [{ resource: { resourceType: "Patient", id: "emp-006", gender: "female", birthDate: "1966-02-03" } }] };
  assert.match(buildQrda1Document(run, "cms125", outcome("COMPLIANT"), withDob), /<birthTime value="19660203"\/>/);
});

test("QRDA I: a roster-eligible measure carries a CAVEAT, and a caveat is NOT a conformance failure", () => {
  // The run evaluated `stampEnrollment(bundle, …)`, which overlays roster-derived enrollment evidence —
  // for cms125 a SYNTHESIZED qualifying Encounter (ADR-042). Reapplying it here would assert a clinical
  // encounter that did not happen (ADR-037), so the document omits it and NAMES the omission. That is a
  // recalculation-fidelity limitation, not a structural defect, so the two are separate fields: folding
  // them together would mark every live cms125 document non-conformant for something no validator raises.
  const [doc] = buildQrda1Documents(run, "cms125", [outcome("COMPLIANT", officialEvidence(true))], () => bundle);
  assert.equal(doc!.conformant, true, "structurally conformant");
  assert.deepEqual(doc!.nonConformanceReasons, []);
  assert.equal(doc!.caveats.length, 1);
  assert.match(doc!.caveats[0]!, /SYNTHESIZED qualifying Encounter/);
  assert.match(doc!.xml, /OMITTED: cms125 is roster-eligible/, "and the document says so");
});

test("QRDA I: the bundle index resolves the id the PIPELINE actually persists (review + Codex, #361)", () => {
  // The bug this pins: a live run stores `subjectId` as the roster external id, while the bundle carries
  // the bare `Patient.id`. Keying on one form made every live lookup miss — on the only path meant to
  // produce conformant documents. Asserting against the REAL `profileForId` rather than a hand-written
  // `"wc|" + id` is the point: if the pipeline's id scheme changes, this fails instead of the export
  // silently going empty again.
  const live = { resourceType: "Bundle", type: "collection", entry: [{ resource: { resourceType: "Patient", id: "123" } }] };
  const persistedSubjectId = profileForId("wc|123")!.externalId;
  const lookup = indexBundlesBySubject([live], (b) => subjectIdOf(b as never));
  assert.equal(lookup(persistedSubjectId), live, `the pipeline persists "${persistedSubjectId}"`);
  assert.equal(lookup("123"), live, "and the bare Patient.id still resolves, for non-live sources");
  assert.equal(lookup("nobody"), undefined);
});

test("QRDA I: the bundle index skips bundles with no Patient rather than throwing", () => {
  const lookup = indexBundlesBySubject([{ entry: [] }, null, undefined], (b) => subjectIdOf(b as never));
  assert.equal(lookup("anything"), undefined);
});

test("QRDA I: a measure that is NOT roster-eligible carries no such caveat", () => {
  // cms122 is deliberately outside ROSTER_ELIGIBLE_MEASURES — its "enrollment" is a diabetes diagnosis
  // the roster must never fabricate — so nothing is omitted and nothing is claimed.
  const cms122 = { ...outcome("OVERDUE", officialEvidence(true)), measureId: "cms122" } as OutcomeRecord;
  const [doc] = buildQrda1Documents(run, "cms122", [cms122], () => bundle);
  assert.deepEqual(doc!.caveats, []);
  assert.ok(!doc!.xml.includes("OMITTED:"));
});
