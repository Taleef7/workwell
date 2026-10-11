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

import { buildQrda1Document } from "./qrda1-export.ts";
import { importQrda1Document, Qrda1ImportError, SYSTEM_FOR_OID } from "./qrda1-import.ts";
import { parseXml, decodeEntities, child, descendants, hasTemplate } from "./cda-parse.ts";
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

test("import applies an HL7 TIMEZONE OFFSET rather than discarding it (Codex, #362)", () => {
  // `20251231230000-0500` is 2026-01-01T04:00:00Z — a different day AND year. A measurement period is
  // a half-open interval on exactly that boundary, so dropping the offset moves events between
  // populations. Base HL7 asks for the offset (CONF:81-10130) even though the CMS Hospital IG asks for
  // its absence (CMS_0121), so a conformant document may well carry one.
  // Target the PROCEDURE's own timestamp: `.replace` with a string hits only the first match, and the
  // imaging Observation shares that instant in the shared fixture.
  const doc = buildQrda1Document(run, "cms125", outcome(officialEvidence), {
    ...sourceBundle,
    entry: [sourceBundle.entry[0]!, sourceBundle.entry[5]!],
  }).replace('value="20250510100000"', 'value="20251231230000-0500"');
  const imported = importQrda1Document(doc);
  const procedure = imported.bundle.entry.map((e) => e.resource as Record<string, unknown>).find((r) => r.resourceType === "Procedure")!;
  assert.equal(procedure.performedDateTime, "2026-01-01T04:00:00Z");
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
        <effectiveTime value="20250601100000"/>
      </observation>
      <observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.24.3.38" extension="2021-08-01"/>
        <id root="urn:workwell:fhir" extension="lab-B"/>
        <code code="2345-7" codeSystem="2.16.840.1.113883.6.1"/>
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
  // `Patient.birthDate` is a local calendar fact, not an instant. `isoFromHl7` normalizes to UTC, so
  // truncating ITS output gives the wrong day near midnight: `20000101010000+1400` is
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
      <effectiveTime><low value="20200301"/><high nullFlavor="UNK"/></effectiveTime>
      <value xsi:type="CD" code="248802009" codeSystem="${SNOMED_OID}"/>
      ${sites}
    </observation></entry>`;

const sitedProcedure = (sites: string, template = "2.16.840.1.113883.10.20.24.3.64") => `<entry typeCode="DRIV"><procedure classCode="PROC" moodCode="EVN">
      <templateId root="${template}" extension="2021-08-01"/>
      <code code="172043006" codeSystem="${SNOMED_OID}"/>
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
  assert.equal(paired(sys({ time: open }), dia({ time: open })).panels.length, 1, "the same open interval on both pairs");
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
  assert.equal(real!.effectiveDateTime, "2025-02-28T17:00:00Z", "a real date with an offset still parses");
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
