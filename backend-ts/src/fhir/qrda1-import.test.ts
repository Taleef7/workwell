/**
 * QRDA Category I import — the (c)(2) "import and calculate" half (M-B).
 *
 * The centrepiece is the **round trip**: export a FHIR bundle to a QRDA I document, import it back, and
 * require the clinically load-bearing fields to survive. Both halves are ours, so this proves they are
 * consistent — it does NOT prove our reading of the IG is right. Only Cypress CVU+ can, and it has not
 * run. The second-strongest check here is the CMS sample file, which we did not write.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildQrda1Document, buildQrda1Documents } from "./qrda1-export.ts";
import { translateQdm } from "./qdm-entries.ts";
import { importQrda1Document, Qrda1ImportError, SYSTEM_FOR_OID } from "./qrda1-import.ts";
import { parseXml, decodeEntities, child, descendants, hasTemplate } from "./cda-parse.ts";
import { resolveQrda1Documents } from "./qrda1-identity.ts";
import type { RunRecord } from "../stores/run-store.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";

const run = {
  id: "run-rt",
  measurementPeriodStart: "2025-01-01T00:00:00.000Z",
  measurementPeriodEnd: "2025-12-31T00:00:00.000Z",
} as RunRecord;

const outcome = (official?: Record<string, unknown>): OutcomeRecord =>
  ({
    id: "o1", runId: run.id, subjectId: "emp-006", measureId: "cms125",
    evaluationPeriod: "2025-12-31", status: "COMPLIANT",
    evidence: official ? { official } : {},
    evaluatedAt: "2025-12-31T00:00:00.000Z",
  }) as OutcomeRecord;

const officialEvidence = {
  ecqmId: "CMS125FHIR", version: "1.0.000", engine: "fqm-execution", populationResults: [],
};

/** A bundle exercising every datatype the pair maps. */
const sourceBundle = {
  resourceType: "Bundle",
  type: "collection",
  entry: [
    { resource: { resourceType: "Patient", id: "emp-006", gender: "female", birthDate: "1975-03-12", name: [{ given: ["Ada"], family: "Lovelace" }] } },
    {
      resource: {
        resourceType: "Encounter", id: "enc-1", status: "finished",
        type: [{ coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "99213", display: "Office visit" }] }],
        period: { start: "2025-04-02T09:00:00Z", end: "2025-04-02T09:30:00Z" },
      },
    },
    {
      resource: {
        resourceType: "Condition", id: "cond-1",
        code: { coding: [{ system: "http://snomed.info/sct", code: "44054006", display: "Type 2 diabetes" }] },
        onsetDateTime: "2019-01-01T00:00:00Z",
      },
    },
    {
      resource: {
        resourceType: "Observation", id: "obs-lab", status: "final",
        category: [{ coding: [{ code: "laboratory" }] }],
        code: { coding: [{ system: "http://loinc.org", code: "4548-4", display: "HbA1c" }] },
        effectiveDateTime: "2025-06-01T10:00:00Z", valueQuantity: { value: 8.2, unit: "%" },
      },
    },
    {
      resource: {
        resourceType: "Observation", id: "obs-img", status: "final",
        category: [{ coding: [{ code: "imaging" }] }],
        code: { coding: [{ system: "http://loinc.org", code: "24606-6", display: "MG Breast Screening" }] },
        effectiveDateTime: "2025-05-10T10:00:00Z",
      },
    },
    {
      resource: {
        resourceType: "Procedure", id: "proc-1", status: "completed",
        code: { coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "77067" }] },
        performedDateTime: "2025-05-10T10:00:00Z",
      },
    },
  ],
};

const roundTrip = () =>
  importQrda1Document(buildQrda1Document(run, "cms125", outcome(officialEvidence), sourceBundle));

const byType = (imported: ReturnType<typeof roundTrip>, type: string) =>
  imported.bundle.entry.map((e) => e.resource as Record<string, unknown>).filter((r) => r.resourceType === type);

// ---------------------------------------------------------------- the XML reader

test("CDA parse: nesting, attributes, self-closing elements and text", () => {
  const root = parseXml(`<a x="1"><b y="2"/><c>hello <d/>world</c></a>`)!;
  assert.equal(root.local, "a");
  assert.equal(root.attrs.x, "1");
  assert.equal(root.children.length, 2);
  assert.equal(child(root, "b")?.attrs.y, "2");
  assert.equal(child(root, "c")?.text, "hello world");
});

test("CDA parse: a namespace PREFIX does not hide an element", () => {
  // CDA appears in the wild both as `<ClinicalDocument xmlns="urn:hl7-org:v3">` and `<cda:ClinicalDocument>`.
  const root = parseXml(`<cda:ClinicalDocument xmlns:cda="urn:hl7-org:v3"><cda:section/></cda:ClinicalDocument>`)!;
  assert.equal(root.local, "ClinicalDocument");
  assert.equal(root.name, "cda:ClinicalDocument");
  assert.equal(descendants(root, "section").length, 1);
});

test("CDA parse: only the five predefined entities and numeric refs are decoded", () => {
  // There is no entity table to grow, so the billion-laughs class does not exist here.
  assert.equal(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;"), `a & b <c> "d" 'e'`);
  assert.equal(decodeEntities("&#65;&#x42;"), "AB");
  assert.equal(decodeEntities("&lol1;"), "&lol1;", "an undeclared entity stays literal");
});

test("CDA parse: comments, CDATA, PIs and DOCTYPE do not corrupt the tree", () => {
  const root = parseXml(`<?xml version="1.0"?><!DOCTYPE a><a><!-- <b/> --><c><![CDATA[raw <not> markup]]></c></a>`)!;
  assert.equal(root.local, "a");
  assert.equal(descendants(root, "b").length, 0, "a commented-out element is not parsed");
  assert.equal(child(root, "c")?.text, "raw <not> markup");
});

test("CDA parse: malformed input returns what it read instead of throwing", () => {
  for (const junk of ["", "not xml at all", "<a><b></a>", "<a", "<a>&", "</closing-only>"]) {
    assert.doesNotThrow(() => parseXml(junk), junk);
  }
  assert.equal(parseXml("")?.local, undefined);
  // A stray close tag is ignored rather than unwinding the stack past its parent.
  assert.equal(parseXml("<a><b></c></b></a>")!.local, "a");
});

test("CDA parse: hasTemplate matches root, and extension only when asked", () => {
  const node = parseXml(`<s><templateId root="1.2.3" extension="2021-08-01"/></s>`)!;
  assert.ok(hasTemplate(node, "1.2.3"));
  assert.ok(hasTemplate(node, "1.2.3", "2021-08-01"));
  assert.ok(!hasTemplate(node, "1.2.3", "2015-08-01"));
  assert.ok(!hasTemplate(node, "9.9.9"));
});

// ---------------------------------------------------------------- the round trip

test("round trip: the subject survives, sex included", () => {
  const imported = roundTrip();
  assert.equal(imported.patientId, "emp-006");
  const [patient] = byType(imported, "Patient");
  // Sex is load-bearing: it is one of CMS125's three IPP conjuncts, and ADR-042 cost a measurement pass
  // discovering that an extension carrying "F" is indistinguishable from one that is absent.
  assert.equal(patient!.gender, "female");
  assert.equal(patient!.birthDate, "1975-03-12");
});

test("round trip: every mapped datatype comes back with its code and system", () => {
  const imported = roundTrip();
  const code = (r: Record<string, unknown>) => (r.code as { coding: Array<{ system: string; code: string }> }).coding[0]!;
  assert.deepEqual(code(byType(imported, "Condition")[0]!), { system: "http://snomed.info/sct", code: "44054006", display: "Type 2 diabetes" } as never);
  assert.deepEqual(code(byType(imported, "Procedure")[0]!), { system: "http://www.ama-assn.org/go/cpt", code: "77067" } as never);
  const [encounter] = byType(imported, "Encounter");
  assert.equal((encounter!.type as Array<{ coding: Array<{ code: string }> }>)[0]!.coding[0]!.code, "99213");
});

test("round trip: an Observation keeps the CATEGORY that decides its QDM datatype", () => {
  // Lab vs imaging is the discriminator CMS125's official numerator turns on
  // (`isDiagnosticStudyPerformed` requires `category ~ imaging`, ADR-044). Losing it on import would
  // recreate the exact false-OVERDUE that ADR-044 closed.
  const cat = (r: Record<string, unknown>) => (r.category as Array<{ coding: Array<{ code: string }> }>)[0]!.coding[0]!.code;
  const observations = byType(roundTrip(), "Observation");
  assert.equal(observations.length, 2);
  assert.deepEqual(observations.map(cat).sort(), ["imaging", "laboratory"]);
});

test("round trip: a laboratory RESULT VALUE survives — a measure reads it, not just the code", () => {
  // CMS122's numerator is `HbA1c > 9`. A round trip that kept the code and dropped the value would
  // reimport an HbA1c the measure cannot act on.
  const lab = byType(roundTrip(), "Observation").find((o) => (o.category as Array<{ coding: Array<{ code: string }> }>)[0]!.coding[0]!.code === "laboratory")!;
  assert.deepEqual(lab.valueQuantity, { value: 8.2, unit: "%" });
});

test("round trip: dates survive, as instants or intervals per the source", () => {
  const imported = roundTrip();
  assert.equal((byType(imported, "Procedure")[0]!.performedDateTime as string), "2025-05-10T10:00:00Z");
  assert.equal((byType(imported, "Condition")[0]!.onsetDateTime as string), "2019-01-01T00:00:00Z");
  const period = byType(imported, "Encounter")[0]!.period as { start: string; end: string };
  assert.equal(period.start, "2025-04-02T09:00:00Z");
  assert.equal(period.end, "2025-04-02T09:30:00Z");
});

test("round trip: an imported Condition is CONFIRMED, so the export's own retraction filter passes it", () => {
  // The export drops a Condition whose `verificationStatus` is entered-in-error. If the import left that
  // element absent, a re-export would still work — but stating it makes the pair idempotent rather than
  // accidentally so.
  const status = byType(roundTrip(), "Condition")[0]!.verificationStatus as { coding: Array<{ code: string }> };
  assert.equal(status.coding[0]!.code, "confirmed");
});

test("round trip: BOTH published measure identities come back — version-specific and setId", () => {
  // `<setId>` is the version-INDEPENDENT eMeasure id. Reading only `<id>` meant a document naming its
  // measure that way alone matched nothing, and the route's measure check would refuse a correct
  // request (review, #362).
  const imported = roundTrip();
  assert.equal(imported.measureIdentifiers.length, 2);
  for (const id of imported.measureIdentifiers) assert.match(id, /^[0-9a-f-]{36}$/);
  assert.notEqual(imported.measureIdentifiers[0], imported.measureIdentifiers[1], "distinct identities");
  assert.equal(imported.localMeasureId, undefined, "an official document carries no WorkWell urn");
});

test("round trip: an AUTHORED document reports WorkWell's local id instead", () => {
  const imported = importQrda1Document(buildQrda1Document(run, "cms125", outcome(), sourceBundle));
  assert.deepEqual(imported.measureIdentifiers, []);
  assert.equal(imported.localMeasureId, "cms125");
});

test("round trip: nothing is silently dropped — untranslatedTemplates is empty", () => {
  assert.deepEqual(roundTrip().untranslatedTemplates, []);
});

// ---------------------------------------------------------------- refusals

test("import REFUSES a document that is not a QRDA Category I", () => {
  // Returning an empty bundle instead would evaluate to out-of-population for every measure —
  // indistinguishable from a genuinely ineligible patient, the hazard ADR-043 exists for.
  assert.throws(() => importQrda1Document("<html><body>not cda</body></html>"), Qrda1ImportError);
  assert.throws(() => importQrda1Document(""), Qrda1ImportError);
  assert.throws(
    () => importQrda1Document(`<ClinicalDocument xmlns="urn:hl7-org:v3"><component/></ClinicalDocument>`),
    /no Patient Data Section/,
  );
});

test("import REFUSES our own no-bundle export, which is the non-conformant state we mark", () => {
  // The exporter emits a Patient Data section with no entries and SAYS it is not conformant
  // (CONF:67-14567). Accepting it would produce a Patient-only bundle, which evaluates
  // out-of-population for every measure — laundering a document that declares itself uncalculable
  // into a plausible-looking result. The first version of this test asserted the hollow bundle came
  // back rather than that it was refused: the name said REFUSES and the assertion did not (Codex, #362).
  const hollow = buildQrda1Document(run, "cms125", outcome(officialEvidence));
  assert.throws(() => importQrda1Document(hollow), /no Patient Data entries \(CONF:67-14567\)/);
});

test("import REFUSES a document whose every entry is a datatype we cannot translate", () => {
  // Same Patient-only outcome, different cause — and the message says which, because "we dropped
  // everything" and "there was nothing" call for different operator responses.
  // Patient Characteristic Payer, deliberately: it is supplemental data, it appears in EVERY Cypress
  // document, and it is genuinely untranslated. This fixture used a bare Medication, Active until #387
  // taught the importer to read that datatype — at which point the test still passed, for the wrong
  // reason (an entry carrying no drug code), while its name claimed something no longer true.
  const onlyPayer = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole><id root="urn:workwell:employee" extension="emp-006"/></patientRole></recordTarget>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.24.2.1" extension="2021-08-01"/>
    <entry typeCode="DRIV">
      <observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.24.3.55"/>
        <code code="48768-6" codeSystem="2.16.840.1.113883.6.1"/>
      </observation>
    </entry>
  </section></component></structuredBody></component>
</ClinicalDocument>`;
  assert.throws(() => importQrda1Document(onlyPayer), /no entry this importer can translate/);
  assert.throws(() => importQrda1Document(onlyPayer), /2\.16\.840\.1\.113883\.10\.20\.24\.3\.55/);
});

test("import KEEPS an HL7 TIMEZONE OFFSET as stated, neither discarding it (Codex, #362) nor converting to UTC (#788)", () => {
  // `20251231230000-0500` is 23:00 on 31 December in its own offset, and 04:00 on 1 January in UTC. Dropping
  // the offset moves the instant; converting to UTC moves the day and the year, which CMS's FHIR logic can
  // read in the value's own offset. Base HL7 asks for the offset (CONF:81-10130) even though the CMS
  // Hospital IG asks for its absence (CMS_0121), so a conformant document may well carry one.
  // Target the PROCEDURE's own timestamp: `.replace` with a string hits only the first match, and the
  // imaging Observation shares that instant in the shared fixture.
  const doc = buildQrda1Document(run, "cms125", outcome(officialEvidence), {
    ...sourceBundle,
    entry: [sourceBundle.entry[0]!, sourceBundle.entry[5]!],
  }).replace('value="20250510100000"', 'value="20251231230000-0500"');
  const imported = importQrda1Document(doc);
  const procedure = imported.bundle.entry.map((e) => e.resource as Record<string, unknown>).find((r) => r.resourceType === "Procedure")!;
  assert.equal(procedure.performedDateTime, "2025-12-31T23:00:00-05:00");
});

test("#788: an offset beyond ±14:00 is no zone FHIR can state, so it is no timestamp; ±14:00 is", () => {
  const timed = (value: string) =>
    importedOfType(sitedDocument(sitedProcedure("").replace('value="20240405083000"', `value="${value}"`)), "Procedure")[0]!.performedDateTime;
  assert.equal(timed("20240405083000+1400"), "2024-04-05T08:30:00+14:00");
  assert.equal(timed("20240405083000-1400"), "2024-04-05T08:30:00-14:00");
  assert.equal(timed("20240405083000+1401"), undefined);
  assert.equal(timed("20240405083000-1500"), undefined);
  assert.equal(timed("20240405083000"), "2024-04-05T08:30:00Z", "no offset is read as UTC, as before");
  // A reading whose time cannot be placed could be any time, so it keeps a pair from forming (§4A.8).
  const beyond = sys({ id: "s2", time: "<effectiveTime value='20250601120000+1500'/>" });
  assert.equal(paired(sys(), dia(), beyond).panels.length, 0, "a systolic at +1500 is no placeable time");
  assert.equal(paired(sys(), dia()).panels.length, 1);
});

test("import keeps an Observation INTERVAL as a period, not an instant (Codex, #362)", () => {
  // A lab or study whose relevant period OVERLAPS a measurement window is exactly the case temporal
  // CQL predicates turn on; collapsing to the start silently drops the end.
  const doc = buildQrda1Document(run, "cms125", outcome(officialEvidence), {
    ...sourceBundle,
    entry: [
      sourceBundle.entry[0]!,
      {
        resource: {
          resourceType: "Observation", id: "obs-span", status: "final",
          category: [{ coding: [{ code: "laboratory" }] }],
          code: { coding: [{ system: "http://loinc.org", code: "4548-4" }] },
          effectivePeriod: { start: "2025-06-01T10:00:00Z", end: "2025-06-02T10:00:00Z" },
        },
      },
    ],
  });
  const observation = importQrda1Document(doc).bundle.entry.map((e) => e.resource as Record<string, unknown>).find((r) => r.resourceType === "Observation")!;
  assert.deepEqual(observation.effectivePeriod, { start: "2025-06-01T10:00:00Z", end: "2025-06-02T10:00:00Z" });
  assert.equal(observation.effectiveDateTime, undefined, "an interval must not collapse to an instant");
});

// #794, parser group: what is not XML is refused, and what states nothing is read as nothing.
const lab794 = (o: { id?: string; code?: string; status?: string; times?: string; value?: string; root?: string; resultStatus?: string } = {}) => `<entry><observation classCode="OBS" moodCode="EVN"${o.root ?? ""}>
      <templateId root="2.16.840.1.113883.10.20.24.3.38" extension="2019-12-01"/>
      ${o.id ?? '<id root="1.3.6.1.4.1.115" extension="lab-1"/>'}
      ${o.code ?? '<code code="4548-4" codeSystem="2.16.840.1.113883.6.1"/>'}
      ${o.status ?? '<statusCode code="completed"/>'}
      ${o.times ?? '<effectiveTime value="20250601100000"/>'}
      <entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.24.3.87" extension="2019-12-01"/>
        <code code="4548-4" codeSystem="2.16.840.1.113883.6.1"/>
        ${o.resultStatus ?? '<statusCode code="completed"/>'}
        <effectiveTime value="20250601100000"/>
        ${o.value ?? '<value xsi:type="PQ" value="7.1" unit="%"/>'}
      </observation></entryRelationship>
    </observation></entry>`;
const labsOf = (xml: string) => importQrda1Document(xml).bundle.entry.map((e) => e.resource as Record<string, any>).filter((r) => r.resourceType === "Observation");

test("#794: an attribute stated twice is not XML, and the document is refused, never read with the last value", () => {
  assert.throws(() => importQrda1Document(sitedDocument(lab794({ root: ' negationInd="true" negationInd="false"' }))), /not well-formed XML: <observation> states its attribute 'negationInd' twice/);
  // Twice after resolving a prefix to the XML Schema instance namespace is twice too.
  const twice = sitedDocument(lab794({ value: '<value xsi:type="PQ" s:type="CD" xmlns:s="http://www.w3.org/2001/XMLSchema-instance" value="7.1" unit="%"/>' }));
  assert.throws(() => importQrda1Document(twice), /states its attribute 's:type' twice/);
  // The batch reports such a document and keeps the others.
  const batch = resolveQrda1Documents([sitedDocument(lab794({ root: ' moodCode="EVN"' })), sitedDocument(lab794())]);
  assert.deepEqual([batch.failures.map((f) => f.index), batch.subjects.length], [[0], 1]);
});

test("#794: xsi:type is read by its namespace, whatever prefix the document binds to it", () => {
  const value = (v: string) => labsOf(sitedDocument(lab794({ value: v })))[0]!.valueQuantity;
  assert.deepEqual(value('<value xsi:type="PQ" value="7.1" unit="%"/>'), { value: 7.1, unit: "%" }, "the control");
  assert.deepEqual(value('<value s:type="PQ" xmlns:s="http://www.w3.org/2001/XMLSchema-instance" value="7.1" unit="%"/>'), { value: 7.1, unit: "%" });
  // `xsi:` bound to another namespace is not the schema-instance type.
  assert.equal(value('<value xsi:type="PQ" xmlns:xsi="urn:example:not-xsi" value="7.1" unit="%"/>'), undefined);
});

test("#794: a nullFlavored code or id states none, whatever sits beside it", () => {
  // The primary code is not read; a translation still is (nullFlavor OTH with a translation is CDA's idiom).
  const translated = labsOf(sitedDocument(lab794({ code: '<code nullFlavor="OTH" code="2345-7" codeSystem="2.16.840.1.113883.6.1"><translation code="4548-4" codeSystem="2.16.840.1.113883.6.1"/></code>' })));
  assert.deepEqual(translated[0]!.code.coding.map((c: { code: string }) => c.code), ["4548-4"]);
  // A diagnosis beside it, so the document has something to import.
  assert.deepEqual(labsOf(sitedDocument(lab794({ code: '<code nullFlavor="UNK" code="4548-4" codeSystem="2.16.840.1.113883.6.1"/>' }) + sitedDiagnosis(""))), []);
  // An id with a nullFlavor names nothing: the resource takes a generated id and no identifier.
  const unnamed = labsOf(sitedDocument(lab794({ id: '<id nullFlavor="UNK" root="1.3.6.1.4.1.115" extension="lab-1"/>' })))[0]!;
  assert.deepEqual([unnamed.id === "lab-1", unnamed.identifier], [false, undefined]);
});

test("#794: an entry stating its code, status or time twice is not translated, and is named", () => {
  for (const [field, o] of [
    ["status", { status: '<statusCode code="completed"/><statusCode code="aborted"/>' }],
    ["time", { times: '<effectiveTime value="20250601100000"/><effectiveTime value="20240601100000"/>' }],
    ["code", { code: '<code code="4548-4" codeSystem="2.16.840.1.113883.6.1"/><code code="2345-7" codeSystem="2.16.840.1.113883.6.1"/>' }],
    // A lab is its result: its only Result stating two statuses is no result that happened.
    ["result status", { resultStatus: '<statusCode code="completed"/><statusCode code="active"/>' }],
  ] as const) {
    // A diagnosis beside it, so the document has something to import.
    const imported = importQrda1Document(sitedDocument(lab794(o) + sitedDiagnosis("")));
    assert.deepEqual(imported.bundle.entry.filter((e) => (e.resource as { resourceType: string }).resourceType === "Observation"), [], field);
    assert.ok(imported.untranslatedTemplates.length > 0, field);
  }
  // A medication's schema allows several timings (an interval and a frequency): it is still imported.
  const medication = `<entry><substanceAdministration classCode="SBADM" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.41" extension="2021-08-01"/>
      <id root="1.3.6.1.4.1.115" extension="med-1"/>
      <statusCode code="active"/>
      <effectiveTime xsi:type="IVL_TS"><low value='20230820080000'/><high nullFlavor='UNK'/></effectiveTime>
      <effectiveTime xsi:type="PIVL_TS" institutionSpecified="true" operator="A"><period value="24" unit="h"/></effectiveTime>
      <consumable><manufacturedProduct classCode="MANU">
        <manufacturedMaterial><code code="1100184" codeSystem="2.16.840.1.113883.6.88"/></manufacturedMaterial>
      </manufacturedProduct></consumable>
    </substanceAdministration></entry>`;
  const types = importQrda1Document(sitedDocument(medication)).bundle.entry.map((e) => (e.resource as { resourceType: string }).resourceType);
  assert.ok(types.some((t) => t.startsWith("Medication")), types.join(","));
});

test("#794 (review): a prefix is in scope from its declaration to its element's end, and parsing stays linear", () => {
  const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";
  const valueIn = (entries: string, sectionAttrs = "") => {
    const doc = sitedDocument(entries).replace("<section>", `<section${sectionAttrs}>`);
    return labsOf(doc)[0]!.valueQuantity;
  };
  const lab = (value: string, wrap = (e: string) => e) => wrap(lab794({ value }));
  // Declared on an ancestor.
  assert.deepEqual(valueIn(lab('<value s:type="PQ" value="7.1" unit="%"/>'), ` xmlns:s="${XSI_NS}"`), { value: 7.1, unit: "%" });
  // Redeclared on the entry, for the entry only.
  assert.equal(valueIn(lab('<value s:type="PQ" value="7.1" unit="%"/>').replace("<entry>", '<entry xmlns:s="urn:example:other">'), ` xmlns:s="${XSI_NS}"`), undefined);
  // An element's declaration ends with it: the next entry is in the section's scope again.
  const redeclared = lab('<value s:type="CD" code="x" codeSystem="2.16.840.1.113883.6.1"/>').replace("<entry>", '<entry xmlns:s="urn:example:other">');
  const after = lab794({ id: '<id root="1.3.6.1.4.1.115" extension="lab-2"/>', value: '<value s:type="PQ" value="7.1" unit="%"/>' });
  const labs = labsOf(sitedDocument(redeclared + after).replace("<section>", `<section xmlns:s="${XSI_NS}">`));
  assert.deepEqual(labs.find((r) => r.id === "lab-2")!.valueQuantity, { value: 7.1, unit: "%" });
  // A self-closing element's declaration ends with it.
  assert.deepEqual(valueIn('<x xmlns:s="urn:example:other"/>' + lab('<value s:type="PQ" value="7.1" unit="%"/>'), ` xmlns:s="${XSI_NS}"`), { value: 7.1, unit: "%" });
  // Two prefixes for two namespaces are two attributes, not one stated twice.
  assert.deepEqual(valueIn(lab(`<value xmlns:xsi="urn:example:other" xmlns:s="${XSI_NS}" xsi:type="X" s:type="PQ" value="7.1" unit="%"/>`)), { value: 7.1, unit: "%" });
  // A prefix bound to "" is unbound: `xsi:` is then read as written, as it always was.
  assert.deepEqual(valueIn(lab('<value xmlns:xsi="" xsi:type="PQ" value="7.1" unit="%"/>')), { value: 7.1, unit: "%" });
  // 20,000 nested declarations: linear, where a scope copied onto every element exhausted the heap.
  const depth = 20_000;
  const nested = Array.from({ length: depth }, (_, k) => `<e xmlns:q${k}="urn:example:${k}">`).join("") + "</e>".repeat(depth);
  const started = performance.now();
  assert.ok(parseXml(`<root>${nested}</root>`, []));
  assert.ok(performance.now() - started < 5_000, "parsed in under five seconds");
});

test("#794 (review): §4A.8 counts every time and code a reading writes", () => {
  const third = (o: Partial<Parameters<typeof exam>[0]>) => exam({ id: "s3", code: "8480-6", value: '<value xsi:type="PQ" value="150" unit="mm[Hg]"/>', ...o });
  assert.equal(paired(sys(), dia()).panels.length, 1, "the control");
  // A second time: any time, whichever comes first.
  for (const time of ["<effectiveTime value='20240101120000'/><effectiveTime value='20250219171000'/>", "<effectiveTime value='20250219171000'/><effectiveTime value='20240101120000'/>"]) {
    assert.equal(paired(sys(), dia(), third({ time })).panels.length, 0, time);
  }
  // A lab's bound stated twice is no time for it either.
  const twice = labsOf(sitedDocument(lab794({ times: "<effectiveTime><low value='20250601'/><low value='20250602'/><high value='20250603'/></effectiveTime>" })))[0]!;
  assert.deepEqual([twice.effectiveDateTime, twice.effectivePeriod], [undefined, undefined]);
  // A bound stated twice.
  assert.equal(paired(sys(), dia(), third({ time: "<effectiveTime><low value='20250219171500'/><low value='20250219170000'/><high value='20250219180000'/></effectiveTime>" })).panels.length, 0);
  // A second code still states a systolic.
  assert.equal(paired(sys(), dia(), third({ code: "8310-5" }).replace('<code code="8310-5" codeSystem="2.16.840.1.113883.6.1"/>', '<code code="8310-5" codeSystem="2.16.840.1.113883.6.1"/><code code="8480-6" codeSystem="2.16.840.1.113883.6.1"/>')).panels.length, 0);
  // A nullFlavored code states none, whatever sits beside it (Codex, #804): it neither blocks...
  assert.equal(paired(sys(), dia(), third({}).replace('<code code="8480-6" codeSystem="2.16.840.1.113883.6.1"/>', '<code nullFlavor="UNK" code="8480-6" codeSystem="2.16.840.1.113883.6.1"/>')).panels.length, 1);
  // ...nor makes its translation a second half: a systolic stated only in the translation pairs as one.
  const translated = sys().replace('<code code="8480-6" codeSystem="2.16.840.1.113883.6.1"/>', '<code nullFlavor="OTH" code="8462-4" codeSystem="2.16.840.1.113883.6.1"><translation code="8480-6" codeSystem="2.16.840.1.113883.6.1"/></code>');
  assert.equal(paired(translated, dia()).panels.length, 1);
  // Its codes stating both halves (two codes), it is neither: imported as its first, it does not pair.
  const twoCodes = sys().replace('<code code="8480-6" codeSystem="2.16.840.1.113883.6.1"/>', '<code code="8480-6" codeSystem="2.16.840.1.113883.6.1"/><code code="8462-4" codeSystem="2.16.840.1.113883.6.1"/>');
  assert.equal(paired(twoCodes, dia({ id: "d2" })).panels.length, 0);
});

test("#794 (review): a medication states one period beside its frequencies; a diagnosis one value", () => {
  const medication = (times: string) => `<entry><substanceAdministration classCode="SBADM" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.41" extension="2021-08-01"/>
      <id root="1.3.6.1.4.1.115" extension="med-1"/>
      <statusCode code="active"/>
      ${times}
      <consumable><manufacturedProduct classCode="MANU">
        <manufacturedMaterial><code code="1100184" codeSystem="2.16.840.1.113883.6.88"/></manufacturedMaterial>
      </manufacturedProduct></consumable>
    </substanceAdministration></entry>`;
  const requests = (entries: string) => importQrda1Document(sitedDocument(entries + sitedDiagnosis(""))).bundle.entry.map((e) => e.resource as Record<string, any>).filter((r) => r.resourceType === "MedicationRequest");
  const pivl = '<effectiveTime xsi:type="PIVL_TS" institutionSpecified="true" operator="A"><period value="24" unit="h"/></effectiveTime>';
  const ivl = (low: string, high: string) => `<effectiveTime xsi:type="IVL_TS"><low value='${low}'/><high value='${high}'/></effectiveTime>`;
  // Its period, read even when a frequency is stated first.
  assert.deepEqual(requests(medication(pivl + ivl("20250101", "20250201")))[0]!.dispenseRequest.validityPeriod, { start: "2025-01-01", end: "2025-02-01" });
  // Two periods are two statements.
  assert.deepEqual(requests(medication(ivl("20250101", "20250201") + ivl("20200101", "20201231"))), []);
  // A diagnosis's value, stated twice.
  const twoValues = sitedDiagnosis("").replace('<value xsi:type="CD" code="248802009"', '<value xsi:type="CD" code="44054006" codeSystem="2.16.840.1.113883.6.96"/><value xsi:type="CD" code="248802009"');
  assert.notEqual(twoValues, sitedDiagnosis(""), "the fixture must add a value");
  const conditions = importQrda1Document(sitedDocument(twoValues + lab794())).bundle.entry.filter((e) => (e.resource as { resourceType: string }).resourceType === "Condition");
  assert.deepEqual(conditions, []);
});

test("#794 (review): the patient's id is the first id stating one", () => {
  const doc = sitedDocument(lab794()).replace('<id root="urn:workwell:employee" extension="emp-006"/>', '<id nullFlavor="UNK" root="urn:workwell:employee" extension="ghost"/><id root="urn:workwell:employee" extension="emp-006"/>');
  const patient = importQrda1Document(doc).bundle.entry.map((e) => e.resource as Record<string, any>).find((r) => r.resourceType === "Patient")!;
  assert.equal(patient.id, "emp-006");
});

test("#794: a period that ends before it starts is no time, on every datatype that carries one", () => {
  const encounter = (time: string) => `<entry typeCode="DRIV"><encounter classCode="ENC" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.23" extension="2021-08-01"/>
      <id root="1.3.6.1.4.1.115" extension="enc-r"/>
      <code code="99213" codeSystem="2.16.840.1.113883.6.12"/>
      <statusCode code="completed"/>
      ${time}
    </encounter></entry>`;
  const diagnosis = (time: string) => sitedDiagnosis("").replace(/<effectiveTime>[\s\S]*?<\/effectiveTime>/, time);
  const imported = (entries: string) => importQrda1Document(sitedDocument(entries)).bundle.entry.map((e) => e.resource as Record<string, any>);
  const of = (resources: Record<string, any>[], type: string) => resources.find((r) => r.resourceType === type)!;
  const reversed = "<effectiveTime><low value='20250602100000'/><high value='20250601100000'/></effectiveTime>";
  const both = imported(encounter(reversed) + diagnosis(reversed));
  assert.equal(of(both, "Encounter").period, undefined);
  const condition = of(both, "Condition");
  assert.deepEqual([condition.onsetDateTime, condition.abatementDateTime, condition.clinicalStatus], [undefined, undefined, undefined], "silence, never an active diagnosis");
  // Compared as instants in their own offsets: 20:00 at -10:00 on 1 June is 06:00 UTC on 2 June.
  const zoned = "<effectiveTime><low value='20250602050000+0000'/><high value='20250601200000-1000'/></effectiveTime>";
  assert.deepEqual(of(imported(encounter(zoned)), "Encounter").period, { start: "2025-06-02T05:00:00+00:00", end: "2025-06-01T20:00:00-10:00" });
  const backwards = "<effectiveTime><low value='20250602070000+0000'/><high value='20250601200000-1000'/></effectiveTime>";
  assert.equal(of(imported(encounter(backwards)), "Encounter").period, undefined);
  // Past the millisecond: a time states up to nine digits of a second (Codex, #803).
  const nanos = "<effectiveTime><low value='20250601100000.123456+0000'/><high value='20250601100000.123455+0000'/></effectiveTime>";
  assert.equal(of(imported(encounter(nanos)), "Encounter").period, undefined);
  const ordered = "<effectiveTime><low value='20250601100000.123455+0000'/><high value='20250601100000.123456+0000'/></effectiveTime>";
  assert.deepEqual(of(imported(encounter(ordered)), "Encounter").period, { start: "2025-06-01T10:00:00.123455+00:00", end: "2025-06-01T10:00:00.123456+00:00" });
  // Beside a date, compared as dates at the coarser precision.
  for (const [low, high, kept] of [["2025", "20250601100000", true], ["20250601", "20250601", true], ["20250602", "20250601235959", false], ["202506", "20250530", false], ["20250615", "202506", true]] as const) {
    const period = of(imported(encounter(`<effectiveTime><low value='${low}'/><high value='${high}'/></effectiveTime>`)), "Encounter").period;
    assert.equal(period !== undefined, kept, `${low} to ${high}`);
  }
  // A time whose UTC year leaves 0001-9999 is still a FHIR dateTime, kept in its own offset (#788 did it).
  for (const [value, fhir] of [["99991231235959-1400", "9999-12-31T23:59:59-14:00"], ["00010101000000+0100", "0001-01-01T00:00:00+01:00"]] as const) {
    assert.deepEqual(of(imported(encounter(`<effectiveTime value='${value}'/>`)), "Encounter").period, { start: fhir }, value);
  }
});

// #794, QDM Components: a blood pressure the document states as ONE panel is imported as that panel.
const bpComponent = (code: string, value: string, extra = "") => `<entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN"${extra}>
        <templateId root="2.16.840.1.113883.10.20.24.3.149" extension="2017-08-01"/>
        <code code="${code}" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
        ${value}
      </observation></entryRelationship>`;
const mmHg = (n: number) => `<value xsi:type="PQ" value="${n}" unit="mm[Hg]"/>`;
const statedPanel = (components: string, o: { time?: string; own?: string; code?: string } = {}) => `<entry><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.13" extension="2014-06-09"/>
      <templateId root="2.16.840.1.113883.10.20.24.3.59" extension="2021-08-01"/>
      <id root="1.3.6.1.4.1.115" extension="bp-panel"/>
      ${o.code ?? '<code code="85354-9" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>'}
      <statusCode code="completed"/>
      ${o.time ?? "<effectiveTime value='20250219171000'/>"}
      ${o.own ?? ""}
      ${components}
    </observation></entry>`;
const bothHalves = bpComponent("8480-6", mmHg(128)) + bpComponent("8462-4", mmHg(78));

test("#794: a blood pressure stated as one panel, its readings as QDM Components, is imported as that panel", () => {
  const imported = importQrda1Document(sitedDocument(statedPanel(bothHalves)));
  const panels = imported.bundle.entry.map((e) => e.resource as Record<string, any>).filter((r) => r.resourceType === "Observation");
  assert.equal(panels.length, 1);
  const panel = panels[0]!;
  assert.deepEqual(panel.code, { coding: [{ system: "http://loinc.org", code: "85354-9" }] }, "its own code, as stated");
  assert.deepEqual(panel.category, [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] }]);
  assert.deepEqual(panel.component, [
    { code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] }, valueQuantity: { value: 128, unit: "mm[Hg]", system: "http://unitsofmeasure.org", code: "mm[Hg]" } },
    { code: { coding: [{ system: "http://loinc.org", code: "8462-4" }] }, valueQuantity: { value: 78, unit: "mm[Hg]", system: "http://unitsofmeasure.org", code: "mm[Hg]" } },
  ]);
  assert.deepEqual([panel.id, panel.status, panel.effectiveDateTime, panel.valueQuantity], ["bp-panel", "final", "2025-02-19T17:10:00Z", undefined]);
  assert.deepEqual([imported.unpairedBloodPressureReadings, imported.untranslatedTemplates], [0, []]);
  // The exam's own site, method, author time and patient are the panel's, as for any exam (#805, #806).
  const sited = importQrda1Document(sitedDocument(statedPanel(bothHalves, { own: '<targetSiteCode code="368209003" codeSystem="2.16.840.1.113883.6.96"/><methodCode code="37931006" codeSystem="2.16.840.1.113883.6.96"/><author><time value="20250219171500"/></author>' }))).bundle.entry.map((e) => e.resource as Record<string, any>).find((r) => r.resourceType === "Observation")!;
  assert.deepEqual([sited.bodySite?.coding?.[0]?.code, sited.method?.coding?.[0]?.code, sited.issued, sited.subject?.reference], ["368209003", "37931006", "2025-02-19T17:15:00Z", "Patient/emp-006"]);
  // Diastolic first in the document: the panel still states the systolic first, as the pairing writes it.
  const reversed = importQrda1Document(sitedDocument(statedPanel(bpComponent("8462-4", mmHg(78)) + bpComponent("8480-6", mmHg(128))))).bundle.entry;
  const order = (reversed.map((e) => e.resource as Record<string, any>).find((r) => r.resourceType === "Observation")!.component as Array<{ code: { coding: Array<{ code: string }> } }>).map((c) => c.code.coding[0]!.code);
  assert.deepEqual(order, ["8480-6", "8462-4"]);
  // A date alone is a panel's day: no pairing is needed for a panel the document states.
  const dated = importQrda1Document(sitedDocument(statedPanel(bothHalves, { time: "<effectiveTime value='20250219'/>" }))).bundle.entry.map((e) => e.resource as Record<string, any>);
  assert.equal(dated.find((r) => r.resourceType === "Observation")!.effectiveDateTime, "2025-02-19");
  // An exam coded 85354-9 stating no Components is what it always was: the code alone.
  const codeOnly = importQrda1Document(sitedDocument(statedPanel(""))).bundle.entry.map((e) => e.resource as Record<string, any>).find((r) => r.resourceType === "Observation")!;
  assert.deepEqual([codeOnly.component, codeOnly.category[0].coding[0].code], [undefined, "exam"]);
});

test("#794: a panel the document does not state exactly is not imported as one, and is named", () => {
  const both = bpComponent("8480-6", mmHg(128)).replace('codeSystemName="LOINC"/>', 'codeSystemName="LOINC"><translation code="8462-4" codeSystem="2.16.840.1.113883.6.1"/></code>');
  for (const [why, entry] of [
    ["one reading", statedPanel(bpComponent("8480-6", mmHg(128)))],
    ["a third Component", statedPanel(bothHalves + bpComponent("8478-0", mmHg(95)))],
    ["two systolics", statedPanel(bpComponent("8480-6", mmHg(128)) + bpComponent("8480-6", mmHg(130)))],
    ["a reading stating both halves", statedPanel(both + bpComponent("8462-4", mmHg(78)))],
    ["a reading stating a second code", statedPanel(bpComponent("8480-6", mmHg(128)).replace('codeSystemName="LOINC"/>', 'codeSystemName="LOINC"/><code code="8310-5" codeSystem="2.16.840.1.113883.6.1"/>') + bpComponent("8462-4", mmHg(78)))],
    ["a unit that is not mm[Hg]", statedPanel(bpComponent("8480-6", '<value xsi:type="PQ" value="128" unit="mmHg"/>') + bpComponent("8462-4", mmHg(78)))],
    ["a nullFlavored value", statedPanel(bpComponent("8480-6", '<value xsi:type="PQ" nullFlavor="UNK" value="128" unit="mm[Hg]"/>') + bpComponent("8462-4", mmHg(78)))],
    ["two values", statedPanel(bpComponent("8480-6", mmHg(128) + mmHg(130)) + bpComponent("8462-4", mmHg(78)))],
    ["no number", statedPanel(bpComponent("8480-6", '<value xsi:type="PQ" value="" unit="mm[Hg]"/>') + bpComponent("8462-4", mmHg(78)))],
    ["a negated reading", statedPanel(bpComponent("8480-6", mmHg(128), ' negationInd="true"') + bpComponent("8462-4", mmHg(78)))],
    ["an intended reading", statedPanel(bpComponent("8480-6", mmHg(128)).replace('moodCode="EVN"', 'moodCode="INT"') + bpComponent("8462-4", mmHg(78)))],
    ["a value of the exam's own", statedPanel(bothHalves, { own: mmHg(120) })],
    ["inside an organizer", `<entry><organizer classCode="CLUSTER" moodCode="EVN"><statusCode code="completed"/><component>${statedPanel(bothHalves).replace(/^<entry>|<\/entry>$/g, "")}</component></organizer></entry>`],
  ] as const) {
    const imported = importQrda1Document(sitedDocument(entry + sitedDiagnosis("")));
    const observations = imported.bundle.entry.map((e) => e.resource as Record<string, any>).filter((r) => r.resourceType === "Observation");
    assert.deepEqual(observations, [], why);
    assert.ok(imported.untranslatedTemplates.includes("2.16.840.1.113883.10.20.24.3.59"), why);
  }
});

test("#794: a panel the document states keeps a pair at its time from forming, as any stated reading does (§4A.8)", () => {
  assert.equal(paired(sys(), dia()).panels.length, 1, "the control");
  const panels = (entries: string) => importQrda1Document(sitedDocument(entries)).bundle.entry.map((e) => e.resource as Record<string, any>).filter((r) => r.resourceType === "Observation" && JSON.stringify(r.code).includes("85354-9"));
  // At the pair's time: the stated panel is imported, the separate readings stay readings.
  assert.deepEqual(panels(sys() + dia() + statedPanel(bothHalves)).map((p) => p.id), ["bp-panel"]);
  // At another time each is its own panel.
  assert.equal(panels(sys() + dia() + statedPanel(bothHalves, { time: "<effectiveTime value='20250301090000'/>" })).length, 2);
  // A panel that is not translated still states its readings, and still blocks.
  assert.equal(panels(sys() + dia() + statedPanel(bpComponent("8480-6", mmHg(128)))).length, 0);
});

test("#794 (review): the reference generator's exam, and what a Component or its exam must not state", () => {
  const imported = (entry: string) => importQrda1Document(sitedDocument(entry + sitedDiagnosis("")));
  const panelsIn = (entry: string) => imported(entry).bundle.entry.map((e) => e.resource as Record<string, any>).filter((r) => r.resourceType === "Observation" && r.component !== undefined);
  // The reference QRDA generator writes a nullFlavored value on every exam without a result: it states none.
  assert.equal(panelsIn(statedPanel(bothHalves, { own: '<value xsi:type="CD" nullFlavor="UNK"/>' })).length, 1);
  for (const [why, entry] of [
    ["an aborted reading", statedPanel(bpComponent("8480-6", mmHg(128)).replace("<code ", '<statusCode code="aborted"/><code ') + bpComponent("8462-4", mmHg(78)))],
    ["a reading at a time of its own", statedPanel(bpComponent("8480-6", mmHg(128)).replace("<code ", "<effectiveTime value='20240101090000'/><code ") + bpComponent("8462-4", mmHg(78)))],
    ["a reading with a Result's value beside its own", statedPanel(bpComponent("8480-6", mmHg(128) + `<entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.24.3.87" extension="2019-12-01"/><code code="8480-6" codeSystem="2.16.840.1.113883.6.1"/><statusCode code="completed"/>${mmHg(999)}</observation></entryRelationship>`) + bpComponent("8462-4", mmHg(78)))],
    ["a month", statedPanel(bothHalves, { time: "<effectiveTime value='202502'/>" })],
    ["no time", statedPanel(bothHalves, { time: "" })],
  ] as const) {
    assert.deepEqual(panelsIn(entry), [], why);
    assert.ok(imported(entry).untranslatedTemplates.includes("2.16.840.1.113883.10.20.24.3.59"), why);
  }
  // A completed status is the one a reading may state.
  assert.equal(panelsIn(statedPanel(bpComponent("8480-6", mmHg(128)).replace("<code ", '<statusCode code="completed"/><code ') + bpComponent("8462-4", mmHg(78)))).length, 1);
  // Components are the IG's REFR relationships: under another, the exam states none, and is what it was.
  const comp = imported(statedPanel(bothHalves.replace(/typeCode="REFR"/g, 'typeCode="COMP"'))).bundle.entry.map((e) => e.resource as Record<string, any>).filter((r) => r.resourceType === "Observation");
  assert.deepEqual(comp.map((r) => [r.component, r.category[0].coding[0].code]), [[undefined, "exam"]]);
});

