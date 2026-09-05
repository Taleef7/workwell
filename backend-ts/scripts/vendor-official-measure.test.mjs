import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./vendor-official-measure.mjs", import.meta.url));

/** Walk a directory as the manifest hash defines it: case dirs sorted by name, files within sorted. */
async function sortedCaseFiles(root) {
  const entries = [];
  const visit = async (dir, prefix = "") => {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, dirent.name);
      if (dirent.isDirectory()) await visit(path, prefix ? prefix + "/" + dirent.name : dirent.name);
      else entries.push({ relativePath: (prefix ? prefix + "/" : "") + dirent.name, bytes: await readFile(path) });
    }
  };
  await visit(root);
  return entries;
}

async function makeContentDir() {
  const contentDir = await mkdtemp(join(tmpdir(), "workwell-vendor-tests-"));
  const measureName = "CMS68FHIRDocumentationCurrentMeds";
  const testsDir = join(contentDir, "input", "tests", "measure", measureName);
  const caseId = "case-b";
  const caseDir = join(testsDir, caseId);
  await mkdir(caseDir, { recursive: true });
  await writeFile(join(testsDir, ".madie"), JSON.stringify([{ patientId: caseId }]), "utf8");
  await writeFile(
    join(caseDir, "MeasureReport-expected.json"),
    JSON.stringify({
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
    }),
  );
  return { contentDir, measureName, testsDir };
}

test("vendor script --tests-only copies cases and records the sorted hash in the manifest", async (t) => {
  const { contentDir, testsDir } = await makeContentDir();
  t.after(() => rm(contentDir, { recursive: true, force: true }));
  const outRoot = join(contentDir, "vendored");

  execFileSync(process.execPath, [
    SCRIPT,
    "--measure", "CMS68FHIRDocumentationCurrentMeds",
    "--catalog-id", "cms68",
    "--content-dir", contentDir,
    "--tests-only",
    "--output-dir", outRoot,
  ], { stdio: "pipe" });

  const vendoredTests = join(outRoot, "cms68", "tests");
  const copied = await sortedCaseFiles(vendoredTests);
  assert.deepEqual(copied.map((entry) => entry.relativePath), ["case-b/MeasureReport-expected.json"]);

  const manifest = JSON.parse(await readFile(join(outRoot, "cms68", "manifest.json"), "utf8"));
  assert.equal(manifest.tests.count, 1);
  assert.equal(manifest.tests.sourcePath, "input/tests/measure/CMS68FHIRDocumentationCurrentMeds");
  const expectedHash = createHash("sha256");
  for (const entry of copied) {
    expectedHash.update(`${entry.relativePath}\n`);
    expectedHash.update(entry.bytes);
  }
  assert.equal(manifest.tests.sha256, `sha256:${expectedHash.digest("hex")}`);
  assert.equal(await readFile(join(vendoredTests, "case-b", "MeasureReport-expected.json"), "utf8"),
    await readFile(join(testsDir, "case-b", "MeasureReport-expected.json"), "utf8"));
});

test("vendor script --tests-only is byte-idempotent on an already-vendored measure", async (t) => {
  const { contentDir } = await makeContentDir();
  t.after(() => rm(contentDir, { recursive: true, force: true }));
  const outRoot = join(contentDir, "vendored");
  const argv = [
    SCRIPT,
    "--measure", "CMS68FHIRDocumentationCurrentMeds",
    "--catalog-id", "cms68",
    "--content-dir", contentDir,
    "--tests-only",
    "--output-dir", outRoot,
  ];
  execFileSync(process.execPath, argv, { stdio: "pipe" });
  const manifestBefore = await readFile(join(outRoot, "cms68", "manifest.json"));
  const caseBefore = await readFile(join(outRoot, "cms68", "tests", "case-b", "MeasureReport-expected.json"));

  execFileSync(process.execPath, argv, { stdio: "pipe" });

  assert.deepEqual(await readFile(join(outRoot, "cms68", "manifest.json")), manifestBefore);
  assert.deepEqual(await readFile(join(outRoot, "cms68", "tests", "case-b", "MeasureReport-expected.json")), caseBefore);
});

test("vendor script --tests-only fails and names a corrupted upstream case file", async (t) => {
  const { contentDir } = await makeContentDir();
  t.after(() => rm(contentDir, { recursive: true, force: true }));
  const outDir = join(contentDir, "vendored", "cms68");
  await writeFile(join(contentDir, "input", "tests", "measure", "CMS68FHIRDocumentationCurrentMeds", "case-b", "Patient.json"),
    "{ not json", "utf8");

  let stderr = "";
  try {
    execFileSync(process.execPath, [
      SCRIPT,
      "--measure", "CMS68FHIRDocumentationCurrentMeds",
      "--catalog-id", "cms68",
      "--content-dir", contentDir,
      "--tests-only",
      "--output-dir", outDir,
    ], { stdio: "pipe" });
    assert.fail("expected the vendor script to fail on malformed JSON");
  } catch (error) {
    stderr = error.stderr?.toString() ?? "";
    assert.match(stderr, /Patient\.json/);
  }
  assert.ok(stderr.includes("Patient.json"), `error must name the file, got: ${stderr}`);
});

