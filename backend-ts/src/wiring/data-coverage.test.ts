/**
 * Data coverage (#776): what each routed measure reads, computed from its committed artifact, against what
 * WebChart ingest supplies. Always on: every input is a committed file.
 *   node --import tsx --test src/wiring/data-coverage.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { measureDataRequirements } from "../standards/measure-data-requirements.ts";
import { COMPOSED_RESOURCE_TYPES } from "../engine/ingress/webchart/webchart-client.ts";
import { WEBCHART_SERVED_RESOURCES } from "../engine/ingress/webchart/served-resources.ts";
import { dataCoverage, NOT_SERVED_REASONS, UNSTAMPED_PROFILE_REASON } from "./data-coverage.ts";
import { loadDerivedArtifact, loadOfficialArtifact } from "./official-artifacts.ts";
import { PROFILES_STAMPED_AT_PREPARATION } from "./qicore-preparation.ts";
import { resolveDeploymentProfile } from "../config/deployment-profile.ts";

const OFFICIAL_DIR = fileURLToPath(new URL("../../measures/official/", import.meta.url));
const MAUI = resolveDeploymentProfile("maui").runnableMeasureIds;

/** MADiE's own pruned answer, from the `effective-data-requirements` Library a CMS bundle carries. */
function effectiveDataRequirementTypes(bundle: unknown): string[] | null {
  const measure = ((bundle as { entry: Array<{ resource: Record<string, unknown> }> }).entry)
    .map((entry) => entry.resource)
    .find((resource) => resource["resourceType"] === "Measure")!;
  const library = ((measure["contained"] as Array<Record<string, unknown>> | undefined) ?? []).find(
    (resource) => resource["id"] === "effective-data-requirements",
  );
  if (!library) return null;
  return [...new Set(((library["dataRequirement"] as Array<{ type: string }>) ?? []).map((requirement) => requirement.type))].sort();
}

