/**
 * Documents are not people, and the rule that turns one into the other.
 *
 * Every fixture here is shaped like Cypress's own C2 archive, because that is the only third party whose
 * answer we can check: it splits one patient's clinical data across two documents and appends
 * demographically "augmented" duplicates, each with a fresh local MRN and one of first name, last name
 * or birthdate randomized — while the Medicare Beneficiary Identifier stays constant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveQrda1Documents } from "./qrda1-identity.ts";

const MRN_ROOT = "1.3.6.1.4.1.115";
const MBI_ROOT = "2.16.840.1.113883.4.927";

/** A minimal but real QRDA I: one Encounter Performed, so the import does not refuse it. */
const doc = (opts: {
  mrn: string;
  mbi?: string;
  given?: string;
  family?: string;
  birth?: string;
  encounterCode?: string;
  encounterId?: string;
  /** The assigning authority (CDA `id/@root`) of the encounter's id. */
  encounterRoot?: string;
  /** A SNOMED code carried as the encounter's QDM Encounter Diagnosis. */
  diagnosis?: string;
}) => `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole>
    <id extension="${opts.mrn}" root="${MRN_ROOT}"/>
    ${opts.mbi ? `<id extension="${opts.mbi}" root="${MBI_ROOT}"/>` : ""}
    <patient>
      <name><given>${opts.given ?? "TWO"}</given><family>${opts.family ?? "Diabetes Adult"}</family></name>
      <administrativeGenderCode nullFlavor="OTH"><translation code="248152002" codeSystem="2.16.840.1.113883.6.96"/></administrativeGenderCode>
      <birthTime value='${opts.birth ?? "19781224203000"}'/>
    </patient>
  </patientRole></recordTarget>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.24.2.1" extension="2021-08-01"/>
    <entry><encounter classCode="ENC" moodCode="EVN">
      <templateId extension="2021-08-01" root="2.16.840.1.113883.10.20.24.3.23"/>
      <id extension="${opts.encounterId ?? "enc-1"}" root="${opts.encounterRoot ?? MRN_ROOT}"/>
      <code code="${opts.encounterCode ?? "99213"}" codeSystem="2.16.840.1.113883.6.12"/>
      <statusCode code="completed"/>
      <effectiveTime><low value='20240331080000'/><high value='20240331081500'/></effectiveTime>
      ${opts.diagnosis ? `<entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN">
        <templateId extension="2021-08-01" root="2.16.840.1.113883.10.20.24.3.168"/>
        <code code="29308-4" codeSystem="2.16.840.1.113883.6.1"/>
        <value code="${opts.diagnosis}" codeSystem="2.16.840.1.113883.6.96" xsi:type="CD"/>
      </observation></entryRelationship>` : ""}
    </encounter></entry>
  </section></component></structuredBody></component>
</ClinicalDocument>`;

test("a clinical SPLIT is one person, and both halves' data survives the merge", () => {
  // Cypress splits one patient across two documents with DIFFERENT local MRNs; only the MBI is stable.
  const resolution = resolveQrda1Documents([
    doc({ mrn: "mrn-a", mbi: "8UA6K41TH72", encounterCode: "99213", encounterId: "e1" }),
    doc({ mrn: "mrn-b", mbi: "8UA6K41TH72", encounterCode: "99214", encounterId: "e2" }),
  ]);
  assert.equal(resolution.subjects.length, 1, "two documents, one person");
  const [subject] = resolution.subjects;
  assert.deepEqual(subject!.documentIndexes, [0, 1]);
  const codes = subject!.bundle.entry
    .map((e) => e.resource as Record<string, any>)
    .filter((r) => r.resourceType === "Encounter")
    .map((r) => r.type[0].coding[0].code)
    .sort();
  assert.deepEqual(codes, ["99213", "99214"], "half a split patient's data must not be dropped");
});