test("#794 (review): readings stated as Components under another code or template are not lost silently, and block", () => {
  const under = (code: string) => statedPanel(bothHalves, { code: `<code code="${code}" codeSystem="2.16.840.1.113883.6.1"/>` });
  const lab = statedPanel(bothHalves).replace('root="2.16.840.1.113883.10.20.24.3.59" extension="2021-08-01"', 'root="2.16.840.1.113883.10.20.24.3.38" extension="2019-12-01"');
  for (const [why, entry] of [["a panel coded 55284-4", under("55284-4")], ["a Laboratory Test coded 85354-9", lab]] as const) {
    const imported = importQrda1Document(sitedDocument(entry + sitedDiagnosis("")));
    assert.deepEqual(imported.bundle.entry.filter((e) => (e.resource as { resourceType: string }).resourceType === "Observation"), [], why);
    assert.equal(imported.untranslatedTemplates.length, 1, why);
    // Its readings, at the pair's time, keep the pair from forming.
    assert.equal(paired(sys(), dia(), entry).panels.length, 0, why);
  }
  // A panel whose own code also carries a reading's code is the panel, never a half of one.
  const translated = statedPanel(bothHalves, { code: '<code code="85354-9" codeSystem="2.16.840.1.113883.6.1"><translation code="8480-6" codeSystem="2.16.840.1.113883.6.1"/></code>' });
  const result = importQrda1Document(sitedDocument(translated + dia({ id: "d2" })));
  assert.equal(result.bundle.entry.filter((e) => JSON.stringify((e.resource as { component?: unknown }).component ?? null) !== "null").length, 1);
  assert.equal(result.unpairedBloodPressureReadings, 1, "the separate diastolic, not the panel");
});

test("#794: every imported clinical resource names its patient, a paired panel included, and a batch names the one it keeps", () => {
  const subjectsOf = (entries: Array<{ resource: unknown }>) => {
    const resources = entries.map((e) => e.resource as Record<string, any>);
    const patient = resources.find((r) => r.resourceType === "Patient")!;
    return { id: patient.id as string, subjects: resources.filter((r) => r.resourceType !== "Patient").map((r) => `${r.resourceType}:${r.subject?.reference}`) };
  };
  const one = subjectsOf(importQrda1Document(sitedDocument(sys() + dia() + sitedDiagnosis("") + lab794())).bundle.entry);
  assert.deepEqual(one.subjects.sort(), ["Condition:Patient/emp-006", "Observation:Patient/emp-006", "Observation:Patient/emp-006"]);
  // Two documents of one person, identified by different first ids: every resource names the Patient kept.
  const other = sitedDocument(lab794()).replace('<id root="urn:workwell:employee" extension="emp-006"/>', '<id root="urn:workwell:other" extension="x-1"/><id root="urn:workwell:employee" extension="emp-006"/>');
  const [subject] = resolveQrda1Documents([sitedDocument(sys() + dia()), other]).subjects;
  const merged = subjectsOf(subject!.bundle.entry);
  assert.ok(merged.subjects.length >= 2);
  assert.deepEqual([...new Set(merged.subjects.map((s) => s.split(":")[1]))], [`Patient/${merged.id}`]);
});

test("#794: an Observation carries its author time as issued, and one stated site and method", () => {
  const author = (time: string) => `<author><templateId root="2.16.840.1.113883.10.20.24.3.155" extension="2019-12-01"/><time value="${time}"/><assignedAuthor><id nullFlavor="NA"/></assignedAuthor></author>`;
  const site = (code: string) => `<targetSiteCode code="${code}" codeSystem="2.16.840.1.113883.6.96"/>`;
  const method = `<methodCode code="37931006" codeSystem="2.16.840.1.113883.6.96"/>`;
  const reading = (extra: string) => {
    const imported = importQrda1Document(sitedDocument(exam({ id: "s-only", code: "8480-6", extra })));
    return imported.bundle.entry.map((e) => e.resource as Record<string, any>).find((r) => r.resourceType === "Observation")!;
  };
  const all = reading(author("20250219171500") + site("368209003") + method);
  assert.deepEqual([all.issued, all.bodySite?.coding?.[0]?.code, all.method?.coding?.[0]?.code], ["2025-02-19T17:15:00Z", "368209003", "37931006"]);
  // Its own time stays its effective time: the author time is when it was recorded.
  assert.equal(all.effectiveDateTime, "2025-02-19T17:10:00Z");
  // What it cannot hold once, or as an instant, is left out.
  const none = reading(author("20250219") + site("368209003") + site("368208006") + method + method);
  assert.deepEqual([none.issued, none.bodySite, none.method], [undefined, undefined, undefined]);
  assert.equal(reading(author("20250219171500") + author("20250220090000")).issued, undefined, "two authors' times are two statements");
  // A minute is not an instant: padding it would invent its second (Codex, #805).
  assert.equal(reading(author("202502191715")).issued, undefined);
  // Two times under one author are two statements too.
  assert.equal(reading(author("20250219171500").replace("</author>", '<time value="20250220090000"/></author>')).issued, undefined);
  // A lab carries them the same way.
  const lab = labsOf(sitedDocument(lab794({ value: '<value xsi:type="PQ" value="7.1" unit="%"/>' + method }).replace("</observation></entry>", `${author("20250602080000")}</observation></entry>`)))[0]!;
  assert.deepEqual([lab.issued, lab.method?.coding?.[0]?.code], ["2025-06-02T08:00:00Z", undefined], "a lab's method is its Result's, not its own");
});

test("import NAMES an untranslated QDM datatype rather than counting it", () => {
  // An operator needs to know WHICH datatype was dropped to judge whether the recalculation can be
  // trusted; a bare count reads as "a few things we don't support".
  // Patient Characteristic Payer, deliberately: supplemental data, present in every Cypress document,
  // and genuinely untranslated. This used a bare Medication, Active until #387 taught the importer to
  // read that datatype — at which point the test still passed for the wrong reason (an entry with no
  // drug code) while claiming something no longer true.
  const withPayer = buildQrda1Document(run, "cms125", outcome(officialEvidence), sourceBundle).replace(
    "</section>\n      </component>\n    </structuredBody>",
    `<entry typeCode="DRIV"><observation classCode="OBS" moodCode="EVN">
       <templateId root="2.16.840.1.113883.10.20.24.3.55"/>
       <code code="48768-6" codeSystem="2.16.840.1.113883.6.1"/>
     </observation></entry></section>
      </component>
    </structuredBody>`,
  );
  const imported = importQrda1Document(withPayer);
  assert.deepEqual(imported.untranslatedTemplates, ["2.16.840.1.113883.10.20.24.3.55"], "Patient Characteristic Payer — named");
});

