/**
 * The facts spec (#875) against the vendored bundles it names: a define that is not in the logic's main
 * library is silently never recorded, and the report would then say "none found" of a patient CQL found
 * something for. So every name is read out of the ELM itself.
 *   node --import tsx --test src/wiring/official-facts.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDerivedArtifact, loadOfficialArtifact, type OfficialArtifact } from "./official-artifacts.ts";
import { cqlFactsFor, factsSpecEntries, factsSpecFor, readCqlFacts, recordedDefines, withoutCqlFacts } from "./official-facts.ts";

interface ElmDef { name: string; resultTypeName?: string }

function mainLibraryDefs(artifact: OfficialArtifact): { library: string; defs: Map<string, ElmDef> } {
  const libraries = (artifact.bundle.entry ?? [])
    .map((e) => e?.resource as { resourceType?: string; name?: string; content?: Array<{ contentType?: string; data?: string }> } | undefined)
    .filter((r) => r?.resourceType === "Library");
  const main = libraries.find((l) => l?.name === artifact.manifest.measureName);
  assert.ok(main, `${artifact.manifest.catalogId}: a Library named ${artifact.manifest.measureName}`);
  const data = main.content?.find((c) => c.contentType === "application/elm+json")?.data;
  assert.ok(data, `${artifact.manifest.measureName}: ELM content`);
  const elm = JSON.parse(Buffer.from(data, "base64").toString("utf8")) as {
    library: { identifier: { id: string }; statements?: { def?: ElmDef[] } };
  };
  return { library: elm.library.identifier.id, defs: new Map((elm.library.statements?.def ?? []).map((d) => [d.name, d])) };
}

const TEMPORAL = new Set(["{urn:hl7-org:elm-types:r1}Date", "{urn:hl7-org:elm-types:r1}DateTime"]);

for (const { measureId, kind, spec } of factsSpecEntries()) {
  test(`${measureId} (${kind}): every recorded define is in the vendored main library, and the date define is one Date or DateTime`, (t) => {
    const artifact = kind === "derived" ? loadDerivedArtifact(measureId) : loadOfficialArtifact(measureId);
    if (!artifact) {
      t.skip(`no vendored ${kind} artifact for ${measureId} here`);
      return;
    }
    const { library, defs } = mainLibraryDefs(artifact);
    assert.equal(spec.library, artifact.manifest.measureName, "the spec names the artifact's library, or nothing is recorded");
    assert.equal(library, spec.library);
    for (const define of recordedDefines(spec)) assert.ok(defs.has(define), `${spec.library} has no define "${define}"`);
    if (spec.dateDefine) {
      assert.ok(spec.evidence.includes(spec.dateDefine), "the date define is one of the evidence defines");
      const declared = defs.get(spec.dateDefine)?.resultTypeName;
      assert.ok(declared && TEMPORAL.has(declared), `"${spec.dateDefine}" is declared ${declared ?? "as no single type"}`);
    }
    if (spec.noneFoundDefine) {
      assert.equal(defs.get(spec.noneFoundDefine)?.resultTypeName, "{urn:hl7-org:elm-types:r1}Boolean", "the none-found define is CQL's own Boolean");
    }
    for (const rate of spec.exposedRates ?? []) assert.ok(Number.isInteger(rate) && rate >= 0);
  });
}

test("the spec covers the five measures whose logic exposes evidence, and not CMS125", () => {
  const covered = new Set(factsSpecEntries().map((e) => e.measureId));
  assert.deepEqual([...covered].sort(), ["cms122", "cms130", "cms137", "cms165", "cms2"]);
  assert.equal(factsSpecFor("cms125", "official"), undefined);
  assert.equal(factsSpecFor("cms125", "derived"), undefined);
});

const flags = (ipp: boolean, denom: boolean, denex = false, denexcep = false) => [
  { populationType: "initial-population", result: ipp },
  { populationType: "denominator", result: denom },
  { populationType: "denominator-exclusion", result: denex },
  { populationType: "denominator-exception", result: denexcep },
];

test("cqlFactsFor records a scored patient's non-null values in order, and nothing for anyone else", () => {
  const values = [
    { define: "A", value: "1" },
    { define: "B", value: null },
    { define: "C", value: "3" },
  ];
  assert.deepEqual(cqlFactsFor([flags(true, true)], values), { spec: 1, values: [{ define: "A", value: "1" }, { define: "C", value: "3" }] });
  assert.deepEqual(cqlFactsFor([flags(true, true)], [{ define: "A", value: null }]), { spec: 1, values: [] }, "scored, nothing found");
  assert.equal(cqlFactsFor([flags(false, false)], values), undefined, "outside the initial population");
  assert.equal(cqlFactsFor([flags(true, false)], values), undefined, "outside the denominator");
  assert.equal(cqlFactsFor([flags(true, true, true)], values), undefined, "a denominator exclusion");
  assert.equal(cqlFactsFor([flags(true, true, false, true)], values), undefined, "a denominator exception");
  assert.deepEqual(cqlFactsFor([flags(true, true, true), flags(true, true)], values)?.values.length, 2, "scored on any one rate");
  assert.equal(cqlFactsFor([flags(true, true)], undefined), undefined, "nothing asked of the calculation");
});

test("readCqlFacts accepts only the persisted shape", () => {
  assert.deepEqual(readCqlFacts({ spec: 1, values: [{ define: "A", value: "x" }] }), { spec: 1, values: [{ define: "A", value: "x" }] });
  for (const bad of [null, "x", { spec: "1", values: [] }, { spec: 1 }, { spec: 1, values: [{ define: "A" }] }, { spec: 1, values: [{ define: 2, value: "x" }] }]) {
    assert.equal(readCqlFacts(bad), null, JSON.stringify(bad));
  }
});

test("withoutCqlFacts drops only the facts, and leaves the caller's object alone", () => {
  const evidence = { official: { a: 1 }, cqlFacts: { spec: 1, values: [] } };
  assert.deepEqual(withoutCqlFacts(evidence), { official: { a: 1 } });
  assert.ok("cqlFacts" in evidence);
  const plain = { official: { a: 1 } };
  assert.equal(withoutCqlFacts(plain), plain, "nothing to drop: the same object");
  assert.equal(withoutCqlFacts(null), null);
});
