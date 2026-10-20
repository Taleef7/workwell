/**
 * `logicSha256Of` (#848): what a measure artifact COMPUTES, hashed apart from what it says about itself.
 *
 * The exports keep CMS's identity on a run only while the artifact that scored it is still the vendored
 * one. A re-vendor that changes nothing a result depends on (a profile claim, a narrative, a description)
 * must not end that for every older run, and one that changes the logic must. Each test pins one side.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { logicSha256Of } from "./artifact-logic.mjs";

const elm = (body) => Buffer.from(JSON.stringify(body), "utf8").toString("base64");

function bundle() {
  return {
    resourceType: "Bundle",
    entry: [
      {
        resource: {
          resourceType: "Library",
          url: "https://example.test/Library/Main",
          version: "1.0.000",
          date: "2025-01-01",
          meta: { profile: ["http://hl7.org/fhir/uv/cql/StructureDefinition/cql-library"] },
          content: [{ contentType: "application/elm+json", data: elm({ library: { statements: ["Numerator"] } }) }],
        },
      },
      {
        resource: {
          resourceType: "Measure",
          url: "https://example.test/Measure/M",
          version: "1.0.000",
          description: "CMS's text",
          meta: { profile: ["http://hl7.org/fhir/us/cqfmeasures/StructureDefinition/publishable-measure-cqfm"] },
          library: ["https://example.test/Library/Main"],
          group: [
            {
              id: "Group_1",
              population: [
                { id: "Numerator_1", code: { coding: [{ code: "numerator" }] }, criteria: { language: "text/cql-identifier", expression: "Numerator" } },
              ],
              stratifier: [{ id: "Strat_1", criteria: { language: "text/cql-identifier", expression: "Stratification 1" } }],
            },
          ],
        },
      },
    ],
  };
}

const library = (b) => b.entry[0].resource;
const measure = (b) => b.entry[1].resource;

describe("logicSha256Of", () => {
  it("is a sha256 in the manifests' spelling, and the same for the same bundle", () => {
    assert.match(logicSha256Of(bundle()), /^sha256:[0-9a-f]{64}$/);
    assert.equal(logicSha256Of(bundle()), logicSha256Of(bundle()));
  });

  it("does NOT move with metadata: profile claims, narrative, dates, descriptions, identifiers", () => {
    const changed = bundle();
    library(changed).meta.profile = [];
    library(changed).text = { status: "generated", div: "<div/>" };
    delete library(changed).date;
    measure(changed).meta.profile = [];
    measure(changed).description = "another text";
    measure(changed).identifier = [{ system: "x", value: "y" }];
    assert.equal(logicSha256Of(changed), logicSha256Of(bundle()), "a metadata-only re-vendor keeps the logic");
  });

  it("does NOT move with JSON key order or entry order", () => {
    const reordered = bundle();
    reordered.entry.reverse();
    const lib = library({ entry: [reordered.entry[1]] });
    reordered.entry[1] = { resource: { content: lib.content, version: lib.version, url: lib.url, resourceType: "Library" } };
    assert.equal(logicSha256Of(reordered), logicSha256Of(bundle()));
  });

  it("MOVES when the ELM changes", () => {
    const changed = bundle();
    library(changed).content[0].data = elm({ library: { statements: ["Numerator", "Denominator"] } });
    assert.notEqual(logicSha256Of(changed), logicSha256Of(bundle()));
  });

  it("MOVES when a population's criteria, a stratifier, or a group id changes", () => {
    for (const mutate of [
      (b) => { measure(b).group[0].population[0].criteria.expression = "Other"; },
      (b) => { measure(b).group[0].stratifier[0].criteria.expression = "Stratification 2"; },
      (b) => { measure(b).group[0].id = "Group_2"; },
    ]) {
      const changed = bundle();
      mutate(changed);
      assert.notEqual(logicSha256Of(changed), logicSha256Of(bundle()), String(mutate));
    }
  });

  it("MOVES when an identity the logic is filed under changes (Library or Measure url/version)", () => {
    for (const mutate of [
      (b) => { library(b).version = "2.0.000"; },
      (b) => { measure(b).url = "https://example.test/Measure/Other"; },
    ]) {
      const changed = bundle();
      mutate(changed);
      assert.notEqual(logicSha256Of(changed), logicSha256Of(bundle()), String(mutate));
    }
  });

  it("refuses a bundle with no Measure or no ELM: there would be no logic to name", () => {
    const noMeasure = bundle();
    noMeasure.entry.pop();
    assert.throws(() => logicSha256Of(noMeasure), /no Measure/);
    const noElm = bundle();
    library(noElm).content = [];
    assert.throws(() => logicSha256Of(noElm), /no ELM/);
  });
});
