/**
 * Why trusting ONE profile is enough for cms165, held against the ELM itself (#591).
 *
 * The executor reads cms165 by resource type, except `us-core-blood-pressure`, whose retrieve keeps only
 * resources stamped with it (`trustedProfiles`). That is safe only while every OTHER retrieve either names
 * a code filter or names a profile that is its type's ONLY QI-Core profile — then reading by type returns
 * what reading by that profile would. A code-less retrieve of a profile that picks out PART of its type
 * (an Observation profile, one of the two Condition profiles) would, read by type, return every resource of
 * the type. This test lists every code-less, profile-typed retrieve in each committed cms165 artifact, so a
 * re-vendor or a translation that adds one turns red here instead of over-reading silently.
 *
 * Every library in the bundle is walked, reachable or not, so the list can only be too long, never short.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadDerivedArtifact, loadOfficialArtifact } from "./official-artifacts.ts";
import { OFFICIAL_MEASURE_SEMANTICS } from "./official-measure-semantics.ts";

const QICORE = "http://hl7.org/fhir/us/qicore/StructureDefinition/";

/** Types whose retrieves name the type's one QI-Core profile: by type is the same set of resources. */
const SOLE_PROFILE_OF_TYPE: Readonly<Record<string, string>> = {
  Encounter: `${QICORE}qicore-encounter`,
  Medication: `${QICORE}qicore-medication`,
  MedicationRequest: `${QICORE}qicore-medicationrequest`,
  Patient: `${QICORE}qicore-patient`,
};

type Json = Record<string, unknown>;

function codeLessProfiledRetrieves(bundle: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const o = node as Json;
    if (o["type"] === "Retrieve" && typeof o["templateId"] === "string") {
      const type = String(o["dataType"] ?? "").split("}").pop()!;
      const profile = o["templateId"];
      if (profile !== `http://hl7.org/fhir/StructureDefinition/${type}` && !("codes" in o)) found.add(`${type} ${profile}`);
    }
    Object.values(o).forEach(walk);
  };
  for (const entry of (bundle as { entry?: Array<{ resource?: Json }> }).entry ?? []) {
    const library = entry.resource;
    if (library?.["resourceType"] !== "Library") continue;
    for (const content of (library["content"] as Array<{ contentType?: string; data?: string }> | undefined) ?? []) {
      if (content.contentType === "application/elm+json" && content.data) walk(JSON.parse(Buffer.from(content.data, "base64").toString("utf8")));
    }
  }
  return [...found].sort();
}

const artifacts = [
  ["CMS's artifact", loadOfficialArtifact("cms165")],
  ["the WorkWell translation", loadDerivedArtifact("cms165")],
] as const;

test("cms165's only code-less retrieve of a type-subdividing profile is the blood pressure, which is the one it trusts (#591)", () => {
  const trusted = OFFICIAL_MEASURE_SEMANTICS["cms165"]?.trustedProfiles ?? [];
  let checked = 0;
  for (const [label, artifact] of artifacts) {
    if (!artifact) continue;
    checked += 1;
    const codeLess = codeLessProfiledRetrieves(artifact.bundle);
    const subdividing = codeLess
      .filter((key) => {
        const [type, profile] = key.split(" ") as [string, string];
        return SOLE_PROFILE_OF_TYPE[type] !== profile;
      })
      .map((key) => key.split(" ")[1]);
    assert.deepEqual(
      subdividing,
      [...trusted],
      `${label}: a code-less retrieve of a profile that picks out part of its type is read by type unless it is trusted; ` +
        `found ${JSON.stringify(codeLess)}`,
    );
  }
  assert.ok(checked > 0, "CMS's cms165 artifact is committed, so at least one artifact is checked");
});

test("the code-less retrieves in CMS's cms165 artifact, as of its vendoring (#591)", () => {
  // Pinned so a re-vendor that changes the list is read by a person, not just re-derived.
  const artifact = loadOfficialArtifact("cms165");
  assert.ok(artifact, "CMS's cms165 artifact is committed");
  assert.deepEqual(codeLessProfiledRetrieves(artifact.bundle), [
    `Encounter ${QICORE}qicore-encounter`,
    `Medication ${QICORE}qicore-medication`,
    `MedicationRequest ${QICORE}qicore-medicationrequest`,
    "Observation http://hl7.org/fhir/us/core/StructureDefinition/us-core-blood-pressure",
    `Patient ${QICORE}qicore-patient`,
  ]);
});
