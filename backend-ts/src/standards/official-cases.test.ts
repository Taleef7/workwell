import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FhirResource } from "./official-cases.ts";

test("parseMadieManifest maps official patient UUIDs to series and case names", async () => {
  const module = await import("./official-cases.ts").catch(() => null);
  assert.ok(module, "official-cases module must exist");

  const cases = module.parseMadieManifest(
    JSON.stringify([
      {
        testCaseId: "madie-id",
        patientId: "090ad2fc-274b-4fef-bc5a-2077dbdc28f5",
        title: "PatientAge75",
        series: "IPPass",
        description: "Correct age (age 75)",
      },
    ]),
  );

  assert.deepEqual(cases.get("090ad2fc-274b-4fef-bc5a-2077dbdc28f5"), {
    name: "IPPass PatientAge75",
    title: "PatientAge75",
    series: "IPPass",
    description: "Correct age (age 75)",
  });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("loadOfficialMeasureCases assembles loose resources and expected populations", async (t) => {
  const module = await import("./official-cases.ts");
  assert.equal(typeof module.loadOfficialMeasureCases, "function", "loader must be exported");

  const contentDir = await mkdtemp(join(tmpdir(), "workwell-official-cases-"));
  t.after(() => rm(contentDir, { recursive: true, force: true }));
  const measureName = "CMS122FHIRDiabetesAssessGT9Pct";
  const bundleDir = join(contentDir, "bundles", "measure", measureName);
  const testsDir = join(contentDir, "input", "tests", "measure", measureName);
  const caseId = "090ad2fc-274b-4fef-bc5a-2077dbdc28f5";
  const caseDir = join(testsDir, caseId);
  await mkdir(bundleDir, { recursive: true });
  await mkdir(caseDir, { recursive: true });

  await writeJson(join(bundleDir, `${measureName}-bundle.json`), {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { resource: { resourceType: "Measure", id: "measure" } },
      {
        resource: {
          resourceType: "ValueSet",
          id: "vs",
          url: "http://example.test/ValueSet/vs",
          expansion: { total: 2, contains: [{ system: "http://loinc.org", code: "1" }] },
        },
      },
    ],
  });
  await writeFile(
    join(testsDir, ".madie"),
    JSON.stringify([
      {
        patientId: caseId,
        title: "PatientAge75",
        series: "IPPass",
        description: "Correct age (age 75)",
      },
    ]),
    "utf8",
  );
  await writeJson(join(caseDir, `Patient-${caseId}.json`), {
    resourceType: "Patient",
    id: caseId,
    meta: { profile: ["http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-patient"] },
  });
  await writeJson(join(caseDir, "Observation-result.json"), {
    resourceType: "Observation",
    id: "result",
    subject: { reference: `Patient/${caseId}` },
  });
  await writeJson(join(caseDir, "MeasureReport-expected.json"), {
    resourceType: "MeasureReport",
    id: "expected",
    period: { start: "2026-01-01", end: "2026-12-31" },
    group: [
      {
        population: [
          { code: { coding: [{ code: "initial-population" }] }, count: 1 },
          { code: { coding: [{ code: "denominator" }] }, count: 1 },
          { code: { coding: [{ code: "denominator-exclusion" }] }, count: 0 },
          { code: { coding: [{ code: "numerator" }] }, count: 1 },
        ],
        measureScore: { value: 1 },
      },
    ],
  });

  const loaded = module.loadOfficialMeasureCases(contentDir, "cms122");
  assert.equal(loaded.cases.length, 1);
  assert.equal(loaded.cases[0]!.name, "IPPass PatientAge75");
  assert.equal(loaded.cases[0]!.patientId, caseId);
  assert.deepEqual(
    loaded.cases[0]!.patientBundle?.entry.map((entry) => entry.resource.resourceType),
    ["Observation", "Patient"],
  );
  assert.deepEqual(loaded.cases[0]!.expected, {
    "initial-population": 1,
    denominator: 1,
    "denominator-exclusion": 0,
    numerator: 1,
  });
  assert.deepEqual(loaded.measurementPeriod, { start: "2026-01-01", end: "2026-12-31" });
  assert.equal(loaded.valueSets.total, 1);
  assert.equal(loaded.valueSets.expanded, 1);
  assert.equal(loaded.valueSets.truncated.length, 1);
  assert.equal(loaded.valueSets.truncated[0]!.availableCodes, 1);
});

test("classifyPopulationAgreement adjusts only the six known CMS122 numerator expecteds", async () => {
  const module = await import("./official-cases.ts");
  assert.equal(typeof module.classifyPopulationAgreement, "function", "classifier must be exported");

  const expected = {
    "initial-population": 1,
    denominator: 1,
    "denominator-exclusion": 1,
    numerator: 0,
  } as const;
  const referenceActual = { ...expected, numerator: 1 };
  const known = module.classifyPopulationAgreement(
    "cms122",
    "ede0ee7a-18ab-4ba7-934c-23618f1270ea",
    expected,
    referenceActual,
  );
  assert.equal(known.status, "reference-agreement");
  assert.equal(known.pass, true);
  assert.deepEqual(known.differences, ["numerator"]);

  const unknown = module.classifyPopulationAgreement(
    "cms122",
    "090ad2fc-274b-4fef-bc5a-2077dbdc28f5",
    expected,
    referenceActual,
  );
  assert.equal(unknown.status, "mismatch");
  assert.equal(unknown.pass, false);

  const exact = module.classifyPopulationAgreement("cms125", "any-uuid", expected, expected);
  assert.equal(exact.status, "expected-agreement");
  assert.equal(exact.pass, true);
});

function loadedMeasureForRunner() {
  const patientId = "090ad2fc-274b-4fef-bc5a-2077dbdc28f5";
  return {
    measure: "cms122" as const,
    measureName: "CMS122FHIRDiabetesAssessGT9Pct",
    contentDir: "C:/official",
    measureBundle: {
      resourceType: "Bundle" as const,
      entry: [
        { resource: { resourceType: "Measure", id: "measure" } },
        {
          resource: {
            resourceType: "ValueSet",
            id: "vs",
            url: "http://example.test/ValueSet/vs",
            expansion: { total: 1, contains: [{ system: "http://loinc.org", code: "1" }] },
          },
        },
      ],
    },
    cases: [
      {
        uuid: patientId,
        name: "IPPass PatientAge75",
        title: "PatientAge75",
        series: "IPPass",
        description: "Correct age",
        patientId,
        patientBundle: {
          resourceType: "Bundle" as const,
          type: "collection",
          entry: [{ resource: { resourceType: "Patient", id: patientId } }],
        },
        expected: {
          "initial-population": 1,
          denominator: 1,
          "denominator-exclusion": 0,
          numerator: 1,
        },
        expectedScore: 1,
      },
    ],
    measurementPeriod: { start: "2026-01-01", end: "2026-12-31" },
    valueSets: { total: 1, expanded: 1, truncated: [] },
    valueSetResources: [
      {
        resourceType: "ValueSet",
        id: "vs",
        url: "http://example.test/ValueSet/vs",
        expansion: { total: 1, contains: [{ system: "http://loinc.org", code: "1" }] },
      },
    ],
  };
}

function fqmResult(patientId: string, populations: Record<string, boolean>, evaluatedResource: FhirResource[] = []) {
  return {
    results: [
      {
        patientId,
        evaluatedResource,
        detailedResults: [
          {
            populationResults: Object.entries(populations).map(([populationType, result]) => ({
              populationType,
              result,
            })),
          },
        ],
      },
    ],
  };
}

test("runOfficialMeasureCases calls Calculator once for the patient batch with literal options", async () => {
  const module = await import("./official-cases.ts");
  assert.equal(typeof module.runOfficialMeasureCases, "function", "runner must be exported");
  const loaded = loadedMeasureForRunner();
  const patientId = loaded.cases[0]!.patientId!;
  const calls: unknown[][] = [];
  const calculate = (...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve(
      fqmResult(
        patientId,
        {
          "initial-population": true,
          denominator: true,
          "denominator-exclusion": false,
          numerator: true,
        },
        [{ resourceType: "Observation", id: "result" }],
      ),
    );
  };

  const run = await module.runOfficialMeasureCases(loaded, { calculate });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.length, 3, "embedded Bundle ValueSets need no external cache argument");
  assert.equal(calls[0]![0], loaded.measureBundle);
  assert.deepEqual(calls[0]![1], [loaded.cases[0]!.patientBundle]);
  assert.deepEqual(calls[0]![2], {
    measurementPeriodStart: "2026-01-01",
    measurementPeriodEnd: "2026-12-31T23:59:59.999Z",
    calculateSDEs: false,
    calculateHTML: false,
    calculateClauseCoverage: false,
    calculateRAVs: false,
    trustMetaProfile: false,
    verboseCalculationResults: true,
  });
  assert.equal(run.trustMetaProfile, false);
  assert.equal(run.profileRetry, false);
  assert.equal(run.valueSetMode, "measure-bundle");
  assert.deepEqual(run.cases[0]!.actual, loaded.cases[0]!.expected);
  assert.equal(run.cases[0]!.agreement!.status, "expected-agreement");
  assert.deepEqual(run.summary, {
    total: 1,
    expectedAgreements: 1,
    referenceAgreements: 0,
    unexpectedMismatches: 0,
    errors: 0,
  });
});