test("the exported patient identity is the OUTCOME's subjectId, not the bundle's Patient.id", () => {
  // Worth pinning because the two can differ and only one is the identity a receiver sees. The export
  // writes `outcome.subjectId` into `patientRole/id`; the import reads that back. So the imported
  // bundle's `Patient.id` is the SUBJECT id — which is what the engine keys on, so evaluation is
  // consistent — and the source bundle's own `Patient.id` is not carried.
  const differing = { ...sourceBundle, entry: [{ resource: { resourceType: "Patient", id: "webchart-999", gender: "female" } }, sourceBundle.entry[5]!] };
  const imported = importQrda1Document(buildQrda1Document(run, "cms125", outcome(officialEvidence), differing));
  assert.equal(imported.patientId, "emp-006", "the outcome's subject id is the identity");
  assert.equal((imported.bundle.entry[0]!.resource as { id: string }).id, "emp-006", "and the engine will key on it");
});

test("import survives hostile content — escaping round-trips exactly", () => {
  const hostileSubject = { ...outcome(officialEvidence), subjectId: 'p<&"1' } as OutcomeRecord;
  const nasty = buildQrda1Document(run, "cms125", hostileSubject, {
    ...sourceBundle,
    entry: [
      { resource: { resourceType: "Patient", id: 'p<&"1', gender: "female" } },
      { resource: { resourceType: "Procedure", id: "proc-1", status: "completed", code: { coding: [{ system: "http://snomed.info/sct", code: "x&y<z" }] }, performedDateTime: "2025-05-10T10:00:00Z" } },
    ],
  });
  const imported = importQrda1Document(nasty);
  assert.equal(imported.patientId, 'p<&"1', "escaping survives the round trip exactly");
  const code = (imported.bundle.entry[1]!.resource as { code: { coding: Array<{ code: string }> } }).code.coding[0]!.code;
  assert.equal(code, "x&y<z");
});

// ---------------------------------------------------------------- a document we did not write

test("import reads the CMS RY2026 sample file, if it is available locally", (t) => {
  // The round trip only proves our two halves agree. This is the one check against a document written by
  // someone else — self-skipping, because the sample ships in a manually-downloaded CMS zip (the same
  // artifact `scripts/qrda-schematron-check.py` documents). It is NOT part of any gate, and it says so
  // rather than reading as covered when the file is absent.
  const path = process.env.WORKWELL_QRDA1_SAMPLE;
  if (!path) return t.skip("set WORKWELL_QRDA1_SAMPLE to a CMS QRDA I sample file to run this");
  const imported = importQrda1Document(readFileSync(path, "utf8"));
  assert.ok(imported.patientId, "a subject is identified");
  assert.ok(imported.bundle.entry.length > 1, "at least one clinical resource was translated");
  assert.ok(imported.measureIdentifiers.length > 0, "the measure is identified by its eMeasure UUID");
});

// ---------------------------------------------------------------- the parser's hard cases

test("CDA parse: a legal `>` INSIDE an attribute value does not truncate the element", () => {
  // XML requires only `<` and `&` to be escaped in an attribute; a bare `>` is conformant, and a lab
  // feed emitting `displayName="HbA1c > 9.0%"` is entirely normal. Scanning for the first `>` truncated
  // the element mid-attribute, which then lost its self-closing slash, was pushed on the stack, and
  // SWALLOWED ITS SIBLINGS — so the date and value silently vanished from an HbA1c of 9.6 (review, #362).
  // The round trip provably cannot catch this: our own `esc()` escapes `>`, so we never emit the input
  // that breaks us.
  const root = parseXml(`<o><code displayName="HbA1c > 9.0%"/><effectiveTime value="20250601100000"/><value unit="%"/></o>`)!;
  assert.equal(root.children.length, 3, "three siblings, not one that ate the others");
  assert.equal(child(root, "code")?.attrs.displayName, "HbA1c > 9.0%");
  assert.equal(child(root, "effectiveTime")?.attrs.value, "20250601100000");
  assert.equal(child(root, "value")?.attrs.unit, "%");
});

test("CDA parse: unmatched close tags are LINEAR, not quadratic", () => {
  // A 1 MB body of unmatched closes took 53 SECONDS on this single-threaded host — an accidental DoS
  // from a truncated document, not only a malicious one (review, #362). Close-tag matching is now an
  // O(1) name→depth lookup instead of a full stack scan. The bound here is generous so the test is not
  // flaky on a loaded machine; the point is the ORDER of growth, and the old code took minutes.
  const n = 20_000;
  const payload = `<r>${"<a>".repeat(n)}${"</z>".repeat(n)}</r>`;
  const started = process.hrtime.bigint();
  const root = parseXml(payload);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(root?.local, "r");
  assert.ok(ms < 4000, `parsing ${payload.length} bytes took ${Math.round(ms)}ms — quadratic behaviour is back`);
});

test("CDA parse: deep nesting does not blow the call stack", () => {
  // `descendants()` recursed and threw RangeError at ~5 000 levels — a ~30 KB document — and
  // `importQrda1Document` calls it on the root before anything else. Explicit stack now.
  const depth = 20_000;
  const root = parseXml(`${"<a>".repeat(depth)}<target/>${"</a>".repeat(depth)}`)!;
  assert.doesNotThrow(() => descendants(root, "target"));
  assert.equal(descendants(root, "target").length, 1);
});

test("CDA parse: XXE is impossible — a declared external entity stays literal", () => {
  const root = parseXml(`<!DOCTYPE a [<!ENTITY xx SYSTEM "file:///etc/passwd">]><a>&xx;</a>`)!;
  assert.equal(root.text, "&xx;", "no entity table means nothing to resolve");
});

