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
      <id extension="${opts.encounterId ?? "enc-1"}" root="${MRN_ROOT}"/>
      <code code="${opts.encounterCode ?? "99213"}" codeSystem="2.16.840.1.113883.6.12"/>
      <statusCode code="completed"/>
      <effectiveTime><low value='20240331080000'/><high value='20240331081500'/></effectiveTime>
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