test("runOfficialMeasureCases retries with trustMetaProfile true only after an empty retrieve signal", async () => {
  const module = await import("./official-cases.ts");
  assert.equal(typeof module.runOfficialMeasureCases, "function", "runner must be exported");
  const loaded = loadedMeasureForRunner();
  const patientId = loaded.cases[0]!.patientId!;
  const trustValues: boolean[] = [];
  const calculate = (_bundle: unknown, _patients: unknown[], options: { trustMetaProfile: boolean }) => {
    const trust = options.trustMetaProfile;
    trustValues.push(trust);
    return Promise.resolve(
      trust
        ? fqmResult(patientId, { "initial-population": true, denominator: true, numerator: true }, [
            { resourceType: "Encounter", id: "visit" },
          ])
        : fqmResult(patientId, {
            "initial-population": false,
            denominator: false,
            "denominator-exclusion": false,
            numerator: false,
          }),
    );
  };

  const run = await module.runOfficialMeasureCases(loaded, { calculate });
  assert.deepEqual(trustValues, [false, true]);
  assert.equal(run.trustMetaProfile, true);
  assert.equal(run.profileRetry, true);
  assert.equal(run.retrieveSignal, true);
});

test("renderOfficialCaseReport emits summary and per-case expected/actual population tables", async () => {
  const module = await import("./official-cases.ts");
  assert.equal(typeof module.renderOfficialCaseReport, "function", "Markdown renderer must be exported");
  const loaded = loadedMeasureForRunner();
  const patientId = loaded.cases[0]!.patientId!;
  const run = await module.runOfficialMeasureCases(loaded, {
    calculate: () =>
      Promise.resolve(
        fqmResult(
          patientId,
          {
            "initial-population": true,
            denominator: true,
            "denominator-exclusion": false,
            numerator: true,
          },
          [{ resourceType: "Observation", id: "result" }],
        ),
      ),
  });

  const markdown = module.renderOfficialCaseReport([run], {
    generatedDate: "2026-07-15",
    sourceRevision: "ca4b49516de4cbed9f92bfb7c35d97b1bf1022ab",
  });
  assert.match(markdown, /\| CMS122 \| 1 \| 1 \(100\.0%\) \| 0 \| 1 \(100\.0%\) \| 0 \| 0 \|/);
  assert.match(markdown, /\| IPPass PatientAge75 \| `090ad2fc-274b-4fef-bc5a-2077dbdc28f5` \| 1\/1 \| 1\/1 \| 0\/0 \| 1\/1 \| PASS \|/);
  assert.match(markdown, /trustMetaProfile=false/);
  assert.match(markdown, /ValueSets are consumed directly from each official measure Bundle/);
  assert.match(markdown, /ca4b49516de4cbed9f92bfb7c35d97b1bf1022ab/);
  assert.match(markdown, /\.\\scripts\\fetch-official-cases\.ps1/);
  assert.match(markdown, /pnpm test:official-cases \[--measure cms122\|cms125\]/);
});

