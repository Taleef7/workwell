/**
 * What every committed measure artifact CLAIMS, checked against what it carries (#848), without the HL7
 * validator. Each claim below is one the validator measured false (run 39295433395, on CMS122), pinned as a
 * property of the committed bytes so a re-vendor or a translation rebuild cannot bring it back.
 *
 * The line: a claim WorkWell's reduction or build made false is removed; CMS's own Measure claims are left
 * as CMS shipped them (its Measures lack the narrative `publishable-measure-cqfm` requires, in CMS's own
 * artifact too), because changing CMS's artifact is relabeling it, not vendoring it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { logicSha256Of } from "../../scripts/artifact-logic.mjs";
import { OFFICIAL_MEASURE_SEMANTICS, improvementNotationFor } from "./official-measure-semantics.ts";

const ROOT = fileURLToPath(new URL("../../measures/", import.meta.url));

type Resource = Record<string, unknown> & { resourceType: string };
interface Artifact {
  kind: "official" | "derived";
  id: string;
  resources: Resource[];
  manifest: Record<string, unknown>;
}

const artifacts: Artifact[] = (["official", "derived"] as const).flatMap((kind) =>
  readdirSync(`${ROOT}${kind}`, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`${ROOT}${kind}/${d.name}/bundle.json`))
    .map((d) => {
      const bundle = JSON.parse(readFileSync(`${ROOT}${kind}/${d.name}/bundle.json`, "utf8")) as { entry: Array<{ resource: Resource }> };
      const manifest = JSON.parse(readFileSync(`${ROOT}${kind}/${d.name}/manifest.json`, "utf8")) as Record<string, unknown>;
      return { kind, id: d.name, resources: bundle.entry.map((e) => e.resource), manifest };
    }),
);

const profilesOf = (r: Resource): string[] => ((r["meta"] as { profile?: string[] } | undefined)?.profile ?? []);
const contentTypesOf = (r: Resource): string[] =>
  ((r["content"] as Array<{ contentType?: string }> | undefined) ?? []).map((c) => String(c.contentType));

/** The Library profiles that assert one content type each (CQL IG: clb-1, exl-1, ejl-1). */
const CONTENT_PROFILES: Record<string, string> = {
  "http://hl7.org/fhir/uv/cql/StructureDefinition/cql-library": "text/cql",
  "http://hl7.org/fhir/uv/cql/StructureDefinition/elm-xml-library": "application/elm+xml",
  "http://hl7.org/fhir/uv/cql/StructureDefinition/elm-json-library": "application/elm+json",
};
const PUBLISHABLE_LIBRARY = "http://hl7.org/fhir/uv/crmi/StructureDefinition/crmi-publishablelibrary";
const PUBLISHABLE_MEASURE = "http://hl7.org/fhir/us/cqfmeasures/StructureDefinition/publishable-measure-cqfm";
const IMPROVEMENT_NOTATION = "http://hl7.org/fhir/us/cqfmeasures/StructureDefinition/cqfm-improvementNotation";

test("there are artifacts to check: nine official, six translations", () => {
  assert.equal(artifacts.filter((a) => a.kind === "official").length, 9);
  assert.equal(artifacts.filter((a) => a.kind === "derived").length, 6);
});

for (const artifact of artifacts) {
  const name = `${artifact.kind}/${artifact.id}`;

  test(`${name}: every Library claims a content profile only when it carries that content`, () => {
    for (const library of artifact.resources.filter((r) => r.resourceType === "Library")) {
      for (const profile of profilesOf(library)) {
        const needed = CONTENT_PROFILES[profile];
        if (!needed) continue;
        assert.ok(
          contentTypesOf(library).includes(needed),
          `${String(library["url"])} claims ${profile} but carries no ${needed} (it carries ${contentTypesOf(library).join(", ")})`,
        );
      }
    }
  });

  test(`${name}: every Library claiming crmi-publishablelibrary carries the date it requires`, () => {
    for (const library of artifact.resources.filter((r) => r.resourceType === "Library")) {
      if (!profilesOf(library).includes(PUBLISHABLE_LIBRARY)) continue;
      assert.ok(typeof library["date"] === "string", `${String(library["url"])} claims ${PUBLISHABLE_LIBRARY} and has no date`);
    }
  });

  test(`${name}: no resource carries an empty array (FHIR: a present array is never empty)`, () => {
    const empty: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        if (node.length === 0) empty.push(path);
        node.forEach((item, i) => walk(item, `${path}[${i}]`));
      } else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`);
      }
    };
    for (const resource of artifact.resources) walk(resource, resource.resourceType);
    assert.deepEqual(empty, []);
  });
}

for (const artifact of artifacts.filter((a) => a.kind === "official")) {
  test(`official/${artifact.id}: the manifest's logicSha256 is the logic of the bundle it pins`, () => {
    assert.equal(artifact.manifest["logicSha256"], logicSha256Of({ entry: artifact.resources.map((resource) => ({ resource })) }));
  });
}

for (const artifact of artifacts.filter((a) => a.kind === "derived")) {
  test(`derived/${artifact.id}: the Measure does not claim publishable-measure-cqfm, whose identifiers a translation may not carry`, () => {
    const measure = artifact.resources.find((r) => r.resourceType === "Measure")!;
    assert.ok(!profilesOf(measure).includes(PUBLISHABLE_MEASURE));
  });

  test(`derived/${artifact.id}: the improvement notation is the one WorkWell's semantics imply, in the Measure and the manifest`, () => {
    const semantics = OFFICIAL_MEASURE_SEMANTICS[artifact.id];
    assert.ok(semantics, `${artifact.id} has no semantics entry`);
    const expected = improvementNotationFor(semantics);
    const measure = artifact.resources.find((r) => r.resourceType === "Measure")!;
    for (const group of (measure["group"] as Array<{ id?: string; extension?: Array<Record<string, unknown>> }>) ?? []) {
      const notation = group.extension?.find((e) => e["url"] === IMPROVEMENT_NOTATION) as
        | { valueCodeableConcept?: { coding?: Array<{ code?: string }> } }
        | undefined;
      assert.equal(notation?.valueCodeableConcept?.coding?.[0]?.code, expected, `group ${group.id}`);
    }
    assert.equal(artifact.manifest["improvementNotation"], expected);
  });
}

test("CMS122 is an inverse measure: its translation says decrease, whatever CMS's artifact declares", () => {
  assert.equal(improvementNotationFor(OFFICIAL_MEASURE_SEMANTICS["cms122"]!), "decrease");
  assert.equal(artifacts.find((a) => a.kind === "derived" && a.id === "cms122")?.manifest["improvementNotation"], "decrease");
});
