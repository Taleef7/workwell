/**
 * D10's per-library rule (#782) over every committed artifact: each library's `relatedArtifact` and
 * `dataRequirement` value sets, read as fqm reads them, equal its ELM's `valueSets.def`, and its
 * `cqf-directReferenceCode` codes are among its ELM's `codes.def`.
 *
 * The router holds translations to the rule at construction (`derivedIdentityProblems`). CMS's official
 * artifacts are held to it HERE instead, so a re-vendor that breaks it fails CI rather than opening a new
 * refusal path on a live stack. It is the calibration of the rule as well: MADiE writes these lists from
 * the ELM, so a rule that refused CMS's own artifacts would be refusing MADiE's output, not a stale list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bundleDataRequirementProblems, libraryDataRequirementProblems } from "../standards/derived-identity.ts";
import { loadDerivedArtifact, loadOfficialArtifact, type OfficialArtifact } from "./official-artifacts.ts";

type Library = Record<string, unknown> & { resourceType?: string };

/** Every artifact directory under `measures/<kind>/` that holds a bundle. */
function committed(kind: "official" | "derived"): string[] {
  const root = fileURLToPath(new URL(`../../measures/${kind}/`, import.meta.url));
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`${root}${d.name}/bundle.json`))
    .map((d) => d.name)
    .sort();
}

const librariesOf = (artifact: OfficialArtifact): Library[] =>
  ((artifact.bundle as { entry?: Array<{ resource?: Library }> }).entry ?? [])
    .map((e) => e.resource)
    .filter((r): r is Library => r?.resourceType === "Library");
const elmOf = (library: Library) => {
  const content = (library["content"] as Array<{ contentType?: string; data?: string }>).find((c) => c.contentType === "application/elm+json")!;
  return JSON.parse(Buffer.from(content.data!, "base64").toString("utf8")) as { library: { valueSets?: { def?: Array<{ id: string }> } } };
};

const artifacts: Array<[label: string, artifact: OfficialArtifact]> = [
  ...committed("official").map((id): [string, OfficialArtifact] => [`official ${id}`, loadOfficialArtifact(id)!]),
  ...committed("derived").map((id): [string, OfficialArtifact] => [`translation ${id}`, loadDerivedArtifact(id)!]),
];

test("every committed official artifact and translation is found and loads", () => {
  // Non-vacuous: the nine vendored CMS artifacts and at least the two committed translations.
  assert.ok(committed("official").length >= 9, JSON.stringify(committed("official")));
  assert.ok(committed("derived").length >= 2, JSON.stringify(committed("derived")));
  for (const [label, artifact] of artifacts) assert.ok(artifact, `${label} loads`);
});

for (const [label, artifact] of artifacts) {
  test(`D10: every library of ${label} names exactly the value sets and only the codes its ELM declares`, () => {
    assert.deepEqual(bundleDataRequirementProblems(artifact.bundle), []);
  });

  test(`D10 bites on ${label}: a value set dropped from a library's ELM is reported against its lists`, () => {
    // The check must have something to compare in this artifact, and the bundle-level pass above must be
    // reading it, or that pass would be vacuous. So the same call is made over a copy with one edit.
    const copy = { ...artifact, bundle: JSON.parse(JSON.stringify(artifact.bundle)) as OfficialArtifact["bundle"] };
    const library = librariesOf(copy).find((l) => (elmOf(l).library.valueSets?.def ?? []).length > 0);
    assert.ok(library, `${label} has a library declaring value sets`);
    const elm = elmOf(library);
    const dropped = elm.library.valueSets!.def!.shift()!.id;
    const content = (library["content"] as Array<{ contentType?: string; data?: string }>).find((c) => c.contentType === "application/elm+json")!;
    content.data = Buffer.from(JSON.stringify(elm), "utf8").toString("base64");
    const problems = bundleDataRequirementProblems(copy.bundle);
    assert.ok(problems.some((p) => p.includes(`names value set ${dropped}, which its ELM does not declare`)), JSON.stringify(problems));
    // And the per-library rule the router runs agrees, on the decoded ELM.
    assert.deepEqual(libraryDataRequirementProblems(library, elm), problems);
  });
}