test("runCms122DraftDrift reuses official Bundle ValueSets and counts changed population vectors", async () => {
  const module = await import("./official-cases.ts");
  assert.equal(typeof module.runCms122DraftDrift, "function", "draft drift runner must be exported");
  const loaded = loadedMeasureForRunner();
  const patientId = loaded.cases[0]!.patientId!;
  const officialRun = await module.runOfficialMeasureCases(loaded, {
    calculate: () =>
      Promise.resolve(
        fqmResult(patientId, {
          "initial-population": true,
          denominator: true,
          "denominator-exclusion": false,
          numerator: true,
        }),
      ),
  });
  officialRun.trustMetaProfile = true;
  const calls: unknown[][] = [];
  const calculate = (...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve(
      fqmResult(patientId, {
        "initial-population": true,
        denominator: true,
        "denominator-exclusion": false,
        numerator: false,
      }),
    );
  };
  const draftBundle = {
    resourceType: "Bundle" as const,
    entry: [{ resource: { resourceType: "Measure", id: "draft", version: "0.5.000" } }],
  };

  const drift = await module.runCms122DraftDrift(loaded, officialRun, draftBundle, { calculate });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.length, 4);
  assert.equal(
    (calls[0]![2] as { trustMetaProfile: boolean }).trustMetaProfile,
    true,
    "draft drift must use the official run's resolved profile mode",
  );
  assert.equal(calls[0]![3], loaded.valueSetResources);
  assert.equal(drift.total, 1);
  assert.equal(drift.changedCases, 1);
  assert.equal(drift.errors, 0);
  assert.deepEqual(drift.cases[0]!.differences, ["numerator"]);
});