test("import: EVERY translatable datatype in an entry is taken, not just the first (review, #362)", () => {
  // A Result Organizer carrying two Laboratory Tests, Performed is a standard CDA construct. Stopping at
  // the first dropped the rest AND marked the entry fully translated — so an HbA1c that is the second
  // component of a chemistry panel vanished with `untranslatedTemplates: []`.
  const twoLabs = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <recordTarget><patientRole><id root="urn:workwell:employee" extension="emp-006"/></patientRole></recordTarget>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.24.2.1" extension="2021-08-01"/>
    <entry typeCode="DRIV"><organizer classCode="BATTERY" moodCode="EVN">
      <observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.24.3.38" extension="2021-08-01"/>
        <id root="urn:workwell:fhir" extension="lab-A"/>
        <code code="4548-4" codeSystem="2.16.840.1.113883.6.1"/>
        <statusCode code="completed"/>
        <effectiveTime value="20250601100000"/>
      </observation>
      <observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.24.3.38" extension="2021-08-01"/>
        <id root="urn:workwell:fhir" extension="lab-B"/>
        <code code="2345-7" codeSystem="2.16.840.1.113883.6.1"/>
        <statusCode code="completed"/>
        <effectiveTime value="20250601100000"/>
      </observation>
    </organizer></entry>
  </section></component></structuredBody></component>
</ClinicalDocument>`;
  const imported = importQrda1Document(twoLabs);
  const ids = imported.bundle.entry.map((e) => (e.resource as { id: string }).id);
  assert.ok(ids.includes("lab-A") && ids.includes("lab-B"), `both labs must import — got ${ids.join(", ")}`);
});

test("import: an out-of-range date does not become a FHIR field (review, #362)", () => {
  // `00000000` — a MariaDB zero date — became `"0000-00-00"` in `Patient.birthDate`, where CMS125's
  // initial population feeds it to `AgeAt(...)`. The date-only branch had no validation at all.
  const withZeroDate = `<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole><id root="urn:workwell:employee" extension="emp-006"/>
    <patient><birthTime value="00000000"/></patient></patientRole></recordTarget>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.24.2.1" extension="2021-08-01"/>
    <entry typeCode="DRIV"><procedure classCode="PROC" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.64" extension="2021-08-01"/>
      <code code="77067" codeSystem="2.16.840.1.113883.6.12"/>
      <statusCode code="completed"/>
      <effectiveTime value="20250510100000"/>
    </procedure></entry>
  </section></component></structuredBody></component>
</ClinicalDocument>`;
  const patient = importQrda1Document(withZeroDate).bundle.entry[0]!.resource as { birthDate?: string };
  assert.equal(patient.birthDate, undefined, "an impossible date is absent, not passed through");
});

// ---------------------------------------------------------------------------------------------------
// The datatypes the EXCLUSION logic reads (#387 measurement, ADR pending)
//
// None of these has an export counterpart, so the round trip above cannot reach them: our own evaluated
// bundles never carry frailty, hospice or palliative data. The fixture below is therefore modelled on
// Cypress's OWN generated documents — the element nesting, the `sdtc:` prefix and the attribute order
// are copied from `bundle-2025`'s CMS122 archive rather than invented, because every one of those
// details is a place this importer previously lost data.
//
// What each target resource IS was read off the official artifacts' ELM retrieves, not off a QDM
// mapping table: Intervention Performed → Procedure, Intervention Order → ServiceRequest, Device Order
// → DeviceRequest, Medication Active → MedicationRequest, Symptom + Assessment → Observation.
// ---------------------------------------------------------------------------------------------------

const exclusionDocument = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:sdtc="urn:hl7-org:sdtc">
  <recordTarget><patientRole>
    <id extension="cypress-mrn-1" root="1.3.6.1.4.1.115"/>
    <patient>
      <name><given>TWO</given><family>Advanced Illness</family></name>
      <administrativeGenderCode nullFlavor="OTH"><translation code="248152002" codeSystem="2.16.840.1.113883.6.96"/></administrativeGenderCode>
      <birthTime value='19501224203000'/>
    </patient>
  </patientRole></recordTarget>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.24.2.1" extension="2021-08-01"/>

    <entry><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.144" extension="2021-08-01"/>
      <id root="1.3.6.1.4.1.115" extension="assess-1"/>
      <code code="71802-3" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
      <statusCode code="completed"/>
      <effectiveTime value='20240523081000'/>
      <value xsi:type="CD" code="160734000" codeSystem="2.16.840.1.113883.6.96"/>
      <author><templateId root="2.16.840.1.113883.10.20.24.3.155" extension="2019-12-01"/><time value='20240523081000'/></author>
    </observation></entry>

    <entry><act classCode="ACT" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.138" extension="2021-08-01"/>
      <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.24.3.136" extension="2021-08-01"/>
        <id root="1.3.6.1.4.1.115" extension="symptom-1"/>
        <code code="75325-1" codeSystem="2.16.840.1.113883.6.1"><translation code="418799008" codeSystem="2.16.840.1.113883.6.96"/></code>
        <statusCode code="completed"/>
        <effectiveTime><low value='20221028080000'/><high value='20240101080000'/></effectiveTime>
        <value xsi:type="CD" code="102492002" codeSystem="2.16.840.1.113883.6.96"><translation code="R63.6" codeSystem="2.16.840.1.113883.6.90"/></value>
      </observation></entryRelationship>
    </act></entry>

    <entry><act classCode="ACT" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.32" extension="2021-08-01"/>
      <id root="1.3.6.1.4.1.115" extension="intervention-1"/>
      <code code="103735009" codeSystem="2.16.840.1.113883.6.96"/>
      <statusCode code="completed"/>
      <effectiveTime value='20240602081000'/>
    </act></entry>

    <entry><act classCode="ACT" moodCode="RQO">
      <templateId root="2.16.840.1.113883.10.20.24.3.31" extension="2021-08-01"/>
      <id root="1.3.6.1.4.1.115" extension="order-1"/>
      <code code="386464006" codeSystem="2.16.840.1.113883.6.96"><translation code="S9449" codeSystem="2.16.840.1.113883.6.285"/></code>
      <statusCode code="active"/>
      <author><templateId root="2.16.840.1.113883.10.20.24.3.155" extension="2019-12-01"/><time value='20240314083000'/></author>
    </act></entry>

    <entry><act classCode="ACT" moodCode="RQO">
      <templateId root="2.16.840.1.113883.10.20.24.3.130" extension="2021-08-01"/>
      <code code="SPLY" codeSystem="2.16.840.1.113883.5.6" displayName="Supply"/>
      <entryRelationship typeCode="SUBJ"><supply classCode="SPLY" moodCode="RQO">
        <templateId root="2.16.840.1.113883.10.20.24.3.9" extension="2021-08-01"/>
        <id root="1.3.6.1.4.1.115" extension="device-1"/>
        <statusCode code="active"/>
        <author><templateId root="2.16.840.1.113883.10.20.24.3.155" extension="2019-12-01"/><time value='20240620081500'/></author>
        <participant typeCode="DEV"><participantRole classCode="MANU"><playingDevice classCode="DEV">
          <code code="360006004" codeSystem="2.16.840.1.113883.6.96"/>
        </playingDevice></participantRole></participant>
      </supply></entryRelationship>
    </act></entry>

    <entry><substanceAdministration classCode="SBADM" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.41" extension="2021-08-01"/>
      <id root="1.3.6.1.4.1.115" extension="med-1"/>
      <statusCode code="active"/>
      <effectiveTime xsi:type="IVL_TS"><low value='20230820080000'/><high nullFlavor='UNK'/></effectiveTime>
      <consumable><manufacturedProduct classCode="MANU">
        <manufacturedMaterial><code code="1100184" codeSystem="2.16.840.1.113883.6.88" codeSystemName="RXNORM"/></manufacturedMaterial>
      </manufacturedProduct></consumable>
    </substanceAdministration></entry>

    <entry><encounter classCode="ENC" moodCode="EVN">
      <templateId extension="2021-08-01" root="2.16.840.1.113883.10.20.24.3.23"/>
      <id extension="enc-inpatient" root="1.3.6.1.4.1.115"/>
      <code code="32485007" codeSystem="2.16.840.1.113883.6.96"/>
      <statusCode code="completed"/>
      <effectiveTime><low value='20240813080000'/><high value='20240825081500'/></effectiveTime>
      <sdtc:dischargeDispositionCode code="428371000124100" codeSystem="2.16.840.1.113883.6.96"/>
    </encounter></entry>

    <entry><procedure classCode="PROC" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.64" extension="2021-08-01"/>
      <id root="1.3.6.1.4.1.115" extension="proc-icd10pcs"/>
      <code code="0HTT0ZZ" codeSystem="2.16.840.1.113883.6.4" codeSystemName="ICD10PCS">
        <translation code="429400009" codeSystem="2.16.840.1.113883.6.96" codeSystemName="SNOMEDCT"/>
      </code>
      <statusCode code="completed"/>
      <effectiveTime><low value='20230220080000'/><high value='20230220081500'/></effectiveTime>
    </procedure></entry>

  </section></component></structuredBody></component>
</ClinicalDocument>`;

const exclusionResources = () => {
  const imported = importQrda1Document(exclusionDocument);
  const of = (type: string) =>
    imported.bundle.entry.map((e) => e.resource as Record<string, any>).filter((r) => r.resourceType === type);
  return { imported, of };
};

test("import: Assessment, Performed is an Observation whose CODE is the instrument and VALUE the result", () => {
  const { of } = exclusionResources();
  const assessment = of("Observation").find((o) => o.code?.coding?.[0]?.code === "71802-3");
  assert.ok(assessment, "the assessment must survive — it is a long-term-care exclusion input");
  assert.equal(assessment!.category?.[0]?.coding?.[0]?.code, "survey", "QI-Core screening-assessment");
  assert.equal(assessment!.valueCodeableConcept?.coding?.[0]?.code, "160734000", "the RESULT is the value");
  assert.equal(assessment!.effectiveDateTime, "2024-05-23T08:10:00Z");
});

test("import: a Symptom INVERTS code and value — the symptom itself must land in Observation.code", () => {
  // `[Observation: "Frailty Symptom"]` filters on `Observation.code`. The element's own `<code>` says
  // only "this entry is a symptom" (LOINC 75325-1); the `<value>` carries the symptom. Put them the
  // other way round and the retrieve matches nothing while the bundle looks complete.
  const { of } = exclusionResources();
  const symptom = of("Observation").find((o) => o.id === "symptom-1");
  assert.ok(symptom);
  assert.equal(symptom!.code?.coding?.[0]?.code, "102492002", "the SYMPTOM is the code");
  assert.notEqual(symptom!.code?.coding?.[0]?.code, "75325-1", "not the 'this is a symptom' marker");
  assert.equal(symptom!.valueCodeableConcept, undefined, "and it must not sit in value, where nothing reads it");
  assert.deepEqual(symptom!.effectivePeriod, { start: "2022-10-28T08:00:00Z", end: "2024-01-01T08:00:00Z" });
});

test("import: Intervention Performed → Procedure, Intervention Order → ServiceRequest with authoredOn", () => {
  const { of } = exclusionResources();
  const intervention = of("Procedure").find((p) => p.id === "intervention-1");
  assert.ok(intervention, "Intervention, Performed IS a Procedure to the official artifacts");
  assert.equal(intervention!.code?.coding?.[0]?.code, "103735009");
  assert.equal(intervention!.performedDateTime, "2024-06-02T08:10:00Z");

  const [order] = of("ServiceRequest");
  assert.ok(order);
  assert.equal(order!.code?.coding?.[0]?.code, "386464006");
  // The exclusion libraries read `authoredOn` and it lives in `<author><time>`, not effectiveTime — an
  // order imported without it retrieves by code and then fails every temporal predicate.
  assert.equal(order!.authoredOn, "2024-03-14T08:30:00Z");
  assert.equal(order!.intent, "order");
});

test("import: a Device Order is coded from the playingDevice, the only place the device appears", () => {
  // The `<supply>` carries the template but no code of its own, and the only `<code>` up the tree is the
  // enclosing act's ActClass literal "SPLY" — so walking up yields a DeviceRequest coded "Supply", which
  // matches no value set and is indistinguishable from a device the patient does not have.
  //
  // Asserting `!= "SPLY"` would look like it forbids that and cannot fail, because a mapper that read
  // the supply's own code would find nothing and drop the resource. So the load-bearing assertions are
  // that the resource EXISTS and carries the device code; mutation-checked — reading anything but the
  // playingDevice fails this test and the "nothing untranslated" one below.
  const { of } = exclusionResources();
  const [device] = of("DeviceRequest");
  assert.ok(device, "a Device, Order must survive — it is a frailty exclusion input");
  assert.equal(device!.codeCodeableConcept?.coding?.[0]?.code, "360006004");
  assert.equal(device!.authoredOn, "2024-06-20T08:15:00Z");
});

test("import: Medication, Active takes the drug from manufacturedMaterial", () => {
  const { of } = exclusionResources();
  const [medication] = of("MedicationRequest");
  assert.ok(medication);
  assert.equal(medication!.medicationCodeableConcept?.coding?.[0]?.code, "1100184");
  assert.equal(medication!.medicationCodeableConcept?.coding?.[0]?.system, "http://www.nlm.nih.gov/research/umls/rxnorm");
});

test("import: an inpatient encounter keeps its DISCHARGE DISPOSITION", () => {
  // `Encounter.hospitalization.dischargeDisposition` — an inpatient stay ending in "discharge to home
  // for hospice care" is a denominator exclusion in both routed measures. Measured on Cypress's own
  // patients, this single field was the last cause of divergence after the missing datatypes were
  // mapped: 9 subjects in each measure. The element carries an `sdtc:` prefix.
  const { of } = exclusionResources();
  const encounter = of("Encounter").find((e) => e.id === "enc-inpatient");
  assert.ok(encounter);
  assert.equal(encounter!.hospitalization?.dischargeDisposition?.coding?.[0]?.code, "428371000124100");
});

test("import: a <translation> is an ADDITIONAL coding, and an unmapped primary code no longer discards the resource", () => {
  // Measured: 4 of CMS125's 10 Procedure entries are coded in ICD-10-PCS, which was not in the system
  // map — so `concept()` returned undefined and the caller dropped the whole Procedure, taking a
  // mastectomy exclusion with it. Both halves are pinned: the system is now mapped, AND the SNOMED
  // translation (the code the exclusion value set actually contains) rides along.
  const { of } = exclusionResources();
  const procedure = of("Procedure").find((p) => p.id === "proc-icd10pcs");
  assert.ok(procedure, "an ICD-10-PCS-coded procedure must not vanish");
  const codes = procedure!.code.coding.map((c: { code: string }) => c.code);
  assert.deepEqual(codes, ["0HTT0ZZ", "429400009"], "primary first, translation second — both present");
  assert.equal(procedure!.code.coding[1].system, "http://snomed.info/sct");
});

test("import: Patient.birthDate is a DATE, not a dateTime", () => {
  // FHIR types it `date`; a QRDA `birthTime` is 14 digits. It changed no population when measured, but
  // it is invalid FHIR that our own exporter would never produce.
  const { imported } = exclusionResources();
  const patient = imported.bundle.entry.map((e) => e.resource as Record<string, any>).find((r) => r.resourceType === "Patient")!;
  assert.equal(patient.birthDate, "1950-12-24");
});

test("import: every exclusion datatype in a Cypress-shaped document translates — none is reported untranslated", () => {
  const { imported } = exclusionResources();
  assert.deepEqual(imported.untranslatedTemplates, [], "a dropped exclusion input is a wrong answer, not a gap");
});

test("#788: every mapper keeps a time's stated offset, at the clock time the document states", () => {
  // The Cypress-shaped fixture, each time of day stated in Maui's offset (a date alone cannot carry one).
  const restated = exclusionDocument.replace(/(<(?:effectiveTime|low|high|time)\b[^>]*?\bvalue=)(['"])(\d{12,14})\2/g, "$1$2$3-1000$2");
  assert.notEqual(restated, exclusionDocument);
  const resources = importQrda1Document(restated).bundle.entry.map((e) => e.resource as Record<string, any>);
  const times: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) times.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  };
  resources.forEach(collect);
  assert.ok(times.length >= 10, `every mapper's times are read, got ${times.length}`);
  assert.deepEqual(times.filter((t) => !t.endsWith("-10:00")), [], "each in its stated offset, none converted");
  const byId = (id: string) => resources.find((r) => r.id === id)!;
  assert.deepEqual(byId("enc-inpatient").period, { start: "2024-08-13T08:00:00-10:00", end: "2024-08-25T08:15:00-10:00" });
  assert.equal(byId("order-1").authoredOn, "2024-03-14T08:30:00-10:00");
  assert.deepEqual(byId("med-1").dispenseRequest.validityPeriod, { start: "2023-08-20T08:00:00-10:00" });
  assert.equal(resources.find((r) => r.resourceType === "Patient")!.birthDate, "1950-12-24", "a birth date stays a date");
});

test("import NAMES the DATATYPE template, not the nested attribute template inside it", () => {
  // `untranslatedTemplates` used to report the LAST templateId found anywhere in the entry, and QDM
  // nests attribute templates (Author dateTime, Rank) inside the element carrying the datatype — so it
  // blamed Author dateTime for 31 of CMS122's entries. A diagnostic that names the wrong thing is worse
  // than a count, because it sends the reader somewhere.
  const withPayer = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole><id root="1.3.6.1.4.1.115" extension="p1"/></patientRole></recordTarget>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.24.2.1" extension="2021-08-01"/>
    <entry><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.55"/>
      <code code="48768-6" codeSystem="2.16.840.1.113883.6.1"/>
      <value xsi:type="CD" code="1" codeSystem="2.16.840.1.113883.3.221.5"/>
      <author><templateId root="2.16.840.1.113883.10.20.24.3.155" extension="2019-12-01"/><time value='20240101080000'/></author>
    </observation></entry>
    <entry><procedure classCode="PROC" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.64" extension="2021-08-01"/>
      <code code="0HTT0ZZ" codeSystem="2.16.840.1.113883.6.4"/>
      <statusCode code="completed"/>
      <effectiveTime value='20240220080000'/>
    </procedure></entry>
  </section></component></structuredBody></component>
</ClinicalDocument>`;
  const imported = importQrda1Document(withPayer);
  assert.deepEqual(
    imported.untranslatedTemplates,
    ["2.16.840.1.113883.10.20.24.3.55"],
    "Patient Characteristic Payer — the datatype, not the Author dateTime nested in it",
  );
});

test("import: the status values are the ones Status.is* PREDICATES require, not decoration", () => {
  // Every retrieve on an exclusion path is wrapped in a `Status.is*` predicate, and the margins are
  // thin: `isMedicationActive` is an `Equal` on "active", so a plausible-looking edit to "completed"
  // silently kills the dementia exclusion. Pinned against the predicate each one satisfies, because an
  // earlier version of the source comment claimed these fields were NOT read (review, #388).
  const { of } = exclusionResources();
  assert.equal(of("MedicationRequest")[0]!.status, "active", "isMedicationActive: Equal status 'active'");
  assert.equal(of("MedicationRequest")[0]!.intent, "order", "isMedicationActive: intent in {order, …}");
  assert.equal(of("ServiceRequest")[0]!.intent, "order", "isInterventionOrder: intent = 'order'");
  assert.equal(of("Encounter").find((e) => e.id === "enc-inpatient")!.status, "finished", "isEncounterPerformed");
  assert.equal(of("Procedure").find((p) => p.id === "intervention-1")!.status, "completed", "isProcedurePerformed");
  assert.equal(of("Observation").find((o) => o.id === "symptom-1")!.status, "final", "isSymptom: status in {…, final, …}");
  assert.equal(
    of("Observation").find((o) => o.code?.coding?.[0]?.code === "71802-3")!.status,
    "final",
    "isAssessmentPerformed: status in {final, amended, corrected}",
  );
});

test("import: an order with no <author> falls back to its effectiveTime for authoredOn", () => {
  // The fixture's Medication, Active has no `<author>` — exactly like Cypress's — and `authoredOn` is
  // what `Has Dementia Medications` reads. Without the fallback the resource imports, retrieves by code,
  // and then fails every temporal predicate: present in the bundle, invisible to the measure.
  const { of } = exclusionResources();
  assert.equal(of("MedicationRequest")[0]!.authoredOn, "2023-08-20T08:00:00Z", "from effectiveTime/low");
});

test("import: a NEGATED act is not imported as a positive fact", () => {
  // `negationInd="true"` means the act did NOT happen. Importing it positively would manufacture a
  // denominator exclusion from a record stating the opposite — silent, and it fabricates
  // compliance-relevant data. Cypress carries none of these, so nothing but this test covers it.
  const negated = exclusionDocument.replace(
    '<act classCode="ACT" moodCode="EVN">\n      <templateId root="2.16.840.1.113883.10.20.24.3.32"',
    '<act classCode="ACT" moodCode="EVN" negationInd="true">\n      <templateId root="2.16.840.1.113883.10.20.24.3.32"',
  );
  assert.notEqual(negated, exclusionDocument, "the fixture must actually have been negated");
  const resources = importQrda1Document(negated).bundle.entry.map((e) => e.resource as Record<string, any>);
  assert.equal(
    resources.find((r) => r.id === "intervention-1"),
    undefined,
    "a negated Intervention, Performed must not become a Procedure",
  );
  assert.ok(
    importQrda1Document(negated).untranslatedTemplates.includes("2.16.840.1.113883.10.20.24.3.32"),
    "and it is reported rather than dropped in silence",
  );
});

test("import: an UNMAPPED primary code system keeps the resource when a mapped <translation> is present", () => {
  // The other half of "an unmappable primary code no longer discards the resource" — the ICD-10-PCS
  // fixture above cannot test it, because that OID is now IN the map, so the discard branch is never
  // reached. Mutation testing found this gap: reverting `concept()` to discard-on-unmapped left every
  // test green (review, #388). CDT is a real code system we deliberately do not map.
  const withUnmappedPrimary = exclusionDocument.replace(
    '<code code="0HTT0ZZ" codeSystem="2.16.840.1.113883.6.4" codeSystemName="ICD10PCS">',
    '<code code="D1110" codeSystem="2.16.840.1.113883.6.13" codeSystemName="CDT">',
  );
  assert.notEqual(withUnmappedPrimary, exclusionDocument);
  const procedure = importQrda1Document(withUnmappedPrimary)
    .bundle.entry.map((e) => e.resource as Record<string, any>)
    .find((r) => r.id === "proc-icd10pcs");
  assert.ok(procedure, "the resource survives on its translation alone");
  assert.deepEqual(
    procedure!.code.coding,
    [{ system: "http://snomed.info/sct", code: "429400009", display: undefined }].map((c) => ({
      system: c.system,
      code: c.code,
    })),
    "and carries only the coding that resolved",
  );
});

test("import: the untranslated diagnostic names the datatype even when a WRAPPER template precedes it", () => {
  // `ATTRIBUTE_TEMPLATES` earns its keep only when a non-datatype QDM template appears BEFORE the
  // datatype in document order — which is exactly what a Concern Act wrapper does. Without the set, the
  // first QDM-looking root wins and the report blames the wrapper (review, #388).
  const wrappedUnknown = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole><id root="1.3.6.1.4.1.115" extension="p1"/></patientRole></recordTarget>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.24.2.1" extension="2021-08-01"/>
    <entry><act classCode="ACT" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.138" extension="2021-08-01"/>
      <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.24.3.55"/>
        <code code="48768-6" codeSystem="2.16.840.1.113883.6.1"/>
      </observation></entryRelationship>
    </act></entry>
    <entry><procedure classCode="PROC" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.64" extension="2021-08-01"/>
      <code code="0HTT0ZZ" codeSystem="2.16.840.1.113883.6.4"/>
      <statusCode code="completed"/>
      <effectiveTime value='20240220080000'/>
    </procedure></entry>
  </section></component></structuredBody></component>
</ClinicalDocument>`;
  assert.deepEqual(
    importQrda1Document(wrappedUnknown).untranslatedTemplates,
    ["2.16.840.1.113883.10.20.24.3.55"],
    "the datatype inside the Concern Act, not the Concern Act",
  );
});

test("import: every code system we map is spelled the way the ARTIFACTS spell it", () => {
  // `cql-execution` compares `system` by exact string equality, so a near-miss imports the resource and
  // leaves it invisible to every retrieve — strictly worse than dropping it, because a drop at least
  // appears in `untranslatedTemplates`. HCPCS was exactly that: `urn:oid:2.16.840.1.113883.6.285` where
  // the expansions say the CMS URL, across 103 codes including Annual Wellness Visit and Hospice Care
  // Ambulatory. It never surfaced as a divergence because the IPP is `exists(...)` and those patients
  // carry other qualifying encounters — a right answer for the wrong reason (review, #388).
  //
  // The literals here are the structural half; `qrda1-import-official.test.ts` checks them against the
  // vendored expansions themselves, which is the half that can catch a future re-vendor moving a URL.
  assert.equal(SYSTEM_FOR_OID["2.16.840.1.113883.6.285"], "http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets");
  assert.equal(SYSTEM_FOR_OID["2.16.840.1.113883.6.4"], "http://www.cms.gov/Medicare/Coding/ICD10");
  assert.equal(SYSTEM_FOR_OID["2.16.840.1.113883.6.88"], "http://www.nlm.nih.gov/research/umls/rxnorm");
  assert.equal(SYSTEM_FOR_OID["2.16.840.1.113883.6.96"], "http://snomed.info/sct");
  assert.equal(SYSTEM_FOR_OID["2.16.840.1.113883.6.1"], "http://loinc.org");
  assert.equal(SYSTEM_FOR_OID["2.16.840.1.113883.6.12"], "http://www.ama-assn.org/go/cpt");
  assert.equal(SYSTEM_FOR_OID["2.16.840.1.113883.6.90"], "http://hl7.org/fhir/sid/icd-10-cm");
});

test("import: a birthTime with an OFFSET keeps its own calendar day, not the UTC one", () => {
  // `Patient.birthDate` is a local calendar fact, not an instant. While `isoFromHl7` normalized to UTC
  // (until #788), truncating ITS output gave the wrong day near midnight: `20000101010000+1400` was
  // `1999-12-31T11:00:00Z`. On a measure boundary that moves a patient between age bands, which is a
  // population change from a formatting decision (Codex, #388).
  const shifted = exclusionDocument.replace("<birthTime value='19501224203000'/>", "<birthTime value='20000101010000+1400'/>");
  assert.notEqual(shifted, exclusionDocument);
  const patient = importQrda1Document(shifted).bundle.entry
    .map((e) => e.resource as Record<string, any>)
    .find((r) => r.resourceType === "Patient")!;
  assert.equal(patient.birthDate, "2000-01-01", "the day the document states, not the UTC-normalized one");
});

// ---------------------------------------------------------------------------------------------------
// clinicalStatus comes from what the document SAYS about the interval (#594)
//
// Until 2026-09-21 this file emitted no `clinicalStatus` and `prepareForQiCore` minted `active` for
// every imported Condition - including one carrying an `abatementDateTime` that this importer had
// just written from a closed interval. Two files in one pipeline disagreed about identical bytes:
// `qdm-entries.ts` honours a system-less `entered-in-error` as a negation while preparation rewrote
// it to `confirmed`.
//
// The three cases below are the three things a QRDA-I `<effectiveTime>` can say, and they must not
// collapse into one. Each asserts a DIFFERENT result, which is the bar #594 set: a fixture that
// cannot change the answer cannot tell a correct mapping from the previous one.
// ---------------------------------------------------------------------------------------------------

const diagnosisDocument = (effectiveTime: string) => `<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole><id root="urn:workwell:employee" extension="emp-006"/>
    <patient><birthTime value="19750312"/></patient></patientRole></recordTarget>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.24.2.1" extension="2021-08-01"/>
    <entry typeCode="DRIV"><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.135" extension="2021-08-01"/>
      <code code="282291009" codeSystem="2.16.840.1.113883.6.96"/>
      <statusCode code="completed"/>
      ${effectiveTime}
      <value xsi:type="CD" code="44054006" codeSystem="2.16.840.1.113883.6.96"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>
    </observation></entry>
  </section></component></structuredBody></component>
</ClinicalDocument>`;

const conditionFromDoc = (effectiveTime: string) => {
  const entries = importQrda1Document(diagnosisDocument(effectiveTime)).bundle.entry;
  return entries
    .map((e) => e.resource as { resourceType?: string; clinicalStatus?: unknown; abatementDateTime?: string })
    .find((r) => r.resourceType === "Condition");
};

const CLINICAL = "http://terminology.hl7.org/CodeSystem/condition-clinical";

test("import: a CLOSED interval is resolved, and says so beside its own abatement date", () => {
  const condition = conditionFromDoc(`<effectiveTime><low value="20240101"/><high value="20240630"/></effectiveTime>`);
  assert.ok(condition, "the diagnosis imported");
  assert.equal(condition!.abatementDateTime, "2024-06-30", "the interval ended, which this already recorded");
  // The contradiction #594 named: preparation used to stamp `active` on exactly this resource.
  assert.deepEqual(condition!.clinicalStatus, { coding: [{ system: CLINICAL, code: "resolved" }] });
});

test("import: high nullFlavor=UNK is open prevalence, so active is a faithful reading", () => {
  const condition = conditionFromDoc(
    `<effectiveTime><low value="20240101"/><high nullFlavor="UNK"/></effectiveTime>`,
  );
  assert.ok(condition);
  assert.equal(condition!.abatementDateTime, undefined, "no end date, because none is known");
  // The source made an explicit assertion - there is no known end - and that is what licenses this.
  assert.deepEqual(condition!.clinicalStatus, { coding: [{ system: CLINICAL, code: "active" }] });
});

test("import: no high element at all is SILENCE, and nothing is asserted", () => {
  const condition = conditionFromDoc(`<effectiveTime><low value="20240101"/></effectiveTime>`);
  assert.ok(condition);
  assert.equal(condition!.abatementDateTime, undefined);
  // The whole of #594 in one assertion. An absent element and `nullFlavor="UNK"` both yield no end
  // date; only one of them is a statement about the patient. The QI-Core profile goes unsatisfied and
  // the condition is not retrieved, which is the honest outcome for a document that did not say.
  assert.equal(condition!.clinicalStatus, undefined, "not active, not resolved - absent");
});

test("import: the three interval shapes produce three DIFFERENT statuses", () => {
  // Guards the collapse itself rather than each case: `times()` returned no end for both the
  // nullFlavor and the absent form, so any mapping built on its output alone could not separate them
  // however it was written.
  const statuses = [
    `<effectiveTime><low value="20240101"/><high value="20240630"/></effectiveTime>`,
    `<effectiveTime><low value="20240101"/><high nullFlavor="UNK"/></effectiveTime>`,
    `<effectiveTime><low value="20240101"/></effectiveTime>`,
  ].map((t) => JSON.stringify(conditionFromDoc(t)?.clinicalStatus ?? null));
  assert.equal(new Set(statuses).size, 3, `expected three distinct statuses, got ${statuses.join(" | ")}`);
});

test("import: a MALFORMED high value is a parse failure, not an open interval", () => {
  // `20240230` is a date the source asserted and this importer cannot parse - 30 February. The first
  // cut of #594 inferred `endUnknown` from "a <high> exists and produced no date", which is true here
  // too, so it reported the diagnosis as `active`: a status the document never asserted, on a
  // condition whose end date we simply failed to understand, and one that can put the patient into a
  // measure population. It is the nullFlavor that says "open", not our own failure to read a value.
  const condition = conditionFromDoc(`<effectiveTime><low value="20240101"/><high value="20240230"/></effectiveTime>`);
  assert.ok(condition);
  assert.equal(condition!.abatementDateTime, undefined, "nothing parseable to record");
  assert.equal(condition!.clinicalStatus, undefined, "not active, not resolved - the document was not understood");
});

test("import: an EMPTY high element asserts nothing either", () => {
  // No value and no nullFlavor: the element is there but says nothing at all.
  const condition = conditionFromDoc(`<effectiveTime><low value="20240101"/><high/></effectiveTime>`);
  assert.ok(condition);
  assert.equal(condition!.clinicalStatus, undefined);
});

test("import: other nullFlavor spellings are open intervals too, not just UNK", () => {
  // `NI`, `NA`, `ASKU` all say the same thing for this purpose: the source addressed the end and
  // recorded no value for it. Keying on UNK alone would read the rest as silence.
  for (const flavor of ["UNK", "NI", "NA", "ASKU"]) {
    const condition = conditionFromDoc(
      `<effectiveTime><low value="20240101"/><high nullFlavor="${flavor}"/></effectiveTime>`,
    );
    assert.deepEqual(
      condition!.clinicalStatus,
      { coding: [{ system: CLINICAL, code: "active" }] },
      `nullFlavor="${flavor}" is an explicit open interval`,
    );
  }
});

// ---------------------------------------------------------------------------------------------------
// The datatypes the 2027 Cypress decks carry for CMS2, CMS130, CMS137 and CMS165
//
// Shapes copied from `bundle-2026` (Cypress 2026.1.0) patients: a stool test with a text result, a
// blood pressure as two Physical Exam entries, a Medication Order, an Assessment Not Performed with a
// reason, and an encounter carrying an Encounter Diagnosis with a Rank.
// ---------------------------------------------------------------------------------------------------

const deckDocument = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:sdtc="urn:hl7-org:sdtc">
  <recordTarget><patientRole><id extension="deck-1" root="1.3.6.1.4.1.115"/>
    <patient><birthTime value='19731115150000'/></patient></patientRole></recordTarget>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.24.2.1" extension="2021-08-01"/>

    <entry><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.38" extension="2021-08-01"/>
      <id root="1.3.6.1.4.1.115" extension="fobt-1"/>
      <code code="2335-8" codeSystem="2.16.840.1.113883.6.1"/>
      <statusCode code="completed"/>
      <effectiveTime value='20250622143000'/>
      <entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.24.3.87" extension="2019-12-01"/>
        <code code="2335-8" codeSystem="2.16.840.1.113883.6.1"/>
        <statusCode code="completed"/>
        <value xsi:type="ST">Negative</value>
      </observation></entryRelationship>
    </observation></entry>

    <entry><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.59" extension="2021-08-01"/>
      <id root="1.3.6.1.4.1.115" extension="sys-1"/>
      <code code="8480-6" codeSystem="2.16.840.1.113883.6.1"/>
      <statusCode code="completed"/>
      <effectiveTime value='20251210170500'/>
      <value xsi:type="PQ" value="130" unit="mm[Hg]"/>
    </observation></entry>
    <entry><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.59" extension="2021-08-01"/>
      <id root="1.3.6.1.4.1.115" extension="dia-1"/>
      <code code="8462-4" codeSystem="2.16.840.1.113883.6.1"/>
      <statusCode code="completed"/>
      <effectiveTime value='20251210170500'/>
      <value xsi:type="PQ" value="60" unit="mm[Hg]"/>
    </observation></entry>
    <entry><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.59" extension="2021-08-01"/>
      <id root="1.3.6.1.4.1.115" extension="sys-lone"/>
      <code code="8480-6" codeSystem="2.16.840.1.113883.6.1"/>
      <statusCode code="completed"/>
      <effectiveTime value='20250301090000'/>
      <value xsi:type="PQ" value="150" unit="mm[Hg]"/>
    </observation></entry>

    <entry><substanceAdministration classCode="SBADM" moodCode="RQO">
      <templateId root="2.16.840.1.113883.10.20.24.3.47" extension="2021-08-01"/>
      <id root="1.3.6.1.4.1.115" extension="medorder-1"/>
      <statusCode code="active"/>
      <effectiveTime xsi:type="IVL_TS"><low value='20250219173000'/><high value='20250219173000'/></effectiveTime>
      <consumable><manufacturedProduct classCode="MANU"><manufacturedMaterial>
        <code code="854901" codeSystem="2.16.840.1.113883.6.88"/>
      </manufacturedMaterial></manufacturedProduct></consumable>
      <author><templateId root="2.16.840.1.113883.10.20.24.3.155" extension="2019-12-01"/><time value='20250219173000'/></author>
    </substanceAdministration></entry>

    <entry><observation classCode="OBS" moodCode="EVN" negationInd="true">
      <templateId root="2.16.840.1.113883.10.20.24.3.144" extension="2021-08-01"/>
      <id root="1.3.6.1.4.1.115" extension="noscreen-1"/>
      <code code="73832-8" codeSystem="2.16.840.1.113883.6.1"/>
      <statusCode code="completed"/>
      <effectiveTime value='20250816140000'/>
      <author><templateId root="2.16.840.1.113883.10.20.24.3.155" extension="2019-12-01"/><time value='20250816140000'/></author>
      <entryRelationship typeCode="RSON"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.24.3.88" extension="2017-08-01"/>
        <code code="77301-0" codeSystem="2.16.840.1.113883.6.1"/>
        <value code="183932001" codeSystem="2.16.840.1.113883.6.96" xsi:type="CD"/>
      </observation></entryRelationship>
    </observation></entry>

    <entry><encounter classCode="ENC" moodCode="EVN">
      <templateId extension="2021-08-01" root="2.16.840.1.113883.10.20.24.3.23"/>
      <id extension="enc-dx" root="1.3.6.1.4.1.115"/>
      <code code="99202" codeSystem="2.16.840.1.113883.6.12"/>
      <statusCode code="completed"/>
      <effectiveTime><low value='20241128170000'/><high value='20241128173000'/></effectiveTime>
      <entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN">
        <templateId extension="2021-08-01" root="2.16.840.1.113883.10.20.24.3.168"/>
        <code code="29308-4" codeSystem="2.16.840.1.113883.6.1"/>
        <value code="75544000" codeSystem="2.16.840.1.113883.6.96" xsi:type="CD"/>
        <entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.24.3.166" extension="2019-12-01"/>
          <code code="263486008" codeSystem="2.16.840.1.113883.6.96"/>
          <value xsi:type="INT" value="1"/>
        </observation></entryRelationship>
      </observation></entryRelationship>
    </encounter></entry>

  </section></component></structuredBody></component>
</ClinicalDocument>`;

const deckResources = (xml = deckDocument) => {
  const imported = importQrda1Document(xml);
  const all = imported.bundle.entry.map((e) => e.resource as Record<string, any>);
  return { imported, all, byId: (id: string) => all.find((r) => r.id === id) };
};

test("import: each resource keeps its source identifier, root as the system", () => {
  // The FHIR id is root-agnostic; the identifier keeps the assigning authority, as an OID URN.
  const { byId } = deckResources();
  for (const id of ["fobt-1", "sys-lone", "medorder-1", "noscreen-1", "enc-dx"]) {
    assert.deepEqual(byId(id)!.identifier, [{ system: "urn:oid:1.3.6.1.4.1.115", value: id }], id);
  }
  // A blood-pressure panel keeps BOTH readings' source ids (LOCKED §4A.8), which the batch merge matches on.
  assert.deepEqual(byId("sys-1")!.identifier, [
    { system: "urn:oid:1.3.6.1.4.1.115", value: "sys-1" },
    { system: "urn:oid:1.3.6.1.4.1.115", value: "dia-1" },
  ]);
  const condition = byId("enc-dx-dx-1")!;
  assert.equal(condition.identifier, undefined, "a generated Condition has no source identifier, and none is invented");
});

test("import: EVERY mapper keeps its entry's source identifier", () => {
  // Each mapper is listed by the entry it builds, so dropping `identifierOf` from any one of them fails
  // here: Assessment, Symptom, Intervention Performed and Order, Device Order, Medication Active, an
  // inpatient Encounter and a Procedure from the exclusion fixture; a Diagnosis from its own entry.
  const { of } = exclusionResources();
  const all = ["Observation", "Procedure", "ServiceRequest", "DeviceRequest", "MedicationRequest", "Encounter"].flatMap(of);
  for (const id of ["assess-1", "symptom-1", "intervention-1", "order-1", "device-1", "med-1", "enc-inpatient", "proc-icd10pcs"]) {
    assert.deepEqual(all.find((r) => r.id === id)?.identifier, [{ system: "urn:oid:1.3.6.1.4.1.115", value: id }], id);
  }
  const diagnosis = importQrda1Document(deckDocument.replace("  </section></component>", `
    <entry><act classCode="ACT" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.137" extension="2021-08-01"/>
      <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.24.3.135" extension="2021-08-01"/>
        <id root="1.3.6.1.4.1.115" extension="dx-standalone"/>
        <code code="29308-4" codeSystem="2.16.840.1.113883.6.1"/>
        <statusCode code="completed"/>
        <effectiveTime><low value='20240101080000'/></effectiveTime>
        <value xsi:type="CD" code="44054006" codeSystem="2.16.840.1.113883.6.96"/>
      </observation></entryRelationship>
    </act></entry>
  </section></component>`)).bundle.entry.map((e) => e.resource as Record<string, any>).find((r) => r.id === "dx-standalone");
  assert.deepEqual(diagnosis?.identifier, [{ system: "urn:oid:1.3.6.1.4.1.115", value: "dx-standalone" }]);
});

test("import: the identifier's shape follows the CDA id's", () => {
  const encounterWith = (id: string) =>
    deckResources(deckDocument.replace('<id extension="enc-dx" root="1.3.6.1.4.1.115"/>', id)).all.find((r) => r.resourceType === "Encounter")!;
  // A UUID root is a urn:uuid, lower-cased as RFC 4122 compares it.
  assert.deepEqual(encounterWith('<id root="BC01A5D1-3A34-4286-82CC-43EB04C972A7" extension="v1"/>').identifier, [
    { system: "urn:uuid:bc01a5d1-3a34-4286-82cc-43eb04c972a7", value: "v1" },
  ]);
  // A URI root is its own system; a "root" with a space in it is not a URI and gives no identifier.
  assert.deepEqual(encounterWith('<id root="urn:example:visits" extension="v1"/>').identifier, [{ system: "urn:example:visits", value: "v1" }]);
  assert.equal(encounterWith('<id root="my system: x" extension="v1"/>').identifier, undefined);
  // A root alone is a complete identifier (HL7 V3 II): carried as a URI value.
  assert.deepEqual(encounterWith('<id root="3f2504e0-4f89-11d3-9a0c-0305e82c3301"/>').identifier, [
    { system: "urn:ietf:rfc:3986", value: "urn:uuid:3f2504e0-4f89-11d3-9a0c-0305e82c3301" },
  ]);
  // A null-flavored id is the sender saying there is none.
  assert.equal(encounterWith('<id root="1.3.6.1.4.1.115" extension="v1" nullFlavor="UNK"/>').identifier, undefined);
  assert.equal(encounterWith('<id nullFlavor="NI"/>').identifier, undefined);
});

test("import: a TEXT result is kept as valueString — CMS130 asks only that the stool test has a result", () => {
  const fobt = deckResources().byId("fobt-1");
  assert.ok(fobt);
  assert.equal(fobt!.valueString, "Negative");
});

// ---------------------------------------------------------------------------------------------------
// #790: an entry is translated only when it states its template's own mood and status. Every Cypress
// document states exactly those (measured over both decks); anything else did not happen, or was only
// intended, and imported with the mapper's `finished` / `completed` / `final` it could count toward a measure.
// ---------------------------------------------------------------------------------------------------

/** `xml` with the entry whose id is `id` restated: its `moodCode`, or its `statusCode`. */
const restated = (xml: string, id: string, what: "mood" | "status", value: string) => {
  const at = xml.indexOf(`extension="${id}"`);
  assert.ok(at > 0, `no entry ${id}`);
  const [start, attribute] = what === "mood" ? [xml.lastIndexOf('moodCode="', at), 'moodCode="'] : [xml.indexOf('<statusCode code="', at), '<statusCode code="'];
  const end = xml.indexOf('"', start + attribute.length);
  return `${xml.slice(0, start + attribute.length)}${value}${xml.slice(end)}`;
};

const TEMPLATE = "2.16.840.1.113883.10.20.24.3.";
/** Each translated datatype, by an entry of a Cypress-shaped fixture, with its template and what it is not. */
const DATATYPE_ENTRIES = [
  { doc: "exclusion", id: "assess-1", template: "144", type: "Observation", otherMood: "INT", otherStatuses: ["aborted", "cancelled", "active"] },
  { doc: "exclusion", id: "symptom-1", template: "136", type: "Observation", otherMood: "INT", otherStatuses: ["nullified"] },
  { doc: "exclusion", id: "intervention-1", template: "32", type: "Procedure", otherMood: "INT", otherStatuses: ["aborted", "cancelled", "new"] },
  { doc: "exclusion", id: "order-1", template: "31", type: "ServiceRequest", otherMood: "PRP", otherStatuses: ["cancelled", "nullified"] },
  { doc: "exclusion", id: "device-1", template: "9", type: "DeviceRequest", otherMood: "INT", otherStatuses: ["cancelled"] },
  { doc: "exclusion", id: "med-1", template: "41", type: "MedicationRequest", otherMood: "INT", otherStatuses: ["completed", "suspended"] },
  { doc: "exclusion", id: "enc-inpatient", template: "23", type: "Encounter", otherMood: "INT", otherStatuses: ["active", "cancelled"] },
  { doc: "exclusion", id: "proc-icd10pcs", template: "64", type: "Procedure", otherMood: "RQO", otherStatuses: ["aborted", "nullified"] },
  { doc: "deck", id: "fobt-1", template: "38", type: "Observation", otherMood: "RQO", otherStatuses: ["nullified", "active"] },
  { doc: "deck", id: "sys-lone", template: "59", type: "Observation", otherMood: "INT", otherStatuses: ["aborted"] },
  { doc: "deck", id: "medorder-1", template: "47", type: "MedicationRequest", otherMood: "EVN", otherStatuses: ["cancelled", "completed"] },
  { doc: "deck", id: "noscreen-1", template: "144", type: "Observation", otherMood: "INT", otherStatuses: ["aborted"] },
] as const;

test("#790: an entry whose mood or status is not its template's is not translated, and is named", () => {
  for (const entry of DATATYPE_ENTRIES) {
    const source = entry.doc === "exclusion" ? exclusionDocument : deckDocument;
    const imports = (xml: string) => {
      const imported = importQrda1Document(xml);
      const present = imported.bundle.entry.some((e) => (e.resource as { id?: string }).id === entry.id);
      return { present, named: imported.untranslatedTemplates.includes(`${TEMPLATE}${entry.template}`) };
    };
    assert.deepEqual(imports(source), { present: true, named: false }, `${entry.id} imports as written`);
    for (const [what, value] of [["mood", entry.otherMood], ...entry.otherStatuses.map((s) => ["status", s] as const)] as const) {
      const xml = restated(source, entry.id, what, value);
      assert.notEqual(xml, source, `${entry.id}: the fixture must change its ${what}`);
      assert.deepEqual(imports(xml), { present: false, named: true }, `${entry.id} with ${what} ${value}`);
    }
  }
});

test("#790: every datatype the importer translates is checked, and a Diagnosis and a Study too", () => {
  // The table above covers each template the walk maps except Diagnosis and Diagnostic Study, checked here.
  const covered = new Set<string>(DATATYPE_ENTRIES.map((e) => e.template));
  for (const t of ["23", "38", "64", "32", "31", "9", "41", "47", "144", "59", "136"]) assert.ok(covered.has(t), t);
  const diagnosis = (status: string) => diagnosisDocument("<effectiveTime><low value='20240101'/></effectiveTime>").replace('<statusCode code="completed"/>', `<statusCode code="${status}"/>`);
  assert.ok(conditionFromDoc("<effectiveTime><low value='20240101'/></effectiveTime>"), "a completed Diagnosis imports");
  assert.throws(() => importQrda1Document(diagnosis("nullified")), /1 untranslated: 2\.16\.840\.1\.113883\.10\.20\.24\.3\.135/);
  const study = deckDocument.replace('root="2.16.840.1.113883.10.20.24.3.38"', 'root="2.16.840.1.113883.10.20.24.3.18"');
  assert.notEqual(study, deckDocument);
  assert.equal(deckResources(study).byId("fobt-1")?.category[0].coding[0].code, "imaging", "a completed Study imports");
  assert.equal(deckResources(restated(study, "fobt-1", "status", "aborted")).byId("fobt-1"), undefined, "an aborted Study does not");
});

test("#790: a test whose own Results all did not happen is not imported, and is named; one that did gives its value", () => {
  const resultStated = '<code code="2335-8" codeSystem="2.16.840.1.113883.6.1"/>\n        <statusCode code="completed"/>\n        <value xsi:type="ST">Negative</value>';
  assert.ok(deckDocument.includes(resultStated));
  // A preliminary result is `active`; imported `final` with no value, it read as a result-less test (review, #790).
  for (const status of ["active", "aborted", "nullified"]) {
    const xml = deckDocument.replace(resultStated, resultStated.replace('"completed"', `"${status}"`));
    const { imported, byId } = deckResources(xml);
    assert.equal(byId("fobt-1"), undefined, status);
    assert.ok(imported.untranslatedTemplates.includes(`${TEMPLATE}38`), status);
  }
  // Two Results: the value is the one that happened, wherever it sits.
  const secondResult = `<entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.24.3.87" extension="2019-12-01"/>
        <code code="2335-8" codeSystem="2.16.840.1.113883.6.1"/>
        <statusCode code="completed"/>
        <value xsi:type="ST">Positive</value>
      </observation></entryRelationship>
    </observation></entry>`;
  const twoResults = deckDocument
    .replace(resultStated, resultStated.replace('"completed"', '"aborted"'))
    .replace("      </observation></entryRelationship>\n    </observation></entry>", `      </observation></entryRelationship>\n      ${secondResult}`);
  assert.equal(deckResources(twoResults).byId("fobt-1")?.valueString, "Positive", "the aborted first Result is passed over");
  assert.equal(deckResources().byId("fobt-1")!.valueString, "Negative", "a completed Result is the value");
});

test("#796: only a LAB is its result; a study keeps its act, and an entry's own value stays its value", () => {
  // Codex on #796: the Result gate dropped a whole Diagnostic Study, Assessment or Physical Exam over a
  // pending nested Result, though those state the act itself and may state their own value.
  const resultStated = '<code code="2335-8" codeSystem="2.16.840.1.113883.6.1"/>\n        <statusCode code="completed"/>\n        <value xsi:type="ST">Negative</value>';
  const pending = deckDocument.replace(resultStated, resultStated.replace('"completed"', '"active"'));
  assert.notEqual(pending, deckDocument);
  const asStudy = (xml: string) => xml.replace('root="2.16.840.1.113883.10.20.24.3.38"', 'root="2.16.840.1.113883.10.20.24.3.18"');
  const withOwnValue = (xml: string) =>
    xml.replace("<effectiveTime value='20250622143000'/>", `<effectiveTime value='20250622143000'/>\n      <value xsi:type="ST">Positive</value>`);
  assert.notEqual(asStudy(pending), pending);
  assert.notEqual(withOwnValue(pending), pending);
  const study = deckResources(asStudy(pending)).byId("fobt-1");
  assert.deepEqual([study?.status, study?.valueString], ["final", undefined], "a study whose result is pending was still performed");
  assert.equal(deckResources(withOwnValue(asStudy(pending))).byId("fobt-1")?.valueString, "Positive", "a study keeps its own value");
  assert.equal(deckResources(withOwnValue(pending)).byId("fobt-1")?.valueString, "Positive", "so does a lab that states one");
  assert.equal(deckResources(pending).byId("fobt-1"), undefined, "a lab whose only result is pending is still not imported");
  const nullValue = pending.replace("<effectiveTime value='20250622143000'/>", `<effectiveTime value='20250622143000'/>\n      <value xsi:type="ST" nullFlavor="NA"/>`);
  assert.notEqual(nullValue, pending);
  assert.equal(deckResources(nullValue).byId("fobt-1"), undefined, "a null-flavored value of its own is no value either");
});

test("#790: an encounter's diagnosis is imported only as a stated fact", () => {
  const diagnosis = '<entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN">\n        <templateId extension="2021-08-01" root="2.16.840.1.113883.10.20.24.3.168"/>';
  assert.ok(deckDocument.includes(diagnosis));
  const conditions = (xml: string) => deckResources(xml).all.filter((r) => r.resourceType === "Condition").length;
  assert.equal(conditions(deckDocument), 1, "as written, the encounter's diagnosis is a Condition");
  for (const [label, restatedDiagnosis] of [
    ["negated", diagnosis.replace('moodCode="EVN">', 'moodCode="EVN" negationInd="true">')],
    ["intended", diagnosis.replace('moodCode="EVN">', 'moodCode="INT">')],
    ["under a negated relationship", diagnosis.replace('typeCode="REFR">', 'typeCode="REFR" negationInd="true">')],
  ] as const) {
    assert.notEqual(restatedDiagnosis, diagnosis, label);
    assert.equal(conditions(deckDocument.replace(diagnosis, restatedDiagnosis)), 0, label);
  }
});

test("#790: a skipped entry blocks a pair only as a blood-pressure reading, wherever it sits in the document", () => {
  // An aborted procedure states no time, which as a reading could be any time; it is no reading.
  const untimed = sitedProcedure("").replace('<effectiveTime value="20240405083000"/>', "").replace('<statusCode code="completed"/>', '<statusCode code="aborted"/>');
  assert.equal(paired(sys(), dia(), untimed, sitedProcedure("")).panels.length, 1, "a non-reading never blocks");
  // Before the pair, a skipped reading's place is taken by the next one imported; it still blocks.
  const aborted = exam({ id: "s0", code: "8480-6" }).replace('<statusCode code="completed"/>', '<statusCode code="aborted"/>');
  assert.equal(paired(aborted, sys(), dia()).panels.length, 0, "an aborted systolic before the pair");
  assert.equal(paired(sys(), dia(), aborted).panels.length, 0, "and after it");
});

test("import: a blood pressure stated as two readings at one time is one US Core panel; a lone reading stays a reading (LOCKED §4A.8)", () => {
  const { all, byId } = deckResources();
  const panel = byId("sys-1")!;
  assert.deepEqual(panel.code.coding.map((c: { code: string }) => c.code), ["85354-9"]);
  assert.equal(panel.category[0].coding[0].code, "vital-signs");
  assert.equal(panel.status, "final");
  assert.equal(panel.valueQuantity, undefined, "a panel carries its readings as components, not a value");
  assert.deepEqual(
    panel.component.map((c: { code: { coding: Array<{ code: string }> }; valueQuantity: unknown }) => [c.code.coding[0]!.code, c.valueQuantity]),
    [
      ["8480-6", { value: 130, unit: "mm[Hg]", system: "http://unitsofmeasure.org", code: "mm[Hg]" }],
      ["8462-4", { value: 60, unit: "mm[Hg]", system: "http://unitsofmeasure.org", code: "mm[Hg]" }],
    ],
  );
  assert.equal(panel.encounter, undefined, "no encounter is inferred");
  assert.equal(byId("dia-1"), undefined, "the diastolic reading is inside the panel, not beside it");
  const lone = byId("sys-lone")!;
  assert.deepEqual([lone.category[0].coding[0].code, lone.code.coding[0].code, lone.valueQuantity.value, lone.component], ["exam", "8480-6", 150, undefined]);
  assert.equal(all.filter((r) => JSON.stringify(r.code ?? {}).includes("85354-9")).length, 1);
});

test("import: a Medication Order is an ORDER, never an active medication", () => {
  const order = deckResources().byId("medorder-1");
  assert.ok(order);
  assert.equal(order!.resourceType, "MedicationRequest");
  assert.equal(order!.intent, "order");
  // `isMedicationOrder` admits active|completed; `isMedicationActive` is Equal 'active'. `completed`
  // keeps an order out of the dementia-medication exclusion, which reads active medications.
  assert.equal(order!.status, "completed");
  assert.equal(order!.authoredOn, "2025-02-19T17:30:00Z");
  assert.equal(order!.medicationCodeableConcept.coding[0].code, "854901");
});

test("import: an Assessment Not Performed WITH a reason is a cancelled Observation carrying the reason", () => {
  const { imported, byId } = deckResources();
  const notDone = byId("noscreen-1");
  assert.ok(notDone, "CMS2's denominator exception reads it");
  assert.equal(notDone!.status, "cancelled", "and no positive screening read admits a cancelled one");
  assert.equal(notDone!.code.coding[0].code, "73832-8");
  assert.equal(notDone!.issued, "2025-08-16T14:00:00Z");
  assert.deepEqual(notDone!.extension, [
    {
      url: "http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-notDoneReason",
      valueCodeableConcept: { coding: [{ system: "http://snomed.info/sct", code: "183932001" }] },
    },
  ]);
  assert.equal(notDone!.valueCodeableConcept, undefined);
  assert.deepEqual(imported.untranslatedTemplates, []);
});

test("import: a negation WITHOUT a reason stays untranslated — a reasonless 'not done' is not an exception", () => {
  const reasonless = deckDocument.replace(/<entryRelationship typeCode="RSON">[\s\S]*?<\/entryRelationship>/, "");
  assert.notEqual(reasonless, deckDocument);
  const { imported, byId } = deckResources(reasonless);
  assert.equal(byId("noscreen-1"), undefined);
  assert.ok(imported.untranslatedTemplates.includes("2.16.840.1.113883.10.20.24.3.144"));
});

test("import: an Encounter Diagnosis becomes an encounter-diagnosis Condition the encounter references", () => {
  const { byId } = deckResources();
  const encounter = byId("enc-dx");
  assert.ok(encounter);
  const condition = byId("enc-dx-dx-1");
  assert.ok(condition, "one Condition per diagnosis");
  assert.equal(condition!.code.coding[0].code, "75544000");
  assert.equal(condition!.category[0].coding[0].code, "encounter-diagnosis");
  assert.equal(condition!.onsetDateTime, undefined, "an Encounter Diagnosis has no onset of its own, so none is given");
  assert.equal(condition!.verificationStatus, undefined, "nor a verification status: none is minted");
  // CQMCommon.encounterDiagnosis (CMS137's history) follows reasonReference; `diagnosis` keeps the rank.
  assert.deepEqual(encounter!.reasonReference, [{ reference: "Condition/enc-dx-dx-1" }]);
  assert.deepEqual(encounter!.diagnosis, [{ condition: { reference: "Condition/enc-dx-dx-1" }, rank: 1 }]);
});

test("import: a REPEATED encounter id still gives every diagnosis its own Condition id", () => {
  // The library resolves each reference with `singleton from`, which throws on two matches, so two
  // Conditions sharing an id would turn the subject into an evaluation error.
  const encounterEntry = deckDocument.slice(deckDocument.indexOf("    <entry><encounter"), deckDocument.indexOf("</encounter></entry>") + "</encounter></entry>".length);
  const repeated = deckDocument.replace(encounterEntry, `${encounterEntry}\n${encounterEntry.replace('code="75544000"', 'code="5602001"')}`);
  assert.notEqual(repeated, deckDocument);
  const { all } = deckResources(repeated);
  const conditions = all.filter((r) => r.resourceType === "Condition");
  assert.equal(conditions.length, 2);
  assert.equal(new Set(conditions.map((c) => c.id)).size, 2, "two diagnoses, two ids");
  const encounters = all.filter((r) => r.resourceType === "Encounter");
  const codeOf = (reference: string) => conditions.find((c) => `Condition/${c.id}` === reference)!.code.coding[0].code;
  assert.deepEqual(encounters.map((e) => codeOf(e.reasonReference[0].reference)), ["75544000", "5602001"], "each encounter keeps its own");
});

test("import: a generated diagnosis id never shadows a Condition the document itself named", () => {
  // A standalone Diagnosis whose own id is exactly what the encounter's diagnosis would be called, and
  // placed AFTER the encounter, so it is not yet known when the encounter is read.
  const diagnosisEntry = `
    <entry><act classCode="ACT" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.137" extension="2021-08-01"/>
      <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.24.3.135" extension="2021-08-01"/>
        <id root="1.3.6.1.4.1.115" extension="enc-dx-dx-1"/>
        <code code="29308-4" codeSystem="2.16.840.1.113883.6.1"/>
        <statusCode code="completed"/>
        <effectiveTime><low value='20240101080000'/></effectiveTime>
        <value xsi:type="CD" code="44054006" codeSystem="2.16.840.1.113883.6.96"/>
      </observation></entryRelationship>
    </act></entry>`;
  const shadowed = deckDocument.replace("  </section></component>", `${diagnosisEntry}\n  </section></component>`);
  assert.notEqual(shadowed, deckDocument);
  const { all } = deckResources(shadowed);
  const conditions = all.filter((r) => r.resourceType === "Condition");
  assert.equal(conditions.length, 2);
  assert.equal(new Set(conditions.map((c) => c.id)).size, 2, "no two Conditions share an id");
  const encounter = all.find((r) => r.id === "enc-dx")!;
  const linked = conditions.find((c) => `Condition/${c.id}` === encounter.reasonReference[0].reference)!;
  assert.equal(linked.code.coding[0].code, "75544000", "the encounter still points at its own diagnosis");
});

test("import: an encounter id that is not a valid FHIR id still yields a resolvable Condition id", () => {
  const odd = deckDocument.replace('extension="enc-dx"', 'extension="visit/2024/11/28"');
  assert.notEqual(odd, deckDocument);
  const { all } = deckResources(odd);
  const condition = all.find((r) => r.resourceType === "Condition")!;
  assert.match(condition.id, /^[A-Za-z0-9.-]{1,64}$/);
  const encounter = all.find((r) => r.resourceType === "Encounter")!;
  assert.equal(encounter.reasonReference[0].reference, `Condition/${condition.id}`);
});


// ---------------------------------------------------------------------------------------------------
// Anatomical Location Site (#784): `<targetSiteCode>` ⇄ `bodySite`, on a Diagnosis and a Procedure.
// CMS125 reads it in both years, so a dropped site silently keeps a bilateral mastectomy in the
// denominator.
// ---------------------------------------------------------------------------------------------------

const SNOMED_OID = "2.16.840.1.113883.6.96";

const sitedDocument = (entries: string) => `<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <recordTarget><patientRole><id root="urn:workwell:employee" extension="emp-006"/>
    <patient><birthTime value="19750312"/></patient></patientRole></recordTarget>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.24.2.1" extension="2021-08-01"/>
    ${entries}
  </section></component></structuredBody></component>
</ClinicalDocument>`;

const sitedDiagnosis = (sites: string) => `<entry typeCode="DRIV"><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.135" extension="2021-08-01"/>
      <code code="29308-4" codeSystem="2.16.840.1.113883.6.1"/>
      <statusCode code="completed"/>
      <effectiveTime><low value="20200301"/><high nullFlavor="UNK"/></effectiveTime>
      <value xsi:type="CD" code="248802009" codeSystem="${SNOMED_OID}"/>
      ${sites}
    </observation></entry>`;

const sitedProcedure = (sites: string, template = "2.16.840.1.113883.10.20.24.3.64") => `<entry typeCode="DRIV"><procedure classCode="PROC" moodCode="EVN">
      <templateId root="${template}" extension="2021-08-01"/>
      <code code="172043006" codeSystem="${SNOMED_OID}"/>
      <statusCode code="completed"/>
      <effectiveTime value="20240405083000"/>
      ${sites}
    </procedure></entry>`;

const importedOfType = (xml: string, type: string) =>
  importQrda1Document(xml).bundle.entry
    .map((e) => e.resource as Record<string, unknown>)
    .filter((r) => r.resourceType === type);

const site = (code: string) => `<targetSiteCode code="${code}" codeSystem="${SNOMED_OID}"/>`;
const snomed = (code: string) => ({ coding: [{ system: "http://snomed.info/sct", code }] });

test("import: a Diagnosis's targetSiteCode becomes Condition.bodySite (#784)", () => {
  const [condition] = importedOfType(sitedDocument(sitedDiagnosis(site("24028007"))), "Condition");
  assert.deepEqual(condition!.bodySite, [snomed("24028007")]);
});

test("import: a Procedure's targetSiteCode becomes Procedure.bodySite, and so does an Intervention's (#784)", () => {
  const [procedure] = importedOfType(sitedDocument(sitedProcedure(site("361716006"))), "Procedure");
  assert.deepEqual(procedure!.bodySite, [snomed("361716006")]);
  const [intervention] = importedOfType(
    sitedDocument(sitedProcedure(site("361715005"), "2.16.840.1.113883.10.20.24.3.32")),
    "Procedure",
  );
  assert.deepEqual(intervention!.bodySite, [snomed("361715005")]);
});

test("import: every site is kept, in order, and a translation rides along as a coding (#784)", () => {
  const both = `${site("361716006")}
      <targetSiteCode code="361715005" codeSystem="${SNOMED_OID}"><translation code="80248007" codeSystem="${SNOMED_OID}"/></targetSiteCode>`;
  const [procedure] = importedOfType(sitedDocument(sitedProcedure(both)), "Procedure");
  assert.deepEqual(procedure!.bodySite, [
    snomed("361716006"),
    { coding: [{ system: "http://snomed.info/sct", code: "361715005" }, { system: "http://snomed.info/sct", code: "80248007" }] },
  ]);
});

test("import: no site, or only an unmapped one, leaves bodySite ABSENT rather than empty (#784)", () => {
  const [none] = importedOfType(sitedDocument(sitedDiagnosis("")), "Condition");
  assert.ok(!("bodySite" in none!), "an absent field stays absent");
  const [unmapped] = importedOfType(sitedDocument(sitedDiagnosis(`<targetSiteCode code="X" codeSystem="1.2.3.4"/>`)), "Condition");
  assert.ok(!("bodySite" in unmapped!), "an unmapped system is dropped, as everywhere else");
  const [mixed] = importedOfType(
    sitedDocument(sitedDiagnosis(`<targetSiteCode code="X" codeSystem="1.2.3.4"/>${site("7771000")}`)),
    "Condition",
  );
  assert.deepEqual(mixed!.bodySite, [snomed("7771000")]);
});

test("import: a site on a NESTED element is not lifted onto its parent (#784)", () => {
  // The procedure states no site; a nested observation does.
  const nested = `<entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN">
        <code code="29308-4" codeSystem="2.16.840.1.113883.6.1"/>${site("24028007")}
      </observation></entryRelationship>`;
  const [procedure] = importedOfType(sitedDocument(sitedProcedure(nested)), "Procedure");
  assert.ok(!("bodySite" in procedure!));
});

const sitedBundle = {
  ...sourceBundle,
  entry: [
    sourceBundle.entry[0]!,
    {
      resource: {
        resourceType: "Condition", id: "cond-sited",
        code: { coding: [{ system: "http://snomed.info/sct", code: "248802009" }] },
        bodySite: [snomed("7771000")],
        onsetDateTime: "2020-03-01T00:00:00Z",
      },
    },
    {
      resource: {
        resourceType: "Procedure", id: "proc-sited", status: "completed",
        code: { coding: [{ system: "http://snomed.info/sct", code: "172043006" }] },
        bodySite: [snomed("361716006"), snomed("361715005")],
        performedDateTime: "2024-04-05T08:30:00Z",
      },
    },
  ],
};

test("round trip: Condition and Procedure body sites survive export and import (#784)", () => {
  const back = importQrda1Document(buildQrda1Document(run, "cms125", outcome(officialEvidence), sitedBundle));
  const strip = (cc: unknown) => (cc as Array<{ coding: Array<{ system: string; code: string }> }>)
    .map((c) => ({ coding: c.coding.map(({ system, code }) => ({ system, code })) }));
  assert.deepEqual(strip(byType(back, "Condition")[0]!.bodySite), [snomed("7771000")]);
  assert.deepEqual(strip(byType(back, "Procedure")[0]!.bodySite), [snomed("361716006"), snomed("361715005")]);
});

test("export: targetSiteCode sits where the CDA schema orders it, and only where a site exists (#784)", () => {
  const xml = buildQrda1Document(run, "cms125", outcome(officialEvidence), sitedBundle);
  // Observation: … value, interpretationCode, methodCode, targetSiteCode, so directly after <value>.
  assert.match(xml, /<value xsi:type="CD" code="248802009"[^>]*\/>\s*<targetSiteCode code="7771000" codeSystem="2\.16\.840\.1\.113883\.6\.96"[^>]*\/>\s*<\/observation>/);
  // Procedure: … effectiveTime, priorityCode, languageCode, methodCode, approachSiteCode, targetSiteCode.
  assert.match(xml, /<effectiveTime value="[^"]+"\/>\s*<targetSiteCode code="361716006"[^>]*\/>\s*<targetSiteCode code="361715005"[^>]*\/>\s*<\/procedure>/);
  assert.equal((xml.match(/<targetSiteCode/g) ?? []).length, 3);
  const unsited = buildQrda1Document(run, "cms125", outcome(officialEvidence), sourceBundle);
  assert.ok(!unsited.includes("<targetSiteCode"), "a resource without a site writes none");
});

test("round trip: a site with several codings keeps every mapped one, as translations (Codex, #785)", () => {
  // Imported from a <targetSiteCode> with a <translation>, exported, imported again: a measure that
  // matches the second coding must still find it.
  const first = importQrda1Document(sitedDocument(sitedProcedure(
    `<targetSiteCode code="361715005" codeSystem="${SNOMED_OID}"><translation code="80248007" codeSystem="${SNOMED_OID}"/><translation code="X" codeSystem="1.2.3.4"/></targetSiteCode>`,
  ))).bundle;
  const xml = buildQrda1Document(run, "cms125", outcome(officialEvidence), { ...sourceBundle, entry: [sourceBundle.entry[0]!, ...first.entry.filter((e) => (e.resource as { resourceType: string }).resourceType === "Procedure")] });
  assert.match(xml, /<targetSiteCode code="361715005"[^>]*>\s*<translation code="80248007" codeSystem="2\.16\.840\.1\.113883\.6\.96"[^>]*\/>\s*<\/targetSiteCode>/);
  const [procedure] = importedOfType(xml, "Procedure");
  assert.deepEqual(procedure!.bodySite, [
    { coding: [{ system: "http://snomed.info/sct", code: "361715005" }, { system: "http://snomed.info/sct", code: "80248007" }] },
  ]);
});

// ---------------------------------------------------------------------------------------------------
// Blood-pressure pairing (LOCKED §4A.8): two Physical Exam readings become one US Core panel only when
// every condition holds. Each test below breaks exactly one condition and expects two readings back.
// ---------------------------------------------------------------------------------------------------

const exam = (o: {
  id: string;
  code: string;
  time?: string;
  value?: string;
  extra?: string;
  negated?: boolean;
}) => `<entry><observation classCode="OBS" moodCode="EVN"${o.negated ? ' negationInd="true"' : ""}>
      <templateId root="2.16.840.1.113883.10.20.22.4.13" extension="2014-06-09"/>
      <templateId root="2.16.840.1.113883.10.20.24.3.59" extension="2021-08-01"/>
      <id root="1.3.6.1.4.1.115" extension="${o.id}"/>
      <code code="${o.code}" codeSystem="2.16.840.1.113883.6.1"/>
      <statusCode code="completed"/>
      ${o.time ?? "<effectiveTime value='20250219171000'/>"}
      ${o.value ?? `<value xsi:type="PQ" value="${o.code === "8480-6" ? 130 : 80}" unit="mm[Hg]"/>`}
      ${o.extra ?? ""}
    </observation></entry>`;

const paired = (...entries: string[]) => {
  const imported = importQrda1Document(sitedDocument(entries.join("\n")));
  const observations = imported.bundle.entry.map((e) => e.resource as Record<string, any>).filter((r) => r.resourceType === "Observation");
  const panels = observations.filter((r) => JSON.stringify(r.code).includes("85354-9"));
  return { panels, readings: observations.length - panels.length, unpaired: imported.unpairedBloodPressureReadings };
};

const sys = (extra: Partial<Parameters<typeof exam>[0]> = {}) => exam({ id: "s", code: "8480-6", ...extra });
const dia = (extra: Partial<Parameters<typeof exam>[0]> = {}) => exam({ id: "d", code: "8462-4", ...extra });

test("§4A.8 baseline: one systolic and one diastolic at one instant with a time of day pair into one panel", () => {
  const { panels, readings, unpaired } = paired(sys(), dia());
  assert.deepEqual([panels.length, readings, unpaired], [1, 0, 0]);
  assert.equal(panels[0]!.effectiveDateTime, "2025-02-19T17:10:00Z");
});

test("§4A.8: a date with no time of day is never paired", () => {
  const day = "<effectiveTime value='20250219'/>";
  assert.deepEqual(Object.values(paired(sys({ time: day }), dia({ time: day }))).map((v) => (Array.isArray(v) ? v.length : v)), [0, 2, 2]);
});

test("§4A.8: readings at different times are never paired", () => {
  const { panels, unpaired } = paired(sys(), dia({ time: "<effectiveTime value='20250219171100'/>" }));
  assert.deepEqual([panels.length, unpaired], [0, 2]);
});

test("§4A.8: an identical interval pairs, a different one does not", () => {
  const span = "<effectiveTime><low value='20250219171000'/><high value='20250219171500'/></effectiveTime>";
  const same = paired(sys({ time: span }), dia({ time: span }));
  assert.equal(same.panels.length, 1);
  assert.deepEqual(same.panels[0]!.effectivePeriod, { start: "2025-02-19T17:10:00Z", end: "2025-02-19T17:15:00Z" });
  const other = "<effectiveTime><low value='20250219171000'/><high value='20250219171600'/></effectiveTime>";
  assert.equal(paired(sys({ time: span }), dia({ time: other })).panels.length, 0);
});

test("§4A.8: two systolics at the time make it ambiguous, so nothing pairs", () => {
  const { panels, unpaired } = paired(sys(), exam({ id: "s2", code: "8480-6" }), dia());
  assert.deepEqual([panels.length, unpaired], [0, 3]);
});

test("§4A.8: a null-flavored, unitless or other-unit value is never paired", () => {
  for (const value of [
    `<value xsi:type="PQ" nullFlavor="UNK"/>`,
    `<value xsi:type="INT" value="80"/>`,
    `<value xsi:type="PQ" value="10.7" unit="kPa"/>`,
  ]) {
    const { panels, unpaired } = paired(sys(), dia({ value }));
    assert.deepEqual([panels.length, unpaired], [0, 2], value);
  }
});

test("§4A.8: a negated reading is not imported, so its partner stays a lone reading", () => {
  const { panels, readings, unpaired } = paired(sys({ negated: true }), dia());
  assert.deepEqual([panels.length, readings, unpaired], [0, 1, 1]);
});

test("§4A.8: a conflicting stated method keeps the readings apart; the same method on both pairs", () => {
  const method = (code: string) => `<methodCode code="${code}" codeSystem="2.16.840.1.113883.6.96"/>`;
  assert.equal(paired(sys({ extra: method("37931006") }), dia({ extra: method("17146006") })).panels.length, 0);
  assert.equal(paired(sys({ extra: method("37931006") }), dia()).panels.length, 0, "stated on one only is not the same");
  assert.equal(paired(sys({ extra: method("37931006") }), dia({ extra: method("37931006") })).panels.length, 1);
});

test("§4A.8: a conflicting stated performer keeps the readings apart", () => {
  const by = (ext: string) => `<performer><assignedEntity><id root="2.16.840.1.113883.4.6" extension="${ext}"/></assignedEntity></performer>`;
  assert.equal(paired(sys({ extra: by("111") }), dia({ extra: by("222") })).panels.length, 0);
  assert.equal(paired(sys({ extra: by("111") }), dia({ extra: by("111") })).panels.length, 1);
});

test("§4A.8: a panel round-trips through export and import as one panel, never as a lab test", () => {
  const bundle = {
    ...sourceBundle,
    entry: [
      sourceBundle.entry[0]!,
      {
        resource: {
          resourceType: "Observation", id: "bp-1", status: "final",
          category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] }],
          code: { coding: [{ system: "http://loinc.org", code: "85354-9" }] },
          effectiveDateTime: "2025-06-01T10:00:00Z",
          component: [
            { code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] }, valueQuantity: { value: 128, unit: "mm[Hg]", system: "http://unitsofmeasure.org", code: "mm[Hg]" } },
            { code: { coding: [{ system: "http://loinc.org", code: "8462-4" }] }, valueQuantity: { value: 78, unit: "mm[Hg]", system: "http://unitsofmeasure.org", code: "mm[Hg]" } },
          ],
        },
      },
    ],
  };
  const xml = buildQrda1Document(run, "cms125", outcome(officialEvidence), bundle);
  assert.ok(!xml.includes("85354-9"), "QDM states a blood pressure as its two readings, never as a panel code");
  assert.equal((xml.match(/2\.16\.840\.1\.113883\.10\.20\.24\.3\.59/g) ?? []).length, 2, "two Physical Exam, Performed entries");
  assert.ok(!xml.includes("2.16.840.1.113883.10.20.24.3.38"), "not a Laboratory Test, Performed");
  const back = importQrda1Document(xml);
  assert.equal(back.unpairedBloodPressureReadings, 0);
  const panels = back.bundle.entry.map((e) => e.resource as Record<string, any>).filter((r) => JSON.stringify(r.code ?? {}).includes("85354-9"));
  assert.equal(panels.length, 1);
  assert.deepEqual(panels[0]!.component.map((c: { valueQuantity: { value: number } }) => c.valueQuantity.value), [128, 78]);
});

test("§4A.8: an instant and an interval with the same low and an unknown high are not the same time (Codex, #787)", () => {
  // Both become one FHIR effectiveDateTime on import, so the time must be compared as the document wrote it.
  const open = "<effectiveTime><low value='20250219171000'/><high nullFlavor='UNK'/></effectiveTime>";
  const { panels, unpaired } = paired(sys(), dia({ time: open }));
  assert.deepEqual([panels.length, unpaired], [0, 2]);
});

test("§4A.8: only an instant or a closed interval pairs; an open, exclusive or reversed one does not (Codex, #787)", () => {
  // Each reading would import as an instant at its low, so a panel built from it would state a time the
  // document did not. Both readings state the same time in every case.
  for (const time of [
    "<effectiveTime><low value='20250219171000'/><high nullFlavor='UNK'/></effectiveTime>",
    "<effectiveTime><low value='20250219171000'/></effectiveTime>",
    "<effectiveTime><low value='20250219171000' inclusive='false'/><high value='20250219171500'/></effectiveTime>",
    "<effectiveTime><low value='20250219171000'/><high value='20250219171500' nullFlavor='UNK'/></effectiveTime>",
    "<effectiveTime><low value='20250219171500'/><high value='20250219171000'/></effectiveTime>",
    "<effectiveTime><low value='20250219171000.9'/><high value='20250219171000.1'/></effectiveTime>",
    "<effectiveTime><low value='20250219171000'/><high value='20250219'/></effectiveTime>",
    "<effectiveTime><low value='20250219171000'/><high value='20250219171500'/><width value='5' unit='min'/></effectiveTime>",
    "<effectiveTime value='20250219171000'><low value='20250219171000'/></effectiveTime>",
  ]) {
    const { panels, readings, unpaired } = paired(sys({ time }), dia({ time }));
    assert.deepEqual([panels.length, readings, unpaired], [0, 2, 2], time);
  }
  const inclusive = "<effectiveTime><low value='20250219171000' inclusive='true'/><high value='20250219171500'/></effectiveTime>";
  assert.equal(paired(sys({ time: inclusive }), dia({ time: inclusive })).panels.length, 1, "an inclusive bound is a Period's own");
});

test("§4A.8: the panel's time is the document's, to the fraction of a second and in its own offset (Codex + review, #787)", () => {
  const span = "<effectiveTime><low value='20250219121000.25-0500'/><high value='20250219121500.5-0500'/></effectiveTime>";
  const { panels } = paired(sys({ time: span }), dia({ time: span }));
  assert.deepEqual(panels[0]!.effectivePeriod, { start: "2025-02-19T12:10:00.25-05:00", end: "2025-02-19T12:15:00.5-05:00" });
  assert.equal(panels[0]!.effectiveDateTime, undefined);
  // CMS165 reads a reading's day in its own offset: 20:00 on 31 December in New York stays 31 December.
  const evening = "<effectiveTime value='20251231200000-0500'/>";
  assert.equal(paired(sys({ time: evening }), dia({ time: evening })).panels[0]!.effectiveDateTime, "2025-12-31T20:00:00-05:00");
  const noZone = "<effectiveTime value='20251231200000'/>";
  assert.equal(paired(sys({ time: noZone }), dia({ time: noZone })).panels[0]!.effectiveDateTime, "2025-12-31T20:00:00Z", "no offset: the importer's UTC convention");
});

test("§4A.8: a method in a code system the importer does not map is still a stated method (Codex, #787)", () => {
  const unknown = (code: string) => `<methodCode code="${code}" codeSystem="1.2.3.4.5"/>`;
  assert.equal(paired(sys({ extra: unknown("A") }), dia()).panels.length, 0, "stated on one, absent on the other");
  assert.equal(paired(sys({ extra: unknown("A") }), dia({ extra: unknown("B") })).panels.length, 0, "two different methods");
  assert.equal(paired(sys({ extra: unknown("A") }), dia({ extra: unknown("A") })).panels.length, 1, "the same method on both");
});

test("an empty or blank PQ value imports as no result, never as zero; so it never pairs (Codex, #787)", () => {
  for (const blank of ["", " "]) {
    const value = `<value xsi:type="PQ" value="${blank}" unit="mm[Hg]"/>`;
    const { panels, unpaired } = paired(sys({ value }), dia({ value }));
    assert.deepEqual([panels.length, unpaired], [0, 2], JSON.stringify(blank));
    const [reading] = importedOfType(sitedDocument(sys({ value })), "Observation");
    assert.equal(reading!.valueQuantity, undefined, "no number was stated, so none is imported");
  }
});

test("§4A.8: readings sharing an unparseable timestamp share no time (Codex, #787)", () => {
  const bad = "<effectiveTime value='20251301120000'/>";
  const { panels, unpaired } = paired(sys({ time: bad }), dia({ time: bad }));
  assert.deepEqual([panels.length, unpaired], [0, 2]);
  const badHigh = "<effectiveTime><low value='20250219171000'/><high value='20251301120000'/></effectiveTime>";
  assert.equal(paired(sys({ time: badHigh }), dia({ time: badHigh })).panels.length, 0);
});

test("§4A.8: performers are compared by everything stated, not only a null-flavored id (Codex, #787)", () => {
  const by = (name: string) =>
    `<performer><assignedEntity><id nullFlavor="UNK"/><assignedPerson><name><given>${name}</given></name></assignedPerson></assignedEntity></performer>`;
  assert.equal(paired(sys({ extra: by("Ana") }), dia({ extra: by("Ben") })).panels.length, 0);
  assert.equal(paired(sys({ extra: by("Ana") }), dia({ extra: by("Ana") })).panels.length, 1);
});

test("an impossible calendar date is no date: it is not rolled over to the next month (Codex, #787)", () => {
  // `new Date` turns 30 February into 2 March. Neither the reading's time nor a pair may come from it.
  const feb30 = "<effectiveTime value='20250230120000'/>";
  const { panels, unpaired } = paired(sys({ time: feb30 }), dia({ time: feb30 }));
  assert.deepEqual([panels.length, unpaired], [0, 2]);
  const [reading] = importedOfType(sitedDocument(sys({ time: feb30 })), "Observation");
  assert.equal(reading!.effectiveDateTime, undefined, "no date the document did not state");
  const [real] = importedOfType(sitedDocument(sys({ time: "<effectiveTime value='20250228120000-0500'/>" })), "Observation");
  assert.equal(real!.effectiveDateTime, "2025-02-28T12:00:00-05:00", "a real date with an offset still parses");
});

test("negationInd=\"1\" is a negation, exactly as \"true\" is (Codex, #787)", () => {
  const negated = (o: Parameters<typeof exam>[0]) => exam(o).replace('moodCode="EVN">', 'moodCode="EVN" negationInd="1">');
  const { panels, readings } = paired(negated({ id: "s", code: "8480-6" }), negated({ id: "d", code: "8462-4" }), sys({ id: "keep" }));
  assert.deepEqual([panels.length, readings], [0, 1], "only the positive reading is imported");
});

test("§4A.8: an hour without minutes is not a time two readings can share, and an hour of 99 is no timestamp (Codex, #787)", () => {
  for (const value of ["2025010112", "2025010199"]) {
    const time = `<effectiveTime value='${value}'/>`;
    assert.equal(paired(sys({ time }), dia({ time })).panels.length, 0, value);
  }
  const [reading] = importedOfType(sitedDocument(sys({ time: "<effectiveTime value='2025010199'/>" })), "Observation");
  assert.equal(reading!.effectiveDateTime, undefined, "an impossible hour is not quietly dropped to a date");
});

const panelOf = (status: string, systolicCodings: Array<{ system: string; code: string }>) => ({
  ...sourceBundle,
  entry: [
    sourceBundle.entry[0]!,
    {
      resource: {
        resourceType: "Observation", id: "bp-x", status,
        category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] }],
        code: { coding: [{ system: "http://loinc.org", code: "85354-9" }] },
        effectiveDateTime: "2025-06-01T10:00:00Z",
        component: [
          { code: { coding: systolicCodings }, valueQuantity: { value: 128, unit: "mm[Hg]", code: "mm[Hg]" } },
          { code: { coding: [{ system: "http://loinc.org", code: "8462-4" }] }, valueQuantity: { value: 78, unit: "mm[Hg]", code: "mm[Hg]" } },
        ],
      },
    },
  ],
});

test("export: a reading's LOINC code leads whatever order its codings came in, so the round trip still pairs (Codex, #787)", () => {
  const xml = buildQrda1Document(run, "cms125", outcome(officialEvidence), panelOf("final", [
    { system: "http://snomed.info/sct", code: "271649006" },
    { system: "http://loinc.org", code: "8480-6" },
  ]));
  assert.match(xml, /<code code="8480-6"[^>]*>\s*<translation code="271649006"/);
  const back = importQrda1Document(xml);
  assert.equal(back.bundle.entry.filter((e) => JSON.stringify((e.resource as { code?: unknown }).code ?? {}).includes("85354-9")).length, 1);
});

test("export: a blood pressure that is not final is not written as completed readings, and says why (Codex, #787)", () => {
  for (const status of ["preliminary", "registered", "unknown"]) {
    const xml = buildQrda1Document(run, "cms125", outcome(officialEvidence), panelOf(status, [{ system: "http://loinc.org", code: "8480-6" }]));
    assert.ok(!xml.includes("2.16.840.1.113883.10.20.24.3.59"), `${status}: no Physical Exam, Performed`);
    assert.ok(!xml.includes("85354-9"), `${status}: and not a lab test either`);
  }
  const amended = buildQrda1Document(run, "cms125", outcome(officialEvidence), panelOf("amended", [{ system: "http://loinc.org", code: "8480-6" }]));
  assert.equal((amended.match(/2\.16\.840\.1\.113883\.10\.20\.24\.3\.59/g) ?? []).length, 2, "amended is final");
});

// ---------------------------------------------------------------------------------------------------
// Adversarial review of #787 (import side): each input below once made the importer state something the
// document did not. One test per finding, each against the real importer.
// ---------------------------------------------------------------------------------------------------

test("review #787: a reading's value is its own, never a Result nested inside another observation it carries", () => {
  // A systolic of 150 carrying, inside it, a diastolic whose value sits in its own nested Result (80).
  const inner = `<entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.24.3.59" extension="2021-08-01"/>
        <id root="1.3.6.1.4.1.115" extension="d-in"/>
        <code code="8462-4" codeSystem="2.16.840.1.113883.6.1"/>
        <statusCode code="completed"/>
        <effectiveTime value='20250219171000'/>
        <entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.24.3.87" extension="2019-12-01"/>
          <code code="8462-4" codeSystem="2.16.840.1.113883.6.1"/>
          <value xsi:type="PQ" value="80" unit="mm[Hg]"/>
        </observation></entryRelationship>
      </observation></entryRelationship>`;
  const imported = importQrda1Document(sitedDocument(sys({ value: `<value xsi:type="PQ" value="150" unit="mm[Hg]"/>`, extra: inner })));
  const all = imported.bundle.entry.map((e) => e.resource as Record<string, any>);
  const systolic = all.find((r) => r.id === "s" || JSON.stringify(r.code ?? {}).includes("85354-9"))!;
  const value = systolic.component
    ? systolic.component.find((c: { code: { coding: Array<{ code: string }> } }) => c.code.coding[0]!.code === "8480-6").valueQuantity.value
    : systolic.valueQuantity.value;
  assert.equal(value, 150, "the systolic keeps the 150 it states");
});

test("review #787: an aborted or nullified reading, or an intent, never pairs", () => {
  // Since #790 such a reading is not imported at all; the procedure keeps the document importable.
  const procedure = sitedProcedure("");
  for (const status of ["nullified", "aborted"]) {
    const nullified = (o: Parameters<typeof exam>[0]) => exam(o).replace('<statusCode code="completed"/>', `<statusCode code="${status}"/>`);
    const result = paired(nullified({ id: "s", code: "8480-6" }), nullified({ id: "d", code: "8462-4" }), procedure);
    assert.deepEqual([result.panels.length, result.readings], [0, 0], status);
  }
  const intent = (o: Parameters<typeof exam>[0]) => exam(o).replace('moodCode="EVN"', 'moodCode="INT"');
  const result = paired(intent({ id: "s", code: "8480-6" }), intent({ id: "d", code: "8462-4" }), procedure);
  assert.deepEqual([result.panels.length, result.readings], [0, 0], "an intent is not a reading");
});

test("#790: a reading that did not happen still keeps a pair at its time from forming (§4A.8 counts every stated reading)", () => {
  const aborted = exam({ id: "s2", code: "8480-6" }).replace('<statusCode code="completed"/>', '<statusCode code="aborted"/>');
  const intended = exam({ id: "s2", code: "8480-6" }).replace('moodCode="EVN"', 'moodCode="INT"');
  for (const [label, third] of [["aborted", aborted], ["intended", intended]] as const) {
    assert.notEqual(third, exam({ id: "s2", code: "8480-6" }), `the ${label} fixture must change the reading`);
    const result = paired(sys(), dia(), third);
    assert.deepEqual([result.panels.length, result.readings, result.unpaired], [0, 2, 2], `${label}: the pair stays two readings; the third is not imported`);
  }
  assert.equal(paired(sys(), dia()).panels.length, 1, "without it the two pair");
});

test("review #787: a value carrying a nullFlavor is no value, whatever number sits beside it", () => {
  const flavored = `<value xsi:type="PQ" nullFlavor="OTH" value="130" unit="mm[Hg]"/>`;
  assert.equal(paired(sys({ value: flavored }), dia()).panels.length, 0);
  const [reading] = importedOfType(sitedDocument(sys({ value: flavored })), "Observation");
  assert.equal(reading!.valueQuantity, undefined);
});

test("review #787: every stated method and site counts, qualifiers and originalText included", () => {
  const method = (code: string) => `<methodCode code="${code}" codeSystem="2.16.840.1.113883.6.96"/>`;
  assert.equal(paired(sys({ extra: method("A") + method("B") }), dia({ extra: method("A") })).panels.length, 0, "a second method");
  const site = (side: string) =>
    `<targetSiteCode code="368209003" codeSystem="2.16.840.1.113883.6.96"><qualifier><value code="${side}" codeSystem="2.16.840.1.113883.6.96"/></qualifier></targetSiteCode>`;
  assert.equal(paired(sys({ extra: site("7771000") }), dia({ extra: site("24028007") })).panels.length, 0, "left vs right arm");
  assert.equal(paired(sys({ extra: site("7771000") }), dia({ extra: site("7771000") })).panels.length, 1, "the same site pairs");
  const text = (t: string) => `<methodCode nullFlavor="OTH"><originalText>${t}</originalText></methodCode>`;
  assert.equal(paired(sys({ extra: text("auscultation") }), dia({ extra: text("oscillometric cuff") })).panels.length, 0, "originalText");
});

test("review #787: the time key is everything the effectiveTime states, a width included", () => {
  const span = (width: string) => `<effectiveTime><low value='20250219171000'/><width value='${width}' unit='min'/></effectiveTime>`;
  assert.equal(paired(sys({ time: span("5") }), dia({ time: span("60") })).panels.length, 0);
});

test("review #787: a reading stating both codes is neither half, and keeps the others at its time apart", () => {
  const both = exam({ id: "a", code: "8462-4" }).replace(
    '<code code="8462-4" codeSystem="2.16.840.1.113883.6.1"/>',
    '<code code="8462-4" codeSystem="2.16.840.1.113883.6.1"><translation code="8480-6" codeSystem="2.16.840.1.113883.6.1"/></code>',
  );
  const { panels, unpaired } = paired(both, dia({ id: "d2" }));
  assert.deepEqual([panels.length, unpaired], [0, 2]);
});

test("review #787: a negation in any case, or on an act around the readings, is a negation", () => {
  for (const spelling of ["TRUE", "True", " true "]) {
    const neg = (o: Parameters<typeof exam>[0]) => exam(o).replace('moodCode="EVN">', `moodCode="EVN" negationInd="${spelling}">`);
    // One positive reading at another time, so the document still has something to import.
    const keep = sys({ id: "keep", time: "<effectiveTime value='20250101090000'/>" });
    const { panels, readings } = paired(neg({ id: "s", code: "8480-6" }), neg({ id: "d", code: "8462-4" }), keep);
    assert.deepEqual([panels.length, readings], [0, 1], JSON.stringify(spelling));
  }
  const wrapped = `<entry><act classCode="ACT" moodCode="EVN" negationInd="true">
      <code code="CONC" codeSystem="2.16.840.1.113883.5.6"/>
      <entryRelationship typeCode="COMP">${sys().replace(/^<entry>|<\/entry>$/g, "")}</entryRelationship>
      <entryRelationship typeCode="COMP">${dia().replace(/^<entry>|<\/entry>$/g, "")}</entryRelationship>
    </act></entry>`;
  const inside = importQrda1Document(sitedDocument(wrapped + sys({ id: "keep", time: "<effectiveTime value='20250101090000'/>" })));
  const observations = inside.bundle.entry.map((e) => e.resource as Record<string, any>).filter((r) => r.resourceType === "Observation");
  assert.deepEqual(observations.map((r) => r.id), ["keep"], "nothing inside the negated act is imported");
});

test("review #787: a malformed offset or trailing text makes no timestamp rather than another instant", () => {
  // An impossible date or offset minutes past 59 with an offset too: nothing is rolled over, and no
  // `-05:75` is written (review, #788).
  for (const value of [
    "20250219171000+05:00", "20250219171000-05", "20250219171000-05000", "20250219171000+0500junk", "00000101120000",
    "20250230120000-1000", "20250101120000-0575", "20250101120000+0060",
  ]) {
    const [reading] = importedOfType(sitedDocument(sys({ time: `<effectiveTime value='${value}'/>` })), "Observation");
    assert.equal(reading!.effectiveDateTime, undefined, value);
  }
  const [ok] = importedOfType(sitedDocument(sys({ time: "<effectiveTime value='20250219171000.123-0500'/>" })), "Observation");
  assert.equal(ok!.effectiveDateTime, "2025-02-19T17:10:00.123-05:00", "a fraction and a well-formed offset still parse, the fraction kept (#791)");
});

test("review #787: a panel names a source id once, even when both readings share it", () => {
  const { panels } = paired(sys({ id: "same" }), dia({ id: "same" }));
  assert.equal(panels.length, 1);
  assert.deepEqual(panels[0]!.identifier, [{ system: "urn:oid:1.3.6.1.4.1.115", value: "same" }]);
});

// ---------------------------------------------------------------------------------------------------
// Adversarial review of #787 (export side): a blood pressure is written as two readings only when nothing
// about it is ambiguous, and otherwise not at all, with the reason.
// ---------------------------------------------------------------------------------------------------

type PanelOverrides = Record<string, unknown> & { components?: unknown[] };
const bpPanel = (o: PanelOverrides = {}) => {
  const { components, ...rest } = o;
  return {
    resourceType: "Observation", id: "bp-r", status: "final",
    category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] }],
    code: { coding: [{ system: "http://loinc.org", code: "85354-9" }] },
    effectiveDateTime: "2025-06-01T10:00:00Z",
    component: components ?? [
      { code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] }, valueQuantity: { value: 150, unit: "mm[Hg]", system: "http://unitsofmeasure.org", code: "mm[Hg]" } },
      { code: { coding: [{ system: "http://loinc.org", code: "8462-4" }] }, valueQuantity: { value: 95, unit: "mm[Hg]", system: "http://unitsofmeasure.org", code: "mm[Hg]" } },
    ],
    ...rest,
  };
};
const exported = (panel: unknown) => {
  const translation = translateQdm({ resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource: panel }] });
  const exams = translation.entries.filter((e) => e.includes("2.16.840.1.113883.10.20.24.3.59")).length;
  return { exams, lab: translation.entries.some((e) => e.includes("2.16.840.1.113883.10.20.24.3.38")), why: translation.untranslatable.join(" | ") };
};
const sysComponent = (vq: Record<string, unknown>) => ({ code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] }, valueQuantity: vq });
const diaComponent = { code: { coding: [{ system: "http://loinc.org", code: "8462-4" }] }, valueQuantity: { value: 95, unit: "mm[Hg]", code: "mm[Hg]" } };

test("review #787: the baseline panel is written as exactly two readings", () => {
  assert.deepEqual(exported(bpPanel()), { exams: 2, lab: false, why: "" });
});

test("#792: a panel stated with a date alone is written at that date, named, and not paired back", () => {
  for (const [when, written] of [["2025", "2025"], ["2025-06", "202506"], ["2025-06-01", "20250601"]] as const) {
    const panel = bpPanel({ effectiveDateTime: when });
    const translation = translateQdm({ resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource: panel }] });
    const exams = translation.entries.filter((e) => e.includes("2.16.840.1.113883.10.20.24.3.59"));
    assert.deepEqual(exams.map((e) => /<effectiveTime value="([^"]+)"\/>/.exec(e)?.[1]), [written, written], when);
    assert.deepEqual(exams.map((e) => /<value xsi:type="PQ" value="(\d+)"/.exec(e)?.[1]), ["150", "95"], when);
    assert.deepEqual(translation.untranslatable, [], when);
    assert.ok(translation.caveats?.some((c) => /date alone or an open period .*nor any other blood pressure whose time could fall within its own/.test(c)), when);
    // §4A.8 pairs only a time of day: the readings come back apart, and are counted.
    const back = importQrda1Document(buildQrda1Document(run, "cms125", outcome(officialEvidence), { resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource: panel }] }));
    const observations = back.bundle.entry.map((e) => e.resource as Record<string, any>).filter((r) => r.resourceType === "Observation");
    assert.deepEqual([observations.filter((o) => JSON.stringify(o.code).includes("85354-9")).length, back.unpairedBloodPressureReadings], [0, 2], when);
  }
  // Nor does it pair a panel at a time of day within its own, which before was written alone and paired:
  // §4A.8 cannot tell which readings belong together, and the caveat says so (review, #792).
  const timedThatDay = bpPanel({ id: "bp-timed", effectiveDateTime: "2025-06-01T10:00:00Z" });
  const both = importQrda1Document(buildQrda1Document(run, "cms125", outcome(officialEvidence), { resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource: timedThatDay }, { resource: bpPanel({ effectiveDateTime: "2025-06-01" }) }] }));
  assert.deepEqual([both.bundle.entry.filter((e) => JSON.stringify(e.resource).includes("85354-9")).length, both.unpairedBloodPressureReadings], [0, 4]);
  // A panel at a time of day carries no such caveat.
  const timed = translateQdm({ resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource: bpPanel() }] });
  assert.ok(!timed.caveats?.some((c) => /date alone or an open period/.test(c)));
});

test("#793: what the run could not read as a blood pressure is not written, and says why", () => {
  const vital = [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] }];
  const translate = (...resources: unknown[]) => translateQdm({ resourceType: "Bundle", entry: [sourceBundle.entry[0]!, ...resources.map((resource) => ({ resource }))] });
  const lone = (id: string, system: string, code: string, value: number) => ({
    resourceType: "Observation", id, status: "final", category: vital, code: { coding: [{ system, code }] },
    effectiveDateTime: "2025-06-01T10:00:00Z", valueQuantity: { value, unit: "mm[Hg]", system: "http://unitsofmeasure.org", code: "mm[Hg]" },
  });
  // Two lone readings at one time: before, two Laboratory Tests; written as Physical Exams, the import would
  // pair them into a panel the run never read.
  const readings = [lone("s", "http://loinc.org", "8480-6", 150), lone("d", "urn:oid:2.16.840.1.113883.6.1", "8462-4", 95)];
  const loneTranslation = translate(...readings);
  assert.deepEqual(loneTranslation.entries, []);
  assert.equal(loneTranslation.untranslatable.filter((u) => /^Observation: a lone systolic or diastolic reading is not written/.test(u)).length, 2);
  const back = importQrda1Document(buildQrda1Document(run, "cms125", outcome(officialEvidence), { resourceType: "Bundle", entry: [...sourceBundle.entry, ...readings.map((resource) => ({ resource }))] }));
  assert.deepEqual(back.bundle.entry.filter((e) => /8480-6|8462-4|85354-9/.test(JSON.stringify(e.resource))), []);
  assert.equal(back.unpairedBloodPressureReadings, 0);
  // A panel under 35094-2 is not one CMS165 reads either.
  const older = translate(bpPanel({ code: { coding: [{ system: "http://loinc.org", code: "35094-2" }] } }));
  assert.deepEqual([older.entries.length, older.untranslatable], [0, ["Observation: a blood pressure panel coded 35094-2 is not written: CMS165 reads a panel coded 85354-9 or 55284-4 only, so it did not read this one"]]);
});

test("#793: LOINC spelled other than http://loinc.org is named, and written only beside the canonical spelling", () => {
  const lab = (...coding: Array<{ system: string; code: string }>) => ({
    resourceType: "Observation", id: "a1c", status: "final", effectiveDateTime: "2025-06-01T10:00:00Z", code: { coding },
    category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory" }] }],
    valueQuantity: { value: 7.1, unit: "%" },
  });
  const translate = (resource: unknown) => translateQdm({ resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource }] });
  for (const system of ["urn:oid:2.16.840.1.113883.6.1", "http://loinc.org/"]) {
    const t = translate(lab({ system, code: "4548-4" }));
    assert.deepEqual([t.entries.length, t.untranslatable], [0, [`Observation: LOINC spelled ${system}, not http://loinc.org, is not written: CQL matches a code's system exactly, so the run did not read it`]], system);
  }
  const both = translate(lab({ system: "urn:oid:2.16.840.1.113883.6.1", code: "4548-4" }, { system: "http://loinc.org", code: "4548-4" }));
  assert.deepEqual([both.entries.length, both.untranslatable], [1, []]);
  // LOINC's own system with no code is no code, and a spelling and a system CDA cannot carry are each named.
  assert.deepEqual(translate(lab({ system: "http://loinc.org" } as { system: string; code: string })).untranslatable, ["Observation: no code to carry — CDA needs a coded value"]);
  assert.deepEqual(translate(lab({ system: "urn:oid:2.16.840.1.113883.6.1", code: "4548-4" }, { system: "http://example.org/local", code: "A1C" })).untranslatable, [
    "Observation: LOINC spelled urn:oid:2.16.840.1.113883.6.1, not http://loinc.org, is not written: CQL matches a code's system exactly, so the run did not read it; no CDA code system OID for http://example.org/local — CDA cannot carry it",
  ]);
  // Another system CDA cannot carry keeps its own reason.
  assert.match(translate(lab({ system: "http://example.org/local", code: "x" })).untranslatable[0]!, /no CDA code system OID for http:\/\/example\.org\/local/);
});