test("#776: the walk finds exactly the types MADiE's effective data requirements list, for every vendored CMS artifact", () => {
  const ids = readdirSync(OFFICIAL_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  let compared = 0;
  for (const id of ids) {
    const artifact = loadOfficialArtifact(id);
    if (!artifact) continue;
    const expected = effectiveDataRequirementTypes(artifact.bundle);
    assert.ok(expected, `${id}: the CMS bundle carries no effective-data-requirements Library to compare with`);
    // `Resource` is MADiE recording an element read on the abstract type (cms138, `mustSupport: id`), not a
    // retrieve: no ingest can supply "a Resource". Named so that any other difference still fails.
    const madie = id === "cms138" ? expected.filter((type) => type !== "Resource") : expected;
    assert.deepEqual(measureDataRequirements(artifact.bundle).map((requirement) => requirement.type), madie, id);
    compared++;
  }
  assert.ok(compared >= 6, `compared ${compared} artifacts; the six routed measures alone should be here`);
});

test("#776: a translation is walked like CMS's artifact, and CMS137v15's reads what CMS137 does", () => {
  // The translation has no effective-data-requirements Library (derived-identity.ts removes it), and its
  // includes name libraries bare (`FHIRHelpers`), not by MADiE canonical: the walk must resolve both forms.
  const translation = loadDerivedArtifact("cms137");
  assert.ok(translation, "the cms137 translation is committed");
  assert.equal(effectiveDataRequirementTypes(translation.bundle), null);
  assert.deepEqual(measureDataRequirements(translation.bundle), measureDataRequirements(loadOfficialArtifact("cms137")!.bundle));
});

/** A minimal measure bundle: libraries as `{ name, includes, defs }`, ELM base64-encoded as MADiE ships it. */
function fixtureBundle(libraries: Array<{ name: string; includes?: Record<string, string>; defs: Array<Record<string, unknown>> }>) {
  const library = (lib: (typeof libraries)[number]) => ({
    resourceType: "Library",
    name: lib.name,
    url: `https://example.org/Library/${lib.name}`,
    content: [
      {
        contentType: "application/elm+json",
        data: Buffer.from(
          JSON.stringify({
            library: {
              identifier: { id: lib.name },
              includes: { def: Object.entries(lib.includes ?? {}).map(([localIdentifier, path]) => ({ localIdentifier, path })) },
              statements: { def: lib.defs },
            },
          }),
        ).toString("base64"),
      },
    ],
  });
  const criteria = (expression: string) => ({ criteria: { language: "text/cql-identifier", expression } });
  return {
    resourceType: "Bundle",
    entry: [
      {
        resource: {
          resourceType: "Measure",
          library: ["https://example.org/Library/Main|1.0.0"],
          group: [{ population: [criteria("Initial Population")], stratifier: [criteria("Strat")] }],
          supplementalData: [criteria("SDE Payer")],
        },
      },
      ...libraries.map((lib) => ({ resource: library(lib) })),
    ],
  };
}

const retrieve = (type: string, templateId?: string) => ({ type: "Retrieve", dataType: `{http://hl7.org/fhir}${type}`, ...(templateId ? { templateId } : {}) });

test("#776: the walk follows criteria through expression and function references across libraries, and nothing else", () => {
  const bundle = fixtureBundle([
    {
      name: "Main",
      includes: { Common: "https://example.org/Common" },
      defs: [
        { name: "Initial Population", type: "ExpressionDef", expression: { type: "Exists", operand: { type: "Query", source: [{ expression: retrieve("Encounter") }], where: { type: "ExpressionRef", name: "Labs", libraryName: "Common" } } } },
        { name: "Strat", type: "ExpressionDef", expression: retrieve("Condition", "https://example.org/condition") },
        { name: "SDE Payer", type: "ExpressionDef", expression: retrieve("Coverage") },
        { name: "Never Reached", type: "ExpressionDef", expression: retrieve("DeviceRequest") },
      ],
    },
    {
      name: "Common",
      defs: [
        { name: "Labs", type: "ExpressionDef", expression: { type: "FunctionRef", name: "Helper", operand: [] } },
        { name: "Helper", type: "FunctionDef", expression: retrieve("Observation", "https://example.org/lab") },
        { name: "Helper", type: "FunctionDef", expression: retrieve("Observation", "https://example.org/vital") },
      ],
    },
  ]);
  assert.deepEqual(measureDataRequirements(bundle), [
    { type: "Condition", forScore: true, forSde: false, profiles: ["https://example.org/condition"] },
    { type: "Coverage", forScore: false, forSde: true, profiles: [] },
    { type: "Encounter", forScore: true, forSde: false, profiles: [] },
    // Both overloads of a function are read: an overcount, never an undercount.
    { type: "Observation", forScore: true, forSde: false, profiles: ["https://example.org/lab", "https://example.org/vital"] },
  ]);

  // A walk that cannot follow a reference refuses rather than reporting a measure as needing less.
  const dangling = fixtureBundle([{ name: "Main", defs: [{ name: "Initial Population", expression: { type: "ExpressionRef", name: "Gone" } }, { name: "Strat", expression: null }, { name: "SDE Payer", expression: null }] }]);
  assert.throws(() => measureDataRequirements(dangling), /Main has no definition Gone/);
  const unknownLibrary = fixtureBundle([{ name: "Main", defs: [{ name: "Initial Population", expression: { type: "ExpressionRef", name: "X", libraryName: "Nope" } }, { name: "Strat", expression: null }, { name: "SDE Payer", expression: null }] }]);
  assert.throws(() => measureDataRequirements(unknownLibrary), /Main references Nope, which is not in the bundle/);
});

test("#776: the coverage of every logic the Maui sandbox scores with is pinned", () => {
  // Removing a type from what ingest serves, a measure starting to read a new type, or a stamp going away
  // all change this table, and each is a change to what WorkWell can compute from WebChart data.
  const compact = Object.fromEntries(
    dataCoverage(MAUI).map((table) => [
      `${table.measureId} ${table.kind}`,
      table.rows.map((row) => `${row.type} ${row.forScore ? (row.forSde ? "score+SDE" : "score") : "SDE"} ${row.status}`),
    ]),
  );
  const cmsWithDevices = [
    "Condition score served",
    "Coverage SDE not served",
    "DeviceRequest score not served",
    "Encounter score served",
    "Medication score not served",
    "MedicationRequest score not served",
    "Observation score served",
    "Patient score+SDE served",
    "Procedure score served",
    "ServiceRequest score not served",
  ];
  const withoutDevices = cmsWithDevices.filter((row) => !row.startsWith("DeviceRequest"));
  assert.deepEqual(compact, {
    "cms122 cms-artifact": cmsWithDevices,
    "cms125 cms-artifact": cmsWithDevices,
    "cms2 cms-artifact": withoutDevices,
    "cms130 cms-artifact": cmsWithDevices,
    // Retrieves by profile, and ingest stamps only the blood pressure one.
    "cms165 cms-artifact": [
      "Condition score not served",
      "Coverage SDE not served",
      "DeviceRequest score not served",
      "Encounter score not served",
      "Medication score not served",
      "MedicationRequest score not served",
      "Observation score partial",
      "Patient score+SDE not served",
      "Procedure score not served",
      "ServiceRequest score not served",
    ],
    "cms137 cms-artifact": withoutDevices,
    "cms137 workwell-translation": withoutDevices,
  });
});

test("#776: every type a routed measure reads and ingest does not supply has a reason, and no reason is stale", () => {
  const tables = dataCoverage(MAUI);
  for (const table of tables) {
    for (const row of table.rows) {
      if (row.status === "served") assert.equal(row.reason, null, `${table.measureId} ${row.type}`);
      else assert.ok(row.reason, `${table.measureId} reads ${row.type}, which ingest does not supply, and no reason says why`);
      if (row.status !== "served" && row.how !== null) assert.equal(row.reason, UNSTAMPED_PROFILE_REASON, `${table.measureId} ${row.type}`);
    }
  }
  // A reason for a type ingest now supplies, or no measure reads, is a claim nothing backs.
  const unsupplied = new Set(tables.flatMap((table) => table.rows.filter((row) => row.how === null).map((row) => row.type)));
  assert.deepEqual(Object.keys(NOT_SERVED_REASONS).sort(), [...unsupplied].sort());
});

test("#776: the client fetches exactly the served table's fetched types, in the order it always has", () => {
  assert.deepEqual([...COMPOSED_RESOURCE_TYPES], ["Observation", "Condition", "Procedure", "Immunization", "Encounter"]);
  assert.deepEqual(
    [...COMPOSED_RESOURCE_TYPES],
    WEBCHART_SERVED_RESOURCES.filter((resource) => resource.how === "fetched").map((resource) => resource.type),
  );
});

test("#776: the stamped-profile list names every profile preparation stamps", () => {
  // Read from the source: a new `stampProfile(resource, X)` that is not in the list would make the report
  // call a stamped type unserved, and one in the list with no call would claim a stamp that never happens.
  const source = readFileSync(fileURLToPath(new URL("./qicore-preparation.ts", import.meta.url)), "utf8");
  const constants = new Map([...source.matchAll(/^const ([A-Z_]+) = "([^"]+)";/gm)].map((match) => [match[1]!, match[2]!]));
  const stamped = [...source.matchAll(/stampProfile\(\s*\w+\s*,\s*([A-Z_]+)\s*\)/g)].map((match) => {
    const value = constants.get(match[1]!);
    assert.ok(value, `stampProfile is called with ${match[1]}, which this test cannot resolve to a string`);
    return value;
  });
  assert.ok(stamped.length > 0, "found no stampProfile call; the scan is stale");
  assert.deepEqual([...new Set(stamped)].sort(), [...PROFILES_STAMPED_AT_PREPARATION].sort());
});