test("loadOfficialMeasureCases refuses a vendored tests dir whose bytes do not match the manifest hash", async (t) => {
  const module = await import("../src/standards/official-cases.ts");
  const contentDir = await mkdtemp(join(tmpdir(), "workwell-official-cases-"));
  t.after(() => rm(contentDir, { recursive: true, force: true }));
  const measureName = "CMS68FHIRDocumentationCurrentMeds";
  const bundleDir = join(contentDir, "bundles", "measure", measureName);
  const upstreamTests = join(contentDir, "input", "tests", "measure", measureName);
  const artifactDir = join(contentDir, "measures", "official", "cms68");
  const vendoredTests = join(artifactDir, "tests");
  const caseId = "case-a";
  await mkdir(bundleDir, { recursive: true });
  await mkdir(upstreamTests, { recursive: true });

  await writeFile(join(bundleDir, `${measureName}-bundle.json`), JSON.stringify({
    resourceType: "Bundle",
    type: "collection",
    entry: [{ resource: { resourceType: "Measure", id: "measure" } }],
  }), "utf8");

  await writeFile(join(upstreamTests, "case-upstream"), "upstream", "utf8");
  await mkdir(join(vendoredTests, caseId), { recursive: true });
  await writeFile(join(vendoredTests, caseId, "Patient.json"), JSON.stringify({
    resourceType: "Patient",
    id: caseId,
    meta: { profile: ["http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-patient"] },
  }), "utf8");
  await writeFile(join(vendoredTests, caseId, "MeasureReport-expected.json"), JSON.stringify({
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
  }), "utf8");

  const manifest = { tests: { count: 1, sourcePath: "input/tests/measure/CMS68FHIRDocumentationCurrentMeds", sha256: "sha256:abc" } };
  await writeFile(join(artifactDir, "manifest.json"), JSON.stringify(manifest), "utf8");

  let error;
  try {
    module.loadOfficialMeasureCases(contentDir, "cms68");
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  assert.match(error.message, /tests\.sha256/);
});

test("loadOfficialMeasureCases prefers a vendored tests dir over the upstream one when its hash matches", async (t) => {
  const module = await import("../src/standards/official-cases.ts");
  const contentDir = await mkdtemp(join(tmpdir(), "workwell-official-cases-ok-"));
  t.after(() => rm(contentDir, { recursive: true, force: true }));
  const measureName = "CMS68FHIRDocumentationCurrentMeds";
  const bundleDir = join(contentDir, "bundles", "measure", measureName);
  const upstreamTests = join(contentDir, "input", "tests", "measure", measureName);
  const artifactDir = join(contentDir, "measures", "official", "cms68");
  const vendoredTests = join(artifactDir, "tests");
  const vendoredCaseId = "case-vendored";
  const upstreamCaseId = "case-upstream";

  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, `${measureName}-bundle.json`), JSON.stringify({
    resourceType: "Bundle",
    type: "collection",
    entry: [{ resource: { resourceType: "Measure", id: "measure" } }],
  }), "utf8");

  // An upstream deck that MUST be ignored: a different case id, so reading it is visible in the result.
  const upstreamCaseDir = join(upstreamTests, upstreamCaseId);
  await mkdir(upstreamCaseDir, { recursive: true });
  await writeFile(join(upstreamTests, ".madie"), JSON.stringify([{ patientId: upstreamCaseId }]), "utf8");
  await writeFile(join(upstreamCaseDir, "Patient.json"), JSON.stringify({ resourceType: "Patient", id: upstreamCaseId }), "utf8");

  const caseFiles = {
    "Patient.json": JSON.stringify({
      resourceType: "Patient",
      id: vendoredCaseId,
      meta: { profile: ["http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-patient"] },
    }),
    "MeasureReport-expected.json": JSON.stringify({
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
    }),
  };
  await mkdir(join(vendoredTests, vendoredCaseId), { recursive: true });
  for (const [name, body] of Object.entries(caseFiles)) {
    await writeFile(join(vendoredTests, vendoredCaseId, name), body, "utf8");
  }
  await writeFile(join(vendoredTests, ".madie"), JSON.stringify([{ patientId: vendoredCaseId, title: "Vendored", series: "Deck" }]), "utf8");

  // The hash the reader recomputes: case dirs sorted, files within sorted, `relativePath + "\n" + bytes`.
  // `.madie` sits at the deck root rather than in a case dir, so it is outside the hash by construction.
  const hash = createHash("sha256");
  let count = 0;
  for (const name of Object.keys(caseFiles).sort((a, b) => a.localeCompare(b))) {
    hash.update(`${vendoredCaseId}/${name}\n`);
    hash.update(Buffer.from(caseFiles[name], "utf8"));
    count += 1;
  }
  await writeFile(join(artifactDir, "manifest.json"), JSON.stringify({
    tests: {
      count,
      sourcePath: `input/tests/measure/${measureName}`,
      sha256: `sha256:${hash.digest("hex")}`,
    },
  }), "utf8");

  const loaded = module.loadOfficialMeasureCases(contentDir, "cms68");
  assert.deepEqual(loaded.cases.map((entry) => entry.uuid), [vendoredCaseId]);
  assert.equal(loaded.cases[0].loadError, undefined);
  assert.equal(loaded.cases[0].patientId, vendoredCaseId);
  assert.equal(loaded.cases[0].series, "Deck");
});