test("an AUGMENTED duplicate merges on the identifier, and its demographic difference is REPORTED", () => {
  // The duplicate's family name differs by one character — `Adult` vs `Axult`, exactly as Cypress
  // generates it. Merging is right; deciding silently which name is real is not.
  const resolution = resolveQrda1Documents([
    doc({ mrn: "mrn-a", mbi: "8UA6K41TH72", family: "Diabetes Adult" }),
    doc({ mrn: "mrn-b", mbi: "8UA6K41TH72", family: "Diabetes Axult" }),
  ]);
  assert.equal(resolution.subjects.length, 1);
  const conflicts = resolution.subjects[0]!.demographicConflicts;
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.field, "name");
  assert.equal(conflicts[0]!.values.length, 2, "both spellings are reported, neither is chosen silently");
});

test("a BIRTHDATE conflict is reported, because it can move a person between age bands", () => {
  // Both routed measures gate their initial population on `AgeInYearsAt(...)`. Silently picking one
  // birthdate is how a MATCH gets printed while the sender's other answer is discarded.
  const resolution = resolveQrda1Documents([
    doc({ mrn: "mrn-a", mbi: "8UA6K41TH72", birth: "19781224203000" }),
    doc({ mrn: "mrn-b", mbi: "8UA6K41TH72", birth: "19501224203000" }),
  ]);
  assert.deepEqual(
    resolution.subjects[0]!.demographicConflicts.map((c) => c.field),
    ["birthDate"],
  );
});

test("documents sharing NO identifier stay separate, however alike they look", () => {
  // The deliberate limit of an identifier-only rule, pinned so it cannot drift into demographic
  // matching by accident: these two are identical but for the MRN, and they are two people here.
  const resolution = resolveQrda1Documents([doc({ mrn: "mrn-a" }), doc({ mrn: "mrn-b" })]);
  assert.equal(resolution.subjects.length, 2);
  assert.deepEqual(resolution.subjects.map((s) => s.demographicConflicts), [[], []]);
});

test("grouping is TRANSITIVE — A~B by one identifier and B~C by another is one person", () => {
  const resolution = resolveQrda1Documents([
    doc({ mrn: "shared-mrn", mbi: "MBI-1" }),
    doc({ mrn: "shared-mrn", mbi: "MBI-2" }),
    doc({ mrn: "other-mrn", mbi: "MBI-2" }),
  ]);
  assert.equal(resolution.subjects.length, 1, "the identifier graph is walked, not just pairwise keys");
  assert.deepEqual(resolution.subjects[0]!.documentIndexes, [0, 1, 2]);
});

test("the resolution does not depend on the ORDER the documents arrive in", () => {
  // The C2 harness picked its canonical Patient by filename sort and review reproduced a false MATCH
  // from it. Here the choice is the smallest identifier key, so shuffling the input cannot change the
  // subject id, the demographics evaluated, or the conflicts reported.
  const documents = [
    doc({ mrn: "zzz", mbi: "8UA6K41TH72", family: "Axult" }),
    doc({ mrn: "aaa", mbi: "8UA6K41TH72", family: "Adult" }),
  ];
  const forward = resolveQrda1Documents(documents);
  const reversed = resolveQrda1Documents([...documents].reverse());
  assert.equal(forward.subjects[0]!.subjectId, reversed.subjects[0]!.subjectId);
  const patientOf = (r: typeof forward) =>
    r.subjects[0]!.bundle.entry.map((e) => e.resource as Record<string, any>).find((x) => x.resourceType === "Patient")!;
  assert.deepEqual(patientOf(forward).name, patientOf(reversed).name, "the same document's demographics win");
});

test("an unreadable document is REPORTED, and does not cost the rest of the submission", () => {
  // Measured on Cypress's own archive: the half of a clinically split patient that received no clinical
  // data at all is refused by the importer (ADR-051), and that person is recovered from the other half.
  const resolution = resolveQrda1Documents([doc({ mrn: "mrn-a", mbi: "MBI-1" }), "<not-a-cda/>"]);
  assert.equal(resolution.subjects.length, 1);
  assert.equal(resolution.failures.length, 1);
  assert.equal(resolution.failures[0]!.index, 1, "by index, so the caller knows WHICH document");
});