test("review #787: `issued` is when it was recorded, never the reading's time", () => {
  const r = exported(bpPanel({ effectiveDateTime: undefined, issued: "2025-06-03T15:30:00Z" }));
  assert.equal(r.exams, 0);
  assert.match(r.why, /no stated time \(effective\[x\]\)/);
  // A null period, or null in place of a time, states no time either (Codex, #801).
  for (const time of [{ effectivePeriod: null }, { effectiveDateTime: null }, { effectiveDateTime: null, effectivePeriod: null }]) {
    const n = exported(bpPanel({ effectiveDateTime: undefined, ...time }));
    assert.deepEqual([n.exams, /no stated time \(effective\[x\]\)/.test(n.why)], [0, true], JSON.stringify(time));
  }
});

test("review #787: a comparator is not a value, and a unit that is not UCUM mm[Hg] is not written", () => {
  const lessThan = exported(bpPanel({ components: [sysComponent({ value: 130, comparator: "<", unit: "mm[Hg]", code: "mm[Hg]" }), diaComponent] }));
  assert.deepEqual([lessThan.exams, /comparator/.test(lessThan.why)], [0, true]);
  const mmHg = exported(bpPanel({ components: [sysComponent({ value: 130, unit: "mmHg" }), diaComponent] }));
  assert.deepEqual([mmHg.exams, /mm\[Hg\]/.test(mmHg.why)], [0, true]);
});