test("renderOfficialCaseReport documents primary end-of-day normalization without probe prose", async () => {
  const module = await import("./official-cases.ts");
  const loaded = loadedMeasureForRunner();
  const expected = { ...loaded.cases[0]!.expected!, "denominator-exclusion": 1 };
  const actual = { ...expected, "denominator-exclusion": 0 };
  const run = {
    measure: "cms125" as const,
    measureName: "CMS125FHIRBreastCancerScreen",
    measurementPeriod: loaded.measurementPeriod,
    valueSets: loaded.valueSets,
    valueSetMode: "measure-bundle" as const,
    trustMetaProfile: false,
    profileRetry: false,
    retrieveSignal: true,
    engineWarnings: 0,
    cases: [
      {
        ...loaded.cases[0]!,
        uuid: "4cf81a94-81fb-4be2-b075-7d8f9ff02a6e",
        expected,
        actual,
        agreement: module.classifyPopulationAgreement(
          "cms125",
          "4cf81a94-81fb-4be2-b075-7d8f9ff02a6e",
          expected,
          actual,
        ),
      },
    ],
    summary: { total: 1, expectedAgreements: 0, referenceAgreements: 0, unexpectedMismatches: 1, errors: 0 },
  };
  const markdown = module.renderOfficialCaseReport([run], {
    generatedDate: "2026-07-15",
    sourceRevision: "source-sha",
  });
  assert.match(
    markdown,
    /date-only period ends are normalized to end-of-day because fqm-execution 1\.8\.5 parses them as start-of-day \(upstream issue to be filed\); the un-normalized run scores 64\/66\./,
  );
  assert.doesNotMatch(markdown, /diagnostic probe|primary table intentionally preserves/i);
});