test("merged resources are namespaced per document, so identical ids do not collide", () => {
  // Two documents about one person can legitimately reuse a generated id. Without namespacing, the
  // second silently overwrites nothing — it is simply absent, and half the person's data disappears.
  const resolution = resolveQrda1Documents([
    doc({ mrn: "mrn-a", mbi: "MBI-1", encounterId: "same-id", encounterCode: "99213" }),
    doc({ mrn: "mrn-b", mbi: "MBI-1", encounterId: "same-id", encounterCode: "99214" }),
  ]);
  const ids = resolution.subjects[0]!.bundle.entry
    .map((e) => (e.resource as { id?: string }).id)
    .filter((id): id is string => id !== undefined);
  assert.equal(new Set(ids).size, ids.length, "no two resources in the merged bundle share an id");
});

/** The document with its encounter entry repeated, the copy's id and code replaced. */
const withAnotherEncounter = (xml: string, id: string, code: string) => {
  const start = xml.indexOf("    <entry><encounter");
  const end = xml.indexOf("</encounter></entry>") + "</encounter></entry>".length;
  const copy = xml.slice(start, end).replace(/<id extension="[^"]*" root/, `<id extension="${id}" root`).replace(/<code code="\d+" codeSystem="2\.16\.840\.1\.113883\.6\.12"/, `<code code="${code}" codeSystem="2.16.840.1.113883.6.12"`);
  return `${xml.slice(0, end)}\n${copy}${xml.slice(end)}`;
};

const encountersOf = (documents: string[]) => {
  const resources = resolveQrda1Documents(documents).subjects[0]!.bundle.entry.map((e) => e.resource as Record<string, any>);
  return { resources, encounters: resources.filter((r) => r.resourceType === "Encounter"), conditions: resources.filter((r) => r.resourceType === "Condition") };
};

test("a duplicate document's REPEATED facts are merged once, so a visit is not counted twice", () => {
  // Cypress's augmented duplicates carry the same clinical entries under a different MRN. Two copies of
  // one visit with one diagnosis are two engagements to a measure that counts them (CMS137).
  const { resources, encounters, conditions } = encountersOf([
    doc({ mrn: "mrn-a", mbi: "MBI-1", encounterId: "e1", diagnosis: "75544000" }),
    doc({ mrn: "mrn-b", mbi: "MBI-1", family: "Diabetes Axult", encounterId: "e1", diagnosis: "75544000" }),
  ]);
  assert.equal(encounters.length, 1, "one visit");
  assert.equal(conditions.length, 1, "one diagnosis");
  const ids = new Set(resources.map((r) => `${r.resourceType}/${r.id}`));
  assert.ok(ids.has(encounters[0]!.reasonReference[0].reference), "the kept visit still names its diagnosis");
});

test("only the repeated facts are dropped: a duplicate document's NEW facts survive", () => {
  const { encounters } = encountersOf([
    doc({ mrn: "mrn-a", mbi: "MBI-1", encounterId: "e1", diagnosis: "75544000" }),
    withAnotherEncounter(doc({ mrn: "mrn-b", mbi: "MBI-1", encounterId: "e1", diagnosis: "75544000" }), "e2", "99214"),
  ]);
  assert.deepEqual(encounters.map((e) => e.type[0].coding[0].code).sort(), ["99213", "99214"]);
});

test("the same visit with a DIFFERENT diagnosis is not a duplicate: a fact includes what it references", () => {
  const { encounters, conditions } = encountersOf([
    doc({ mrn: "mrn-a", mbi: "MBI-1", encounterId: "e1", diagnosis: "75544000" }),
    doc({ mrn: "mrn-b", mbi: "MBI-1", encounterId: "e1", diagnosis: "5602001" }),
  ]);
  assert.equal(encounters.length, 2);
  assert.equal(conditions.length, 2);
});

test("identical content under DIFFERENT entry ids is two events, not a duplicate", () => {
  // Two visits of one type at the same time from two documents map to identical resources; only the
  // source's entry id says whether they are one event or two, so different ids keep both.
  const { encounters } = encountersOf([
    doc({ mrn: "mrn-a", mbi: "MBI-1", encounterId: "visit-a" }),
    doc({ mrn: "mrn-b", mbi: "MBI-1", encounterId: "visit-b" }),
  ]);
  assert.equal(encounters.length, 2);
});