test("review #787: all or nothing: half a panel, two systolics, or no components writes nothing and says why", () => {
  const half = exported(bpPanel({ components: [sysComponent({ value: 130, unit: "mm[Hg]", code: "mm[Hg]" })] }));
  assert.deepEqual([half.exams, /exactly one systolic and one diastolic/.test(half.why)], [0, true]);
  const twice = exported(bpPanel({ components: [sysComponent({ value: 130, unit: "mm[Hg]", code: "mm[Hg]" }), sysComponent({ value: 120, unit: "mm[Hg]", code: "mm[Hg]" }), diaComponent] }));
  assert.equal(twice.exams, 0);
  const none = exported(bpPanel({ status: "preliminary", components: [] }));
  assert.deepEqual([none.exams, none.lab, /not final/.test(none.why)], [0, false, true], "and never as a lab test");
});

test("review #787 (import): a third reading at the same instant, spelled with another offset, keeps the pair ambiguous", () => {
  const other = exam({ id: "s2", code: "8480-6", time: "<effectiveTime value='20250219121000-0500'/>", value: `<value xsi:type="PQ" value="150" unit="mm[Hg]"/>` });
  const { panels, unpaired } = paired(sys({ time: "<effectiveTime value='20250219171000+0000'/>" }), dia({ time: "<effectiveTime value='20250219171000+0000'/>" }), other);
  assert.deepEqual([panels.length, unpaired], [0, 3]);
});

