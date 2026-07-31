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
import { importQrda1Document, Qrda1ImportError } from "./qrda1-import.ts";
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
  const onlyMedication = `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole><id root="urn:workwell:employee" extension="emp-006"/></patientRole></recordTarget>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.24.2.1" extension="2021-08-01"/>
    <entry typeCode="DRIV">
      <substanceAdministration classCode="SBADM" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.24.3.41" extension="2021-08-01"/>
      </substanceAdministration>
    </entry>
  </section></component></structuredBody></component>
</ClinicalDocument>`;
  assert.throws(() => importQrda1Document(onlyMedication), /no entry this importer can translate/);
  assert.throws(() => importQrda1Document(onlyMedication), /2\.16\.840\.1\.113883\.10\.20\.24\.3\.41/);
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
  const withMedication = buildQrda1Document(run, "cms125", outcome(officialEvidence), sourceBundle).replace(
    "</section>\n      </component>\n    </structuredBody>",
    `<entry typeCode="DRIV"><substanceAdministration classCode="SBADM" moodCode="EVN">
       <templateId root="2.16.840.1.113883.10.20.24.3.41" extension="2021-08-01"/>
     </substanceAdministration></entry></section>
      </component>
    </structuredBody>`,
  );
  const imported = importQrda1Document(withMedication);
  assert.deepEqual(imported.untranslatedTemplates, ["2.16.840.1.113883.10.20.24.3.41"], "Medication, Active — named");
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
