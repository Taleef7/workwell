/**
 * FHIR R4 → QDM CDA entry mapping (M-B / ADR-050).
 *
 * Every structural assertion here cites the CONF number it stands for. Those numbers came from running
 * the published CMS RY2026 QRDA I Schematron over a real export — see `scripts/qrda-schematron-check.py`,
 * which is how to re-derive them when the IG moves. Asserting them in TypeScript is what keeps them true
 * in CI, where Python and lxml are deliberately not available.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { qdmEntriesFor } from "./qdm-entries.ts";

const bundleOf = (...resources: unknown[]) => ({
  resourceType: "Bundle",
  type: "collection",
  entry: resources.map((resource) => ({ resource })),
});

const encounter = {
  resourceType: "Encounter",
  id: "enc-1",
  type: [{ coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "99213", display: "Office visit" }] }],
  period: { start: "2025-04-02T09:00:00Z", end: "2025-04-02T09:30:00Z" },
};
const condition = {
  resourceType: "Condition",
  id: "cond-1",
  code: { coding: [{ system: "http://snomed.info/sct", code: "44054006", display: "Type 2 diabetes" }] },
  onsetDateTime: "2019-01-01T00:00:00Z",
};
const hba1c = {
  resourceType: "Observation",
  id: "obs-lab",
  category: [{ coding: [{ code: "laboratory" }] }],
  code: { coding: [{ system: "http://loinc.org", code: "4548-4", display: "HbA1c" }] },
  effectiveDateTime: "2025-06-01T10:00:00Z",
  valueQuantity: { value: 8.2, unit: "%" },
};
const mammogram = {
  resourceType: "Observation",
  id: "obs-img",
  category: [{ coding: [{ code: "imaging" }] }],
  code: { coding: [{ system: "http://loinc.org", code: "24606-6", display: "MG Breast Screening" }] },
  effectiveDateTime: "2025-05-10T10:00:00Z",
};
const procedure = {
  resourceType: "Procedure",
  id: "proc-1",
  code: { coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "77067", display: "Screening mammography" }] },
  performedDateTime: "2025-05-10T10:00:00Z",
};

test("QDM: an Encounter becomes Encounter, Performed with BOTH template ids", () => {
  const [entry] = qdmEntriesFor(bundleOf(encounter));
  assert.ok(entry?.includes('<templateId root="2.16.840.1.113883.10.20.22.4.49" extension="2015-08-01"/>'));
  assert.ok(entry?.includes('<templateId root="2.16.840.1.113883.10.20.24.3.23" extension="2021-08-01"/>'));
  assert.match(entry!, /<code code="99213" codeSystem="2\.16\.840\.1\.113883\.6\.12" codeSystemName="CPT"/);
  assert.match(entry!, /<low value="20250402090000"\/>[\s\S]*<high value="20250402093000"\/>/);
});

test("QDM: a Condition is WRAPPED in a Diagnosis Concern Act (CONF:4509-28885)", () => {
  // A bare Diagnosis observation is what this exporter emitted first and the Schematron rejected:
  // "This template SHALL be contained by a Diagnosis Concern Act (V5)".
  const [entry] = qdmEntriesFor(bundleOf(condition));
  assert.ok(entry?.includes('<templateId root="2.16.840.1.113883.10.20.24.3.137" extension="2021-08-01"/>'), "concern act");
  assert.ok(entry?.includes('<code code="CONC" codeSystem="2.16.840.1.113883.5.6"'), "the act is a Concern");
  assert.ok(entry?.includes('<entryRelationship typeCode="SUBJ">'), "the diagnosis is the act's subject");
  assert.ok(entry?.includes('<templateId root="2.16.840.1.113883.10.20.24.3.135" extension="2021-08-01"/>'), "diagnosis");
  // The patient's actual condition is the VALUE; the code says only "this is a diagnosis".
  assert.match(entry!, /<value xsi:type="CD" code="44054006"/);
});

test("QDM: the Diagnosis code carries exactly one translation (CONF:4509-28886)", () => {
  const [entry] = qdmEntriesFor(bundleOf(condition));
  const translations = entry!.match(/<translation /g) ?? [];
  assert.equal(translations.length, 1, "exactly one — not zero, and not one per coding");
  assert.ok(entry!.includes('<translation code="282291009" codeSystem="2.16.840.1.113883.6.96"'));
});

test("QDM: a LABORATORY Observation becomes Laboratory Test, Performed with a nested Result", () => {
  const [entry] = qdmEntriesFor(bundleOf(hba1c));
  assert.ok(entry?.includes('<templateId root="2.16.840.1.113883.10.20.24.3.38" extension="2021-08-01"/>'));
  // The result lives in the nested Result observation. A measure reading `[Observation: "HbA1c"] where
  // value > 9` reads THIS, so dropping it would make an exported HbA1c invisible to CMS122.
  assert.ok(entry?.includes('<templateId root="2.16.840.1.113883.10.20.24.3.87" extension="2019-12-01"/>'));
  assert.match(entry!, /<value xsi:type="PQ" value="8\.2" unit="%"\/>/);
});

test("QDM: an IMAGING Observation becomes Diagnostic Study, Performed with an outer value (CONF:4509-29332)", () => {
  // A screening mammogram has no result value, and the template still SHALL carry one. `nullFlavor="NA"`
  // is the IG's own idiom — the CMS sample file uses it on this very template.
  const [entry] = qdmEntriesFor(bundleOf(mammogram));
  assert.ok(entry?.includes('<templateId root="2.16.840.1.113883.10.20.24.3.18" extension="2021-08-01"/>'));
  assert.ok(entry?.includes('<templateId root="2.16.840.1.113883.10.20.22.4.13" extension="2014-06-09"/>'));
  assert.ok(entry?.includes('<value xsi:type="CD" nullFlavor="NA"/>'), "a study with no coded result still has a value");
});

test("QDM: lab vs imaging is decided by CATEGORY — the same discriminator the official numerator uses", () => {
  // CMS125's official numerator is `isDiagnosticStudyPerformed([Observation: "Mammography"])`, which
  // requires `category ~ imaging` (ADR-044). Routing on anything else would put a mammogram in the
  // template its own measure does not retrieve.
  const asLab = { ...mammogram, category: [{ coding: [{ code: "laboratory" }] }] };
  assert.ok(qdmEntriesFor(bundleOf(asLab))[0]?.includes("24.3.38"), "category decides, not the LOINC code");
  assert.ok(qdmEntriesFor(bundleOf(mammogram))[0]?.includes("24.3.18"));
});

test("QDM: an Observation with NO category is SKIPPED, not guessed into a datatype", () => {
  // Absent is visible; wrong-datatype is not. Guessing is how a mammogram becomes invisible to the
  // numerator that retrieves the other template.
  const uncategorised = { ...mammogram, category: undefined };
  assert.deepEqual(qdmEntriesFor(bundleOf(uncategorised)), []);
});

test("QDM: a Procedure becomes Procedure, Performed", () => {
  const [entry] = qdmEntriesFor(bundleOf(procedure));
  assert.ok(entry?.includes('<templateId root="2.16.840.1.113883.10.20.24.3.64" extension="2021-08-01"/>'));
  assert.ok(entry?.includes('<templateId root="2.16.840.1.113883.10.20.22.4.14" extension="2014-06-09"/>'));
  assert.match(entry!, /<effectiveTime value="20250510100000"\/>/);
});

test("QDM: a resource whose code system we cannot map is SKIPPED rather than mis-stamped", () => {
  // Emitting a code under the wrong codeSystem OID is worse than omitting it: a receiver would resolve
  // it to a different concept entirely.
  const unknownSystem = { ...procedure, code: { coding: [{ system: "http://example.org/local", code: "X1" }] } };
  assert.deepEqual(qdmEntriesFor(bundleOf(unknownSystem)), []);
});

test("QDM: resource types no measure of ours reads are silently skipped", () => {
  const entries = qdmEntriesFor(bundleOf({ resourceType: "Patient", id: "p" }, { resourceType: "Coverage", id: "c" }, encounter));
  assert.equal(entries.length, 1, "only the Encounter maps");
});

test("QDM: a Condition with no onset says UNK rather than inventing a date", () => {
  // ADR-038 recorded that Conditions with no onsetDateTime are handled INCONSISTENTLY by
  // `prevalenceInterval` — not merely conservatively. Saying "no information" keeps the diagnosis in
  // the document without asserting when it started.
  const [entry] = qdmEntriesFor(bundleOf({ ...condition, onsetDateTime: undefined }));
  assert.ok(entry?.includes('<effectiveTime nullFlavor="UNK"/>'), "the diagnosis is present, its interval is not");
  assert.match(entry!, /<value xsi:type="CD" code="44054006"/, "and the condition itself survives");
});

test("QDM: an unresolved interval ends with nullFlavor NA, not an omitted high", () => {
  // Omitting `high` asserts nothing about whether the interval is open; `nullFlavor="NA"` says it has
  // not ended, which is what an active diagnosis means.
  const [entry] = qdmEntriesFor(bundleOf(condition));
  assert.ok(entry?.includes('<high nullFlavor="NA"/>'));
  const resolved = qdmEntriesFor(bundleOf({ ...condition, abatementDateTime: "2024-01-01T00:00:00Z" }));
  assert.ok(resolved[0]?.includes('<high value="20240101000000"/>'));
});

test("QDM: entry ids come from the FHIR resource, so two exports of one bundle agree", () => {
  const first = qdmEntriesFor(bundleOf(encounter, condition, hba1c));
  const second = qdmEntriesFor(bundleOf(encounter, condition, hba1c));
  assert.deepEqual(first, second, "the mapping is a pure function of the bundle");
  assert.ok(first[0]!.includes('extension="enc-1"'), "keyed on the FHIR id, not a fresh uuid");
});

test("QDM: entries preserve BUNDLE order", () => {
  // Resource order is the bundle's order, so a diff between two exports means the DATA moved.
  const entries = qdmEntriesFor(bundleOf(procedure, encounter, condition));
  assert.ok(entries[0]!.includes("24.3.64"), "procedure first");
  assert.ok(entries[1]!.includes("24.3.23"), "encounter second");
  assert.ok(entries[2]!.includes("24.3.137"), "diagnosis third");
});

test("QDM: a RETRACTED or did-not-happen record never becomes a *Performed* entry (Codex, #361)", () => {
  // Every entry this module emits carries `statusCode="completed"`, which asserts the event occurred.
  // An entered-in-error mammogram translated into `Procedure, Performed` could satisfy a recalculated
  // numerator off a record WorkWell's own evaluation excludes.
  for (const status of ["entered-in-error", "not-done", "cancelled"]) {
    assert.deepEqual(qdmEntriesFor(bundleOf({ ...procedure, status })), [], `Procedure ${status}`);
    assert.deepEqual(qdmEntriesFor(bundleOf({ ...mammogram, status })), [], `Observation ${status}`);
    assert.deepEqual(qdmEntriesFor(bundleOf({ ...condition, status })), [], `Condition ${status}`);
  }
});

test("QDM: an ambiguous or absent status is ADMITTED — the filter is a denylist on purpose", () => {
  // Measured on real WebChart data (teatea): genuine clinical rows arrive `status: "unknown"`. An
  // allowlist of `final`/`completed` would silently drop them and make a receiver recalculate LOW,
  // which is as wrong as admitting a retracted row and far more common.
  for (const status of ["unknown", "final", "completed", undefined]) {
    assert.equal(qdmEntriesFor(bundleOf({ ...procedure, status })).length, 1, `Procedure ${status}`);
  }
});

test("QDM: a junk bundle yields no entries instead of throwing", () => {
  for (const junk of [undefined, null, {}, { entry: null }, { entry: [null, {}, { resource: {} }] }]) {
    assert.deepEqual(qdmEntriesFor(junk), [], `${JSON.stringify(junk)}`);
  }
});