test("review #787: a reading's time is the panel's effective[x] alone, never another time field it carries", () => {
  // A stray `performedPeriod` (no Observation field, but third-party data has anything) must not move it.
  const translation = translateQdm({
    resourceType: "Bundle",
    entry: [sourceBundle.entry[0]!, { resource: bpPanel({ performedPeriod: { start: "2025-01-01T00:00:00Z" }, issued: "2025-01-02T00:00:00Z" }) }],
  });
  const times = translation.entries.filter((e) => e.includes("2.16.840.1.113883.10.20.24.3.59")).map((e) => /<effectiveTime value="(\d+)/.exec(e)?.[1]);
  assert.deepEqual(times, ["20250601100000", "20250601100000"]);
});

test("§4A.8: the same instant written in two time zones is one time, and pairs (Codex, #787)", () => {
  const { panels, unpaired } = paired(
    sys({ time: "<effectiveTime value='20250219171000+0000'/>" }),
    dia({ time: "<effectiveTime value='20250219121000-0500'/>" }),
  );
  assert.deepEqual([panels.length, unpaired], [1, 0]);
});

test("§4A.8: two blood pressures a fraction of a second apart are two times, each its own panel (Codex, #787)", () => {
  const at = (t: string) => `<effectiveTime value='${t}'/>`;
  const { panels, unpaired } = paired(
    exam({ id: "s1", code: "8480-6", time: at("20250219171000.1") }),
    exam({ id: "d1", code: "8462-4", time: at("20250219171000.1") }),
    exam({ id: "s2", code: "8480-6", time: at("20250219171000.900") }),
    exam({ id: "d2", code: "8462-4", time: at("20250219171000.900") }),
  );
  assert.deepEqual([panels.length, unpaired], [2, 0]);
  assert.deepEqual(panels.map((p) => p.effectiveDateTime), ["2025-02-19T17:10:00.1Z", "2025-02-19T17:10:00.900Z"], "each keeps its own time, as written");
  // `.100` states a thousandth of a second, `.1` a tenth: one instant, two statements (review, #787).
  assert.equal(paired(sys({ time: at("20250219171000.100") }), dia({ time: at("20250219171000.1") })).panels.length, 0);
  for (const [a, b] of [["20250219171000.100+0000", "20250219171000.1+0000"], ["20250219171000.0+0000", "20250219171000+0000"]]) {
    assert.equal(paired(sys({ time: at(a!) }), dia({ time: at(b!) })).panels.length, 0, `${a} vs ${b}: one instant, two precisions`);
  }
});

test("export: two blood pressures a fraction of a second apart are written apart, and come back as two panels (Codex, #787)", () => {
  const bundle = {
    resourceType: "Bundle",
    entry: [
      sourceBundle.entry[0]!,
      { resource: bpPanel({ id: "a", effectiveDateTime: "2025-06-01T10:00:00.100Z" }) },
      { resource: bpPanel({ id: "b", effectiveDateTime: "2025-06-01T05:00:00.9-05:00" }) },
    ],
  };
  const xml = buildQrda1Document(run, "cms125", outcome(officialEvidence), bundle);
  // Each in its own offset since #791: one states -05:00, so the document states an offset on every time.
  assert.deepEqual([...new Set([...xml.matchAll(/<effectiveTime value="([^"]+)"/g)].map((m) => m[1]).filter((t) => t!.startsWith("20250601")))], ["20250601100000.100+0000", "20250601050000.9-0500"]);
  const back = importQrda1Document(xml);
  assert.equal(back.unpairedBloodPressureReadings, 0);
  const panels = back.bundle.entry.map((e) => e.resource as Record<string, any>).filter((r) => JSON.stringify(r.code ?? {}).includes("85354-9"));
  assert.deepEqual(panels.map((p) => p.effectiveDateTime).sort(), ["2025-06-01T05:00:00.9-05:00", "2025-06-01T10:00:00.100+00:00"]);
});

test("export: a blood pressure at an impossible time is not written, never rolled over (Codex, #787)", () => {
  // `Date` reads 30 February as 2 March and hour 24 as the next day.
  for (const when of [
    "2025-02-30T10:00:00Z", "2025-04-31T10:00:00Z", "2025-02-28T24:00:00Z", "2025-06-01T10:60:00Z",
    "2025-06-01T10:00:60Z", "2025-02-30T10:00:00", "2025-06-01T10:00:00+0500", "0000-06-01T10:00:00Z",
  ]) {
    const r = exported(bpPanel({ effectiveDateTime: when }));
    assert.equal(r.exams, 0, when);
    assert.match(r.why, /not a real date and time/, when);
  }
  const end = exported(bpPanel({ effectiveDateTime: undefined, effectivePeriod: { start: "2025-02-28T10:00:00Z", end: "2025-02-30T10:00:00Z" } }));
  assert.deepEqual([end.exams, /not a real date and time/.test(end.why)], [0, true]);
  const readingTimes = (effectiveDateTime: string) =>
    translateQdm({ resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource: bpPanel({ effectiveDateTime }) }] })
      .entries.filter((e) => e.includes("2.16.840.1.113883.10.20.24.3.59"))
      .map((e) => /<effectiveTime value="([^"]+)"/.exec(e)?.[1]);
  // Still written, as stated since #791: a real local time whose UTC instant falls on the next day keeps its
  // own day and offset (in UTC, 31 December 23:00 at -05:00 was the year 10000 and could not be written at
  // all), and a time stated to the minute is written to the minute.
  assert.deepEqual(readingTimes("2025-02-28T23:30:00-05:00"), ["20250228233000-0500", "20250228233000-0500"]);
  assert.deepEqual(readingTimes("9999-12-31T23:00:00-05:00"), ["99991231230000-0500", "99991231230000-0500"]);
  assert.deepEqual(readingTimes("2025-06-01T10:00Z"), ["202506011000", "202506011000"]);
  // A year below 1000 keeps its four digits, with a zone or without (review, #787).
  assert.deepEqual(readingTimes("0999-06-01T10:00:00Z"), ["09990601100000", "09990601100000"]);
  assert.deepEqual(readingTimes("0025-06-01T10:00:00"), ["00250601100000", "00250601100000"]);
  // A time with no zone (the corpus's own) is written as stated, whatever zone the exporting machine is in.
  const zone = process.env.TZ;
  try {
    process.env.TZ = "Asia/Karachi";
    assert.deepEqual(readingTimes("2025-06-01T00:00:00"), ["20250601000000", "20250601000000"]);
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("export: a blood pressure over a period is written unless it runs backwards or mixes zones, and a closed one comes back as the same period (Codex, #787; #792)", () => {
  for (const [period, why] of [
    [{}, /neither a start nor an end/],
    [{ start: "2025-06-01T10:00:00Z", end: "2025-06-01" }, /time zone on only one bound \(a date states none\)/],
    [{ start: "2025-06-02", end: "2025-06-01" }, /ends before it starts/],
    [{ start: "2025-06-01T10:00:00", end: "2025-05-31" }, /ends before it starts/],
    // Ordered as the import orders them, by each bound's first instant: the import reads a period whose high
    // starts before its low as any time at all (review, #792).
    [{ start: "2025-06-01T10:00:00", end: "2025-06-01" }, /ends before it starts/],
    [{ start: "2025-06-15", end: "2025-06" }, /ends before it starts/],
    [{ start: "2025-06-01T10:00:00.15Z", end: "2025-06-01T10:00:00.1Z" }, /ends before it starts/],
    [{ start: "2025-06-01T10:00:30Z", end: "2025-06-01T10:00Z" }, /ends before it starts/],
    [{ start: "2025-06-01T10:05:00Z", end: "2025-06-01T10:00:00Z" }, /ends before it starts/],
    [{ start: "2025-06-01T10:00:00.9Z", end: "2025-06-01T10:00:00.1Z" }, /ends before it starts/],
    // Ordered as instants, not digits, now each bound is written in its own offset (#791): 10:00 at -05:00 is
    // 15:00 UTC, after 11:00 UTC.
    [{ start: "2025-06-01T10:00:00-05:00", end: "2025-06-01T11:00:00+00:00" }, /ends before it starts/],
  ] as const) {
    const r = exported(bpPanel({ effectiveDateTime: undefined, effectivePeriod: period }));
    assert.equal(r.exams, 0, JSON.stringify(period));
    assert.match(r.why, why, JSON.stringify(period));
  }
  const closed = { start: "2025-06-01T10:00:00Z", end: "2025-06-01T10:05:00.5Z" };
  const bundle = { resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource: bpPanel({ effectiveDateTime: undefined, effectivePeriod: closed }) }] };
  const back = importQrda1Document(buildQrda1Document(run, "cms125", outcome(officialEvidence), bundle));
  const panels = back.bundle.entry.map((e) => e.resource as Record<string, any>).filter((r) => JSON.stringify(r.code ?? {}).includes("85354-9"));
  assert.deepEqual(panels.map((p) => p.effectivePeriod), [closed]);
  // An open side is written as QDM states one, and bounds at two precisions are written as stated (#792).
  const effective = (p: Record<string, string>) => {
    const t = translateQdm({ resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource: bpPanel({ effectiveDateTime: undefined, effectivePeriod: p }) }] });
    assert.deepEqual(t.untranslatable, [], JSON.stringify(p));
    return t.entries.filter((e) => e.includes("2.16.840.1.113883.10.20.24.3.59")).map((e) => /<effectiveTime>([\s\S]*?)<\/effectiveTime>/.exec(e)?.[1]?.replace(/\s+/g, ""));
  };
  assert.deepEqual(effective({ start: "2025-06-01T10:00:00Z" }), Array(2).fill('<lowvalue="20250601100000"/><highnullFlavor="NA"/>'));
  assert.deepEqual(effective({ end: "2025-06-01T10:00:00Z" }), Array(2).fill('<lownullFlavor="UNK"/><highvalue="20250601100000"/>'));
  assert.deepEqual(effective({ start: "2025-06-01", end: "2025-06-01T10:00:00" }), Array(2).fill('<lowvalue="20250601"/><highvalue="20250601100000"/>'));
  assert.deepEqual(effective({ start: "2025-06", end: "2025-06-01" }), Array(2).fill('<lowvalue="202506"/><highvalue="20250601"/>'));
  assert.deepEqual(effective({ start: "2025-06-01", end: "2025-06-03" }), Array(2).fill('<lowvalue="20250601"/><highvalue="20250603"/>'));
});

// ---------------------------------------------------------------------------------------------------
// Second review of #787 (import, export, integration and standards reviewers): each input below once made
// the pairing state a blood pressure the document did not, or lose one it did. One test per finding.
// ---------------------------------------------------------------------------------------------------

const unwrapped = (entry: string) => entry.replace(/^<entry>|<\/entry>$/g, "");
const asTemplate = (entry: string, root: string) => entry.replace('root="2.16.840.1.113883.10.20.24.3.59"', `root="${root}"`);

test("review #787: a third reading of any template whose time could fall within the pair's keeps it from forming", () => {
  const third = (o: Partial<Parameters<typeof exam>[0]> = {}) => exam({ id: "s3", code: "8480-6", value: `<value xsi:type="PQ" value="150" unit="mm[Hg]"/>`, ...o });
  for (const [label, blocker] of [
    ["a Laboratory Test at the same instant", asTemplate(third(), "2.16.840.1.113883.10.20.24.3.38")],
    ["an Assessment at the same instant", asTemplate(third(), "2.16.840.1.113883.10.20.24.3.144")],
    ["a center", third({ time: "<effectiveTime><center value='20250219171000'/></effectiveTime>" })],
    ["a high only", third({ time: "<effectiveTime><high value='20250219171000'/></effectiveTime>" })],
    ["no time at all", third({ time: "" })],
    ["the same day, as a date", third({ time: "<effectiveTime value='20250219'/>" })],
  ] as const) {
    const { panels, unpaired } = paired(sys(), dia(), blocker);
    assert.deepEqual([panels.length, unpaired], [0, 3], label);
  }
  assert.equal(paired(sys(), dia(), third({ time: "<effectiveTime value='20250220'/>" })).panels.length, 1, "another day does not block");

  const span = "<effectiveTime><low value='20250219171000'/><high value='20250219171500'/></effectiveTime>";
  for (const inside of ["20250219171200", "20250219171500"]) {
    const { panels } = paired(sys({ time: span }), dia({ time: span }), third({ time: `<effectiveTime value='${inside}'/>` }));
    assert.equal(panels.length, 0, `a systolic at ${inside}, within the pair's interval`);
  }
  assert.deepEqual(
    (({ panels, unpaired }) => [panels.length, unpaired])(paired(sys({ time: span }), dia({ time: span }), third({ time: "<effectiveTime value='20250219172000'/>" }))),
    [1, 1],
    "a systolic after the interval does not block",
  );
  // An instant inside another pair's interval: at 17:10 the document states two systolics and two diastolics.
  const { panels, unpaired } = paired(sys(), dia(), sys({ id: "s2", time: span }), dia({ id: "d2", time: span }));
  assert.deepEqual([panels.length, unpaired], [0, 4]);
});

test("review #787: a reading's value is its own: a negated Result is not its value, and two values are not one", () => {
  const result = (value: number, negated = false) => `<entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN"${negated ? ' negationInd="true"' : ""}>
        <templateId root="2.16.840.1.113883.10.20.24.3.87" extension="2019-12-01"/>
        <code code="8480-6" codeSystem="2.16.840.1.113883.6.1"/>
        <statusCode code="completed"/>
        <value xsi:type="PQ" value="${value}" unit="mm[Hg]"/>
      </observation></entryRelationship>`;
  const negated = paired(sys({ extra: result(150, true) }), dia());
  assert.equal(negated.panels.length, 1);
  assert.equal(negated.panels[0]!.component[0].valueQuantity.value, 130, "the systolic keeps its own 130; the negated 150 is not a result");
  assert.deepEqual((({ panels, unpaired }) => [panels.length, unpaired])(paired(sys({ extra: result(150) }), dia())), [0, 2], "its own value and a Result's");
  const twoValues = `<value xsi:type="PQ" value="150" unit="mm[Hg]"/><value xsi:type="PQ" value="128" unit="mm[Hg]"/>`;
  assert.deepEqual((({ panels, unpaired }) => [panels.length, unpaired])(paired(sys({ value: twoValues }), dia())), [0, 2], "two values");
  const [lab] = importedOfType(sitedDocument(asTemplate(sys({ value: "", extra: result(150, true) }), "2.16.840.1.113883.10.20.24.3.38")), "Observation");
  assert.equal(lab!.valueQuantity, undefined, "a negated Result is no lab's value either");
});

test("review #787: an identical time is the same statement: an offset and no offset, or a minute and a second, are not", () => {
  const at = (value: string) => `<effectiveTime value='${value}'/>`;
  assert.equal(paired(sys({ time: at("20250219171000") }), dia({ time: at("20250219121000-0500") })).panels.length, 0, "no offset vs an offset");
  assert.equal(paired(sys({ time: at("202502191710") }), dia({ time: at("20250219171000") })).panels.length, 0, "a minute vs a second");
  assert.equal(paired(sys({ time: at("202502191710+0000") }), dia({ time: at("20250219171000+0000") })).panels.length, 0, "a minute vs a second, one instant");
  // Two spellings of one statement do pair (standards review, #787).
  assert.equal(paired(sys({ time: "<effectiveTime xsi:type='IVL_TS' value='20250219171000'/>" }), dia()).panels.length, 1, "a redundant xsi:type");
  const span = (low: string) => `<effectiveTime><low ${low}/><high value='20250219171500'/></effectiveTime>`;
  assert.equal(paired(sys({ time: span("value='20250219171000' inclusive='true'") }), dia({ time: span("value='20250219171000'") })).panels.length, 1, "inclusive='true', the default");
  for (const time of [
    // An offset on one bound only: 12:10 New York to 17:15 with no zone is in order only under a guess.
    "<effectiveTime><low value='20250219121000-0500'/><high value='20250219171500'/></effectiveTime>",
    "<effectiveTime value='20250219171000.1234567891'/>",
    "<effectiveTime operator='E' value='20250219171000'/>",
    "<effectiveTime xsi:type='PIVL_TS' value='20250219171000'/>",
  ]) {
    assert.equal(paired(sys({ time }), dia({ time })).panels.length, 0, time);
  }
});

test("review #787: a reading inside an organizer or another act never pairs, and is counted", () => {
  const device = (id: string) => `<participant typeCode="DEV"><participantRole><id root="1.2.3" extension="${id}"/></participantRole></participant>`;
  const inOrganizer = (reading: string, context = "") =>
    `<entry><organizer classCode="CLUSTER" moodCode="EVN"><statusCode code="completed"/>${context}<component>${unwrapped(reading)}</component></organizer></entry>`;
  for (const [label, s, d] of [
    ["two devices", inOrganizer(sys(), device("A")), inOrganizer(dia(), device("B"))],
    ["one device", inOrganizer(sys(), device("A")), inOrganizer(dia(), device("A"))],
    ["a nullified organizer", inOrganizer(sys()).replace('<statusCode code="completed"/>', '<statusCode code="nullified"/>'), inOrganizer(dia())],
  ] as const) {
    const { panels, readings, unpaired } = paired(s, d);
    assert.deepEqual([panels.length, readings, unpaired], [0, 2, 2], label);
  }
});

test("review #787: a negated relationship does not negate the reading it points to", () => {
  const relationship = `<entry><act classCode="ACT" moodCode="EVN"><code code="CONC" codeSystem="2.16.840.1.113883.5.6"/>
      <entryRelationship typeCode="COMP" negationInd="true">${unwrapped(dia())}</entryRelationship></act></entry>`;
  const { panels, readings, unpaired } = paired(sys(), relationship);
  assert.deepEqual([panels.length, readings, unpaired], [0, 2, 2], "the diastolic is imported; wrapped, it does not pair");
});

test("review #787: a performer stated as a QDM Participant (typeCode PRF) is a stated performer", () => {
  const performer = (npi: string) =>
    `<participant typeCode="PRF"><templateId root="2.16.840.1.113883.10.20.24.3.162" extension="2019-12-01"/><participantRole><id root="2.16.840.1.113883.4.6" extension="${npi}"/></participantRole></participant>`;
  assert.equal(paired(sys({ extra: performer("111") }), dia({ extra: performer("222") })).panels.length, 0, "two practitioners");
  assert.equal(paired(sys({ extra: performer("111") }), dia()).panels.length, 0, "stated on one only");
  assert.equal(paired(sys({ extra: performer("111") }), dia({ extra: performer("111") })).panels.length, 1, "the same practitioner");
});

test("review #787: the panel states what the readings did, and nothing they did not", () => {
  const noId = (entry: string) => entry.replace(/<id root="1\.3\.6\.1\.4\.1\.115" extension="[^"]*"\/>/, "");
  const anonymous = paired(noId(sys()), noId(dia()));
  assert.equal(anonymous.panels.length, 1);
  assert.ok(!("identifier" in anonymous.panels[0]!), "no source id, no identifier (an empty array is not FHIR)");
  const context = `<methodCode code="37931006" codeSystem="2.16.840.1.113883.6.96"/><targetSiteCode code="368209003" codeSystem="2.16.840.1.113883.6.96"/>`;
  const [panel] = paired(sys({ extra: context }), dia({ extra: context })).panels;
  assert.deepEqual([panel!.method.coding[0].code, panel!.bodySite.coding[0].code], ["37931006", "368209003"]);
  const [dated] = importedOfType(sitedDocument(sys({ time: "<effectiveTime value='20250219-0500'/>" })), "Observation");
  assert.equal(dated!.effectiveDateTime, undefined, "an offset on a date alone is no HL7 timestamp");
  const [tiny] = importedOfType(sitedDocument(sys({ value: `<value xsi:type="PQ" value="1e-400" unit="mm[Hg]"/>` })), "Observation");
  assert.equal(tiny!.valueQuantity, undefined, "a value too small for a double is not zero");
});

test("export: a panel's own code may spell LOINC any way; its readings are written only in LOINC's own system, which CMS165 reads (review, #787)", () => {
  for (const system of ["http://loinc.org/", "urn:oid:2.16.840.1.113883.6.1", undefined]) {
    const coded = (code: string) => ({ coding: [{ ...(system ? { system } : {}), code }] });
    const panel = bpPanel({ code: coded("85354-9") });
    assert.deepEqual(exported(panel), { exams: 2, lab: false, why: "" }, `panel code in ${String(system)}`);
    const back = importQrda1Document(buildQrda1Document(run, "cms125", outcome(officialEvidence), { resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource: panel }] }));
    assert.equal(back.bundle.entry.filter((e) => JSON.stringify((e.resource as { code?: unknown }).code ?? {}).includes("85354-9")).length, 1, String(system));
    // CMS165 cannot read a reading coded this way, so the run did not count it, and the document must not
    // carry it for a receiver to count.
    const unreadable = exported(bpPanel({
      components: [
        { code: coded("8480-6"), valueQuantity: { value: 128, unit: "mm[Hg]", code: "mm[Hg]" } },
        { code: coded("8462-4"), valueQuantity: { value: 78, unit: "mm[Hg]", code: "mm[Hg]" } },
      ],
    }));
    assert.deepEqual([unreadable.exams, unreadable.lab, /LOINC's own system/.test(unreadable.why)], [0, false, true], `readings in ${String(system)}`);
  }
});