test("the same entry id under two ASSIGNING AUTHORITIES is two entries, not a duplicate", () => {
  // Entry "1" from one sender's system and entry "1" from another's are different events; the FHIR id is
  // root-agnostic, so the CDA root (carried as the identifier's system) is what tells them apart.
  const { encounters } = encountersOf([
    doc({ mrn: "mrn-a", mbi: "MBI-1", encounterId: "1", encounterRoot: "2.16.840.1.113883.19.5.1" }),
    doc({ mrn: "mrn-b", mbi: "MBI-1", encounterId: "1", encounterRoot: "2.16.840.1.113883.19.5.2" }),
  ]);
  assert.equal(encounters.length, 2);
  assert.deepEqual(encounters.map((e) => e.identifier[0].system).sort(), ["urn:oid:2.16.840.1.113883.19.5.1", "urn:oid:2.16.840.1.113883.19.5.2"]);
});

test("a repeat WITHIN one document is kept: the document itself stated it twice", () => {
  const twice = withAnotherEncounter(doc({ mrn: "mrn-a", mbi: "MBI-1", encounterId: "e1" }), "e1", "99213");
  const { encounters } = encountersOf([twice]);
  assert.equal(encounters.length, 2);
});

test("a renamed resource is renamed in the references to it too, or the link silently matches nothing", () => {
  // An Encounter names its diagnosis Conditions by reference, and CQMCommon resolves a reference by exact
  // id. Namespacing the ids without the references left CMS137's encounter-diagnosis history pointing at
  // Conditions that no longer exist under that name, on this route only.
  for (const documents of [
    [doc({ mrn: "mrn-a", mbi: "MBI-1", encounterId: "e1", diagnosis: "75544000" })],
    [
      doc({ mrn: "mrn-a", mbi: "MBI-1", encounterId: "same-id", diagnosis: "75544000" }),
      doc({ mrn: "mrn-b", mbi: "MBI-1", encounterId: "same-id", diagnosis: "5602001" }),
    ],
  ]) {
    const resources = resolveQrda1Documents(documents).subjects[0]!.bundle.entry.map((e) => e.resource as Record<string, any>);
    const ids = new Set(resources.map((r) => `${r.resourceType}/${r.id}`));
    const encounters = resources.filter((r) => r.resourceType === "Encounter");
    assert.equal(encounters.length, documents.length);
    for (const encounter of encounters) {
      const references = [
        ...(encounter.reasonReference ?? []).map((r: { reference: string }) => r.reference),
        ...(encounter.diagnosis ?? []).map((d: { condition: { reference: string } }) => d.condition.reference),
      ];
      assert.equal(references.length, 2, "both links are present");
      for (const reference of references) assert.ok(ids.has(reference), `${reference} resolves inside the merged bundle`);
    }
    // And each encounter still points at ITS OWN diagnosis, not the other document's.
    const codeOf = (reference: string) => resources.find((r) => `${r.resourceType}/${r.id}` === reference)!.code.coding[0].code;
    assert.deepEqual(
      encounters.map((e) => codeOf(e.reasonReference[0].reference)).sort(),
      documents.length === 1 ? ["75544000"] : ["5602001", "75544000"],
    );
  }
});

// ---------------------------------------------------------------- defects found in review of #389

test("a nullFlavor identifier is not an identifier — two unknowns are not the same person", () => {
  // `<id root="…" extension="UNK" nullFlavor="UNK"/>` says the sender does not know this patient's
  // number. Treating it as one merged two different people, under-counted the population and unioned
  // their clinical data into one bundle.
  const unknownId = (given: string) =>
    doc({ mrn: "unused", given }).replace(
      `<id extension="unused" root="${MRN_ROOT}"/>`,
      `<id extension="UNK" root="${MRN_ROOT}" nullFlavor="UNK"/>`,
    );
  const resolution = resolveQrda1Documents([unknownId("ALICE"), unknownId("BOB")]);
  assert.equal(resolution.subjects.length, 2, "an unknown identifier groups nothing");
});

