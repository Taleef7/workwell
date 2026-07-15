import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

test("parseArgs defaults to both measures and accepts measure/content overrides", async () => {
  const module = await import("./official-cases.ts").catch(() => null);
  assert.ok(module, "official-cases CLI module must exist");

  assert.deepEqual(module.parseArgs([]), { measures: ["cms122", "cms125"] });
  assert.deepEqual(module.parseArgs(["--measure", "cms122"]), { measures: ["cms122"] });
  assert.deepEqual(module.parseArgs(["--measure", "cms125", "--content-dir", "../fixtures"]), {
    measures: ["cms125"],
    contentDir: "../fixtures",
  });
  assert.throws(() => module.parseArgs(["--measure", "cms130"]), /cms122\|cms125/);
  assert.throws(() => module.parseArgs(["--content-dir"]), /needs a value/);
  assert.throws(() => module.parseArgs(["--unknown"]), /unknown argument/);
});

test("exitCodeForRuns distinguishes adjusted agreement from mismatches and errors", async () => {
  const module = await import("./official-cases.ts").catch(() => null);
  assert.ok(module, "official-cases CLI module must exist");
  assert.equal(typeof module.exitCodeForRuns, "function", "exit-code policy must be exported");
  const run = (unexpectedMismatches: number, errors: number) => ({
    summary: { total: 1, expectedAgreements: 0, referenceAgreements: 0, unexpectedMismatches, errors },
  });
  assert.equal(module.exitCodeForRuns([run(0, 0)]), 0);
  assert.equal(module.exitCodeForRuns([run(1, 0)]), 1);
  assert.equal(module.exitCodeForRuns([run(0, 1)]), 1);
});

test("main loads a selected measure without overwriting the committed combined report", async () => {
  const module = await import("./official-cases.ts").catch(() => null);
  assert.ok(module, "official-cases CLI module must exist");
  assert.equal(typeof module.main, "function", "CLI main must be exported");
  const loadedMeasures: Array<{ contentDir: string; measure: string }> = [];
  const writes: Array<{ path: string; markdown: string }> = [];
  const fakeLoaded = { measure: "cms125" };
  const fakeRun = {
    measure: "cms125",
    summary: {
      total: 66,
      expectedAgreements: 66,
      referenceAgreements: 0,
      unexpectedMismatches: 0,
      errors: 0,
    },
  };
  const testCwd = resolve("test-repo", "backend-ts");

  const code = await module.main(["--measure", "cms125", "--content-dir", "fixtures"], {
    cwd: testCwd,
    load: (contentDir, measure) => {
      loadedMeasures.push({ contentDir, measure });
      return fakeLoaded as never;
    },
    run: () => Promise.resolve(fakeRun as never),
    render: (_runs, metadata) => `# report\n${JSON.stringify(metadata)}`,
    sourceRevision: () => "source-sha",
    generatedDate: "2026-07-15",
    writeReport: (path: string, markdown: string) => {
      writes.push({ path, markdown });
    },
    log: () => undefined,
    error: () => undefined,
  });

  assert.equal(code, 0);
  assert.deepEqual(loadedMeasures, [{ contentDir: resolve(testCwd, "fixtures"), measure: "cms125" }]);
  assert.equal(writes.length, 0);
});

test("main runs the CMS122 vendored-draft drift stretch after the official batch", async () => {
  const module = await import("./official-cases.ts");
  let driftCalls = 0;
  let renderedDrift: unknown;
  const fakeLoaded = { measure: "cms122" } as never;
  const fakeRun = {
    measure: "cms122",
    summary: { total: 55, expectedAgreements: 55, referenceAgreements: 0, unexpectedMismatches: 0, errors: 0 },
  };
  const fakeDrift = { total: 55, changedCases: 3, errors: 0 };
  const testCwd = resolve("test-repo", "backend-ts");

  const code = await module.main(["--measure", "cms122"], {
    cwd: testCwd,
    load: () => fakeLoaded,
    run: () => Promise.resolve(fakeRun as never),
    loadDraftBundle: (path) => {
      assert.equal(path, resolve(testCwd, "measures", "official", "cms122v14", "CMS122FHIR-v0.5.000-FHIR.json"));
      return { resourceType: "Bundle", entry: [] } as never;
    },
    runDraftDrift: () => {
      driftCalls++;
      return Promise.resolve(fakeDrift as never);
    },
    render: (runs) => {
      renderedDrift = runs[0]!.draftDrift;
      return "# report";
    },
    sourceRevision: () => "source-sha",
    generatedDate: "2026-07-15",
    writeReport: () => undefined,
    log: () => undefined,
    error: () => undefined,
  });

  assert.equal(code, 0);
  assert.equal(driftCalls, 1);
  assert.equal(renderedDrift, fakeDrift);
});