test("export: every blood-pressure time is either written or refused with its real reason (review, #787)", () => {
  const period = (start: string | undefined, end: string) => exported(bpPanel({ effectiveDateTime: undefined, effectivePeriod: { ...(start ? { start } : {}), end } }));
  assert.match(period("2025-06-01T10:00:00-05:00", "2025-06-01T11:00:00").why, /time zone on only one bound/);
  assert.deepEqual(period(undefined, "2025-06-01T11:00:00Z"), { exams: 2, lab: false, why: "" }, "an open start is written (#792)");
  assert.match(exported(bpPanel({ effectiveDateTime: undefined, effectiveTiming: { event: ["2025-06-01T10:00:00Z"] } })).why, /schedule/);
  assert.equal(exported(bpPanel({ effectiveDateTime: undefined, effectiveInstant: "2025-06-01T10:00:00.123Z" })).exams, 2, "an instant is a time");
});

test("export: a panel's id comes back unchanged, however many round trips (review, #787)", () => {
  let bundle: unknown = { resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource: bpPanel({ id: "bp-r" }) }] };
  for (let trip = 1; trip <= 3; trip++) {
    const back = importQrda1Document(buildQrda1Document(run, "cms125", outcome(officialEvidence), bundle)).bundle;
    const panels = back.entry.map((e) => e.resource as Record<string, any>).filter((r) => JSON.stringify(r.code ?? {}).includes("85354-9"));
    assert.deepEqual(panels.map((p) => p.id), ["bp-r"], `trip ${trip}`);
    bundle = back;
  }
});

test("export: a panel's method and site are written on both readings and come back; what this exporter does not write is named (review, #787)", () => {
  const snomed = (code: string) => ({ coding: [{ system: "http://snomed.info/sct", code }] });
  const panel = bpPanel({ method: snomed("37931006"), bodySite: snomed("368209003") });
  const xml = buildQrda1Document(run, "cms125", outcome(officialEvidence), { resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource: panel }] });
  assert.equal((xml.match(/<methodCode code="37931006"/g) ?? []).length, 2);
  assert.equal((xml.match(/<targetSiteCode code="368209003"/g) ?? []).length, 2);
  const [back] = importQrda1Document(xml).bundle.entry.map((e) => e.resource as Record<string, any>).filter((r) => JSON.stringify(r.code ?? {}).includes("85354-9"));
  assert.deepEqual([back!.method.coding[0].code, back!.bodySite.coding[0].code], ["37931006", "368209003"]);

  const full = bpPanel({
    performer: [{ reference: "Practitioner/1" }], issued: "2025-06-01T10:05:00Z", encounter: { reference: "Encounter/e1" },
    components: [
      sysComponent({ value: 150, unit: "mm[Hg]", code: "mm[Hg]" }), diaComponent,
      { code: { coding: [{ system: "http://loinc.org", code: "8478-0" }] }, valueQuantity: { value: 113, unit: "mm[Hg]", code: "mm[Hg]" } },
    ],
  });
  const r = exported(full);
  assert.deepEqual([r.exams, r.why], [2, ""], "the two readings are written, and nothing is reported as not exported");
  const caveats = translateQdm({ resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource: full }] }).caveats ?? [];
  for (const named of [/component 8478-0 is not written/, /performer is not written/, /issued is not written/, /encounter is not written/]) {
    assert.ok(caveats.some((c) => named.test(c)), String(named));
  }
  // A caveat, not a conformance failure, and one line however many panels state it (review, #787).
  const many = { resourceType: "Bundle", entry: [sourceBundle.entry[0]!, ...[1, 2, 3].map((n) => ({ resource: { ...full, id: `bp-${n}`, effectiveDateTime: `2025-06-0${n}T10:00:00Z` } }))] };
  const [document] = buildQrda1Documents(run, "cms125", [outcome(officialEvidence)], () => many);
  assert.equal(document!.conformant, true);
  assert.ok(document!.caveats.includes("not carried (3 resources) — Observation: a blood pressure's issued is not written by this exporter"), document!.caveats.join("\n"));
  assert.ok(!document!.caveats.some((c) => c.includes("bp-1")), "no panel id in a caveat");
});

test("export: everything else a written panel states is named, and a list where FHIR has one is read as written (review, #787)", () => {
  const snomed = (code: string) => ({ coding: [{ system: "http://snomed.info/sct", code }] });
  const caveatsOf = (panel: unknown) => translateQdm({ resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource: panel }] }).caveats ?? [];
  const named = caveatsOf(bpPanel({ status: "amended", device: { reference: "Device/cuff" }, note: [{ text: "left arm" }], interpretation: [snomed("38936003")] }));
  for (const what of [/device is not written/, /note is not written/, /interpretation is not written/, /status is 'amended' is written as completed/]) {
    assert.ok(named.some((c) => what.test(c)), String(what));
  }
  const listed = bpPanel({ method: [snomed("37931006"), snomed("17146006")], bodySite: [snomed("368209003"), snomed("368208006")] });
  const xml = buildQrda1Document(run, "cms125", outcome(officialEvidence), { resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource: listed }] });
  assert.equal((xml.match(/<methodCode /g) ?? []).length, 4, "both methods on both readings");
  assert.ok(caveatsOf(listed).some((c) => /more than one method/.test(c)) && caveatsOf(listed).some((c) => /more than one body site/.test(c)));
  assert.deepEqual(caveatsOf(bpPanel()), [], "a plain panel states nothing it does not write");
});

test("export: a malformed field costs one resource its reason, never the run its export (review, #787)", () => {
  const malformed = { resourceType: "Observation", status: "final", category: [{ coding: [{ code: "laboratory" }] }], code: { coding: "4548-4" } };
  const translation = translateQdm({ resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource: malformed }, { resource: bpPanel() }] });
  assert.equal(translation.entries.filter((e) => e.includes("2.16.840.1.113883.10.20.24.3.59")).length, 2, "the other resources are still written");
  assert.ok(translation.untranslatable.some((u) => /malformed field/.test(u)), translation.untranslatable.join(" | "));
});

test("export: a time the import cannot read back is not written (review, #787)", () => {
  for (const [when, reason] of [
    ["2025-06-01T10:00:00.1234567891Z", /more than nine digits of a second/],
    ["2025-06-01T10:00:00+15:00", /offset is beyond 14 hours/],
    ["2025-06-01T10:00:00+14:30", /offset is beyond 14 hours/],
    ["2025-06-01T10:00:00+05:60", /not a real date and time/],
  ] as const) {
    const r = exported(bpPanel({ effectiveDateTime: when }));
    assert.deepEqual([r.exams, reason.test(r.why)], [0, true], `${when}: ${r.why}`);
  }
  const back = importQrda1Document(buildQrda1Document(run, "cms125", outcome(officialEvidence), {
    resourceType: "Bundle",
    entry: [sourceBundle.entry[0]!, { resource: bpPanel({ id: "a", effectiveDateTime: "2025-06-01T10:00:00.000Z" }) }, { resource: bpPanel({ id: "b", effectiveDateTime: "2025-06-01T10:00:00.500Z" }) }],
  }));
  const panels = back.bundle.entry.map((e) => e.resource as Record<string, any>).filter((r) => JSON.stringify(r.code ?? {}).includes("85354-9"));
  assert.deepEqual(panels.map((p) => p.effectiveDateTime), ["2025-06-01T10:00:00.000Z", "2025-06-01T10:00:00.500Z"], "`.000` is a precision, kept both ways");
});

test("review #787: a third reading blocks across zones, and a range that runs backwards or mixes zones could be any time", () => {
  const third = (time: string) => exam({ id: "s3", code: "8480-6", time, value: `<value xsi:type="PQ" value="150" unit="mm[Hg]"/>` });
  const at = (value: string) => `<effectiveTime value='${value}'/>`;
  // 20:00 on 31 December in New York, and 08:00 on 1 June in Tokyo: in UTC another day than the stated one.
  for (const [pairTime, sameDay, otherDay] of [
    ["20251231200000-0500", "20251231", "20251229"],
    ["20250601080000+0900", "20250601", "20250603"],
    // Hawaii and Tonga: ten and thirteen hours from UTC, so a narrower widening would miss the stated day.
    ["20251231200000-1000", "20251231", "20251229"],
    ["20250601080000+1300", "20250601", "20250603"],
  ]) {
    assert.equal(paired(sys({ time: at(pairTime!) }), dia({ time: at(pairTime!) }), third(at(sameDay!))).panels.length, 0, `${sameDay} blocks ${pairTime}`);
    assert.equal(paired(sys({ time: at(pairTime!) }), dia({ time: at(pairTime!) }), third(at(otherDay!))).panels.length, 1, `${otherDay} does not`);
  }
  for (const time of [
    "<effectiveTime><low value='20250219171000'/><high value='20250219170000'/></effectiveTime>",
    "<effectiveTime><low value='20250219171000'/><high value='20250219171500+0100'/></effectiveTime>",
  ]) {
    assert.equal(paired(sys(), dia(), third(time)).panels.length, 0, time);
  }
});

test("review #787: a Result is a reading's value only when it states that reading's code", () => {
  const result = (code: string, value: number) => `<entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.24.3.87" extension="2019-12-01"/>
        <code code="${code}" codeSystem="2.16.840.1.113883.6.1"/>
        <statusCode code="completed"/>
        <value xsi:type="PQ" value="${value}" unit="mm[Hg]"/>
      </observation></entryRelationship>`;
  assert.equal(paired(sys({ value: "", extra: result("8462-4", 80) }), dia()).panels.length, 0, "a systolic carrying a diastolic's result");
  const both = result("8462-4", 80).replace('codeSystem="2.16.840.1.113883.6.1"/>', 'codeSystem="2.16.840.1.113883.6.1"><translation code="8480-6" codeSystem="2.16.840.1.113883.6.1"/></code>');
  assert.notEqual(both, result("8462-4", 80), "the fixture must add the translation");
  assert.equal(paired(sys({ value: "", extra: both }), dia()).panels.length, 0, "a Result coded as both halves is neither");
  const own = paired(sys({ value: "", extra: result("8480-6", 132) }), dia());
  assert.equal(own.panels[0]!.component[0].valueQuantity.value, 132, "its own result is its value");
});

test("review #787: a systolic is 8480-6 and a diastolic 8462-4, the codes §4A.8 names and CMS165 reads; a 'not done' is no reading", () => {
  const sitting = exam({ id: "s3", code: "8459-0", value: `<value xsi:type="PQ" value="150" unit="mm[Hg]"/>` });
  assert.deepEqual((({ panels, unpaired }) => [panels.length, unpaired])(paired(sys(), dia(), sitting)), [1, 0], "a sitting systolic neither pairs nor blocks");
  const notDone = `<entry><observation classCode="OBS" moodCode="EVN" negationInd="true">
      <templateId root="2.16.840.1.113883.10.20.24.3.144" extension="2019-12-01"/>
      <id root="1.3.6.1.4.1.115" extension="nd"/>
      <code code="8480-6" codeSystem="2.16.840.1.113883.6.1"/>
      <statusCode code="completed"/>
      <effectiveTime value='20250101090000'/>
      <entryRelationship typeCode="RSON"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.24.3.88" extension="2017-08-01"/>
        <code code="77301-0" codeSystem="2.16.840.1.113883.6.1"/>
        <value xsi:type="CD" code="183932001" codeSystem="2.16.840.1.113883.6.96"/>
      </observation></entryRelationship>
    </observation></entry>`;
  const imported = importQrda1Document(sitedDocument([sys(), dia(), notDone].join("\n")));
  assert.ok(imported.bundle.entry.some((e) => (e.resource as { status?: string }).status === "cancelled"), "the fixture imports its not-done");
  assert.equal(imported.unpairedBloodPressureReadings, 0);
});

test("export: what a written panel's readings and own code state beyond what is written is named, once per panel (review, #787)", () => {
  const caveatsOf = (panel: unknown) => translateQdm({ resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource: panel }] }).caveats ?? [];
  const systolic = {
    code: { text: "Systolic, sitting, left arm", coding: [{ system: "http://loinc.org", code: "8480-6" }, { system: "http://example.org/local", code: "SYS" }] },
    valueQuantity: { value: 150, unit: "mm[Hg]", code: "mm[Hg]" },
    interpretation: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", code: "H" }] }],
    referenceRange: [{ high: { value: 120 } }],
  };
  const named = caveatsOf(bpPanel({
    code: { text: "BP", coding: [{ system: "http://loinc.org", code: "85354-9" }, { system: "http://snomed.info/sct", code: "75367002" }] },
    implicitRules: "http://example.org/rules",
    components: [systolic, diaComponent],
  }));
  for (const what of [
    /reading's interpretation is not written/, /reading's referenceRange is not written/, /reading's coding in a system CDA does not carry/,
    /reading's code text is not written/, /own code says more than the panel code/, /implicitRules is not written/,
  ]) {
    assert.ok(named.some((c) => what.test(c)), `${String(what)}: ${named.join(" | ")}`);
  }
  // Two uncoded components are one panel's caveat, counted once.
  const uncoded = { code: { coding: [] }, valueQuantity: { value: 1, unit: "mm[Hg]", code: "mm[Hg]" } };
  const panel = bpPanel({ components: [sysComponent({ value: 150, unit: "mm[Hg]", code: "mm[Hg]" }), diaComponent, uncoded, uncoded] });
  const [document] = buildQrda1Documents(run, "cms125", [outcome(officialEvidence)], () => ({ resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource: panel }] }));
  assert.deepEqual(document!.caveats.filter((c) => c.includes("uncoded")), ["not carried — Observation: a blood pressure's component uncoded is not written by this exporter"]);
  // Two sites of which only one can be written: the re-import carries that one, so no "carries none".
  const snomed = (code: string) => ({ coding: [{ system: "http://snomed.info/sct", code }] });
  const oneWritable = bpPanel({ bodySite: [snomed("368209003"), { coding: [{ system: "http://example.org/local", code: "L" }] }] });
  assert.ok(!caveatsOf(oneWritable).some((c) => /more than one body site/.test(c)), caveatsOf(oneWritable).join(" | "));
  const [back] = importQrda1Document(buildQrda1Document(run, "cms125", outcome(officialEvidence), { resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource: oneWritable }] }))
    .bundle.entry.map((e) => e.resource as Record<string, any>).filter((r) => JSON.stringify(r.code ?? {}).includes("85354-9"));
  assert.equal(back!.bodySite.coding[0].code, "368209003");
  // A round-tripped panel's identifiers are the ids written for its readings; another source's are not.
  const roundTripped = importQrda1Document(buildQrda1Document(run, "cms125", outcome(officialEvidence), { resourceType: "Bundle", entry: [sourceBundle.entry[0]!, { resource: bpPanel({ id: "bp-r" }) }] }))
    .bundle.entry.map((e) => e.resource).find((r) => JSON.stringify((r as { code?: unknown }).code ?? {}).includes("85354-9"));
  assert.deepEqual(caveatsOf(roundTripped), [], "nothing about a round-tripped panel goes unwritten");
  assert.ok(caveatsOf(bpPanel({ identifier: [{ system: "urn:oid:1.2.3", value: "ehr-77" }] })).some((c) => /identifier is not written/.test(c)));
});

// ---------------------------------------------------------------------------------------------------
// #791: the export writes each time as its FHIR value states it: at its precision, never rolled over, never
// read in the exporting machine's zone, and in its own offset. CMS_0121: a document states offsets everywhere
// or nowhere, so one non-UTC zone puts an offset on every time of day in the document.
// ---------------------------------------------------------------------------------------------------

/** The source bundle with the encounter, condition and lab given other times. */
const timedBundle = (times: { visit?: [string, string]; onset?: string; lab?: string; birthDate?: string }) => {
  const [patient, encounter, condition, lab, ...rest] = sourceBundle.entry as Array<{ resource: Record<string, unknown> }>;
  return {
    ...sourceBundle,
    entry: [
      { resource: { ...patient!.resource, ...(times.birthDate !== undefined ? { birthDate: times.birthDate } : {}) } },
      { resource: { ...encounter!.resource, ...(times.visit ? { period: { start: times.visit[0], end: times.visit[1] } } : {}) } },
      { resource: { ...condition!.resource, ...(times.onset !== undefined ? { onsetDateTime: times.onset } : {}) } },
      { resource: { ...lab!.resource, ...(times.lab !== undefined ? { effectiveDateTime: times.lab } : {}) } },
      ...rest,
    ],
  };
};
const exportOf = (bundle: unknown) => buildQrda1Document(run, "cms125", outcome(officialEvidence), bundle);
const valuesIn = (xml: string) => [...xml.matchAll(/<(?:low|high|effectiveTime|time|birthTime) value="([^"]+)"/g)].map((m) => m[1]!);
const resourceBack = (xml: string, type: string) => importQrda1Document(xml).bundle.entry.map((e) => e.resource as Record<string, any>).find((r) => r.resourceType === type)!;

test("#791: a time is written at the precision it states, and comes back at it", () => {
  for (const [onset, written] of [["2019", "2019"], ["2019-06", "201906"], ["2019-06-15", "20190615"], ["2019-06-15T08:00:00-10:00", "20190615080000-1000"]] as const) {
    const xml = exportOf(timedBundle({ onset }));
    // Twice: the Diagnosis Concern Act opens when its diagnosis does.
    assert.equal(xml.split(`<low value="${written}"/>`).length - 1, 2, onset);
    assert.equal(resourceBack(xml, "Condition").onsetDateTime, onset, `${onset} comes back as it was stated`);
  }
  const birth = exportOf(timedBundle({ birthDate: "1975" }));
  assert.match(birth, /<birthTime value="1975"\/>/, "a birth year stays a year");
  assert.equal(resourceBack(birth, "Patient").birthDate, "1975");
});

test("#791: an impossible date is no date, never rolled over", () => {
  const xml = exportOf(timedBundle({ onset: "2019-02-30" }));
  assert.doesNotMatch(xml, /20190302/, "30 February is not 2 March");
  assert.match(xml, /<low nullFlavor="UNK"\/>/);
});

test("#791: a time with no zone is written as stated, whatever zone the exporting machine is in", () => {
  const zone = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Honolulu";
    const xml = exportOf(timedBundle({ lab: "2025-06-01T10:00:00", visit: ["2025-04-02T09:00:00", "2025-04-02T09:30:00"] }));
    assert.ok(valuesIn(xml).includes("20250601100000"), "the lab's 10:00, not 20:00 UTC");
    assert.ok(valuesIn(xml).includes("20250402090000"));
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("#791: one time in a non-UTC zone puts an offset on every time of day in the document, the header included", () => {
  // A Maui visit at 5 pm on 31 December; the lab states -10:00 too, the mammogram and procedure are in UTC,
  // and the condition's onset is a date.
  const bundle = timedBundle({ visit: ["2025-12-31T17:00:00-10:00", "2025-12-31T17:30:00-10:00"], lab: "2025-06-01T10:00:00-10:00", onset: "2019-06-15" });
  const xml = exportOf(bundle);
  // CMS_0121 as its schematron asserts it: once the document's own effectiveTime states an offset, every time
  // value longer than eight characters does too, the measurement period included (review, #791).
  const timesOfDay = valuesIn(xml).filter((v) => v.length > 8);
  assert.ok(timesOfDay.length >= 8, `the entries', the header's and the measurement period's times, got ${timesOfDay.length}`);
  assert.deepEqual(timesOfDay.filter((v) => !/[+-]\d{4}$/.test(v)), [], "every time of day states an offset (CMS_0121)");
  assert.ok(timesOfDay.includes("20251231170000-1000"), "the visit in its own offset, on its own day");
  assert.ok(timesOfDay.includes("20250510100000+0000"), "a UTC time as +0000");
  assert.ok(timesOfDay.includes("20250601100000-1000"), "the lab in its own offset");
  assert.match(xml, /<low value="20190615"\/>/, "a date carries no offset");
  assert.match(xml, /<ClinicalDocument[\s\S]*?<effectiveTime value="\d{14}\+0000"\/>/, "the document's own time");
  assert.match(xml, /<author>\s*<time value="\d{14}\+0000"\/>/, "the author's time");
  assert.match(xml, /<birthTime value="19750312"\/>/, "a date carries none");
  // Round trip: the visit comes back on the day and in the offset it was stated in.
  assert.equal(resourceBack(xml, "Encounter").period.start, "2025-12-31T17:00:00-10:00");
  const [doc] = buildQrda1Documents(run, "cms125", [outcome(officialEvidence)], () => bundle);
  assert.ok(!doc!.nonConformanceReasons.some((r) => /CMS_0121/.test(r)), "every time states its zone: it conforms");
});

test("#799: a time whose source states no zone is never given one; beside zoned times it makes the document non-conformant", () => {
  // Nothing invents clinical data (CLAUDE.md): `+0000` on a zone-less lab would assert an instant the source
  // never gave (Codex, #799). It is written as stated, and the document says it cannot meet CMS_0121.
  const bundle = timedBundle({ visit: ["2025-12-31T17:00:00-10:00", "2025-12-31T17:30:00-10:00"], lab: "2025-06-01T10:00:00" });
  const [doc] = buildQrda1Documents(run, "cms125", [outcome(officialEvidence)], () => bundle);
  const values = valuesIn(doc!.xml);
  assert.ok(values.includes("20250601100000"), "the lab as stated, with no offset");
  assert.ok(!values.some((v) => v.startsWith("20250601100000") && /[+-]\d{4}$/.test(v)), "no zone is invented for it");
  assert.ok(values.includes("20251231170000-1000"), "the visit keeps its own");
  assert.equal(doc!.conformant, false);
  assert.ok(doc!.nonConformanceReasons.some((r) => /^1 time\(s\) whose source states no time zone, beside times that state one \(CMS_0121\)/.test(r)), JSON.stringify(doc!.nonConformanceReasons));
});

test("#791: a document whose times are all in UTC or no zone states no offset anywhere", () => {
  const bundle = timedBundle({ lab: "2025-06-01T10:00:00Z", onset: "2019-01-01T08:00:00" });
  const xml = exportOf(bundle);
  assert.deepEqual(valuesIn(xml).filter((v) => /[+-]\d{4}$/.test(v)), [], "CMS_0121 prefers none");
  assert.ok(valuesIn(xml).includes("20250601100000"), "a UTC time as its UTC digits, read back as UTC");
  const [doc] = buildQrda1Documents(run, "cms125", [outcome(officialEvidence)], () => bundle);
  assert.ok(!doc!.caveats.some((c) => /no time zone/.test(c)), "nothing is assumed");
});

test("#791: third-party text cannot forge a time, and an XML-forbidden character is dropped", () => {
  const forged = {
    ...sourceBundle,
    entry: sourceBundle.entry.map((e) =>
      (e.resource as { resourceType: string }).resourceType === "Encounter"
        ? { resource: { ...(e.resource as object), id: "\u00010\u0001", type: [{ coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "99213", display: "\u000199\u0001 visit" }] }] } }
        : e,
    ),
  };
  const xml = exportOf(forged);
  assert.doesNotMatch(xml, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/, "no control character reaches the document");
  assert.match(xml, /displayName="99 visit"/, "the text is kept, without the character");
});

test("#791: only a time an entry writes decides whether the document states offsets", () => {
  // The condition states -10:00 but is dropped after its time was written (a malformed site throws), so
  // nothing written states a zone.
  const bundle = timedBundle({ onset: "2025-06-01T08:00:00-10:00", visit: ["2025-04-02T09:00:00", "2025-04-02T09:30:00"] });
  (bundle.entry[2]!.resource as Record<string, unknown>).bodySite = { coding: [] };
  const [doc] = buildQrda1Documents(run, "cms125", [outcome(officialEvidence)], () => bundle);
  assert.ok(doc!.nonConformanceReasons.some((r) => /Condition: could not be translated/.test(r)), "the fixture must drop the condition");
  assert.deepEqual(valuesIn(doc!.xml).filter((v) => /[+-]\d{4}$/.test(v)), []);
  assert.ok(!doc!.caveats.some((c) => /no time zone/.test(c)));
});

test("#791: a birth date coarser than a day is named; a fraction of a second comes back as written", () => {
  const [doc] = buildQrda1Documents(run, "cms125", [outcome(officialEvidence)], () => timedBundle({ birthDate: "1975-03" }));
  assert.ok(doc!.caveats.some((c) => /birth date is written at the year or month/.test(c)), JSON.stringify(doc!.caveats));
  const [day] = buildQrda1Documents(run, "cms125", [outcome(officialEvidence)], () => timedBundle({}));
  assert.ok(!day!.caveats.some((c) => /birth date/.test(c)));
  const xml = exportOf(timedBundle({ lab: "2025-06-01T10:00:00.250-10:00" }));
  assert.ok(valuesIn(xml).includes("20250601100000.250-1000"));
  assert.equal(resourceBack(xml, "Observation").effectiveDateTime, "2025-06-01T10:00:00.250-10:00");
});

test("#791: a year or month that is not one is no date, and -00:00 is UTC", () => {
  for (const low of ["202513", "202500", "0000"]) {
    const doc = diagnosisDocument(`<effectiveTime><low value='${low}'/><high nullFlavor="UNK"/></effectiveTime>`);
    assert.equal((conditionFromDoc(`<effectiveTime><low value='${low}'/><high nullFlavor="UNK"/></effectiveTime>`) as { onsetDateTime?: string } | undefined)?.onsetDateTime, undefined, low);
    assert.ok(doc.includes(low));
  }
  assert.equal((conditionFromDoc(`<effectiveTime><low value='202512'/><high nullFlavor="UNK"/></effectiveTime>`) as { onsetDateTime?: string } | undefined)?.onsetDateTime, "2025-12");
  const utcOnly = exportOf(timedBundle({ lab: "2025-06-01T10:00:00-00:00", visit: ["2025-04-02T09:00:00+00:00", "2025-04-02T09:30:00Z"] }));
  assert.deepEqual(valuesIn(utcOnly).filter((v) => /[+-]\d{4}$/.test(v)), [], "a document in UTC however spelled states no offset");
});