test("two people who resolve to the same subject id are DISAMBIGUATED, not silently conflated", () => {
  // Grouping is root-AWARE; the importer's patient id is deliberately root-AGNOSTIC. So the same
  // extension under two different roots is correctly two people and incorrectly one subject id — and
  // `outcomes` has no unique key on (run_id, subject_id), so both rows persist and every per-subject
  // read attributes one person's data to the other.
  const resolution = resolveQrda1Documents([
    doc({ mrn: "123", given: "ALICE" }),
    doc({ mrn: "123", given: "BOB" }).replace(`root="${MRN_ROOT}"`, 'root="9.9.9.9"'),
  ]);
  assert.equal(resolution.subjects.length, 2);
  assert.equal(new Set(resolution.subjects.map((s) => s.subjectId)).size, 2, "distinct people, distinct subject ids");
});

test("a field only a NON-canonical document states still reaches the merged Patient", () => {
  // Absence is not disagreement. Official CMS125's initial population reads `us-core-sex` and nothing
  // else (ADR-042), so taking the canonical Patient WHOLE silently dropped a person out of the IPP when
  // only their other document recorded sex — and reported it as a `gender` conflict of `["", "female"]`.
  const withoutSex = doc({ mrn: "aaa", mbi: "MBI-1" }).replace(
    /<administrativeGenderCode[\s\S]*?<\/administrativeGenderCode>/,
    "",
  );
  const withSex = doc({ mrn: "zzz", mbi: "MBI-1" });
  const resolution = resolveQrda1Documents([withoutSex, withSex]);
  assert.equal(resolution.subjects.length, 1);
  const patient = resolution.subjects[0]!.bundle.entry
    .map((e) => e.resource as Record<string, any>)
    .find((r) => r.resourceType === "Patient")!;
  assert.equal(patient.gender, "female", "filled from the document that states it");
  assert.ok(
    (patient.extension ?? []).some((e: { url: string }) => e.url.endsWith("us-core-sex")),
    "and the extension the official IPP actually reads comes with it",
  );
  assert.deepEqual(resolution.subjects[0]!.demographicConflicts, [], "silence is not disagreement");
});

test("order independence holds where the identifier sets are EQUAL — the case the first test could not reach", () => {
  // One sender splitting a patient across documents produces members with the SAME identifiers, which is
  // precisely where the earlier tiebreak fell back to input order: measured at a 28-year birthdate swing
  // decided by `readdirSync`. The other order test uses documents with DIFFERING identifiers, so it
  // exercises the sort key and never this branch.
  const documents = [
    doc({ mrn: "same", mbi: "MBI-1", given: "ALICE", birth: "19781224203000" }),
    doc({ mrn: "same", mbi: "MBI-1", given: "BOB", birth: "19501224203000" }),
  ];
  const forward = resolveQrda1Documents(documents);
  const reversed = resolveQrda1Documents([...documents].reverse());
  const patientOf = (r: typeof forward) =>
    r.subjects[0]!.bundle.entry.map((e) => e.resource as Record<string, any>).find((x) => x.resourceType === "Patient")!;
  assert.equal(forward.subjects.length, 1);
  assert.equal(patientOf(forward).birthDate, patientOf(reversed).birthDate, "the same birthdate either way");
  assert.deepEqual(patientOf(forward).name, patientOf(reversed).name);
  assert.equal(forward.subjects[0]!.demographicConflicts.length, 2, "and both disagreements are still reported");
});

test("a document's LOCAL measure id is carried, so an authored export is checked like any other", () => {
  // `/evaluate` checks `measureIdentifiers` PLUS `localMeasureId`; dropping the latter here left an
  // authored-measure export — which carries `urn:workwell:measure` and no published identifier — with
  // nothing to check against, so re-importing one under the wrong authored measure passed silently.
  const authored = doc({ mrn: "mrn-authored" }).replace(
    "</section></component></structuredBody></component>",
    `</section></component><component><section>
       <templateId root="2.16.840.1.113883.10.20.24.2.2" extension="2021-08-01"/>
       <entry><organizer classCode="CLUSTER" moodCode="EVN"><reference typeCode="REFR"><externalDocument classCode="DOC" moodCode="EVN">
         <id root="urn:workwell:measure" extension="audiogram"/>
       </externalDocument></reference></organizer></entry>
     </section></component></structuredBody></component>`,
  );
  assert.deepEqual(resolveQrda1Documents([authored]).subjects[0]!.measureIdentifiers, ["audiogram"]);
});
