import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  // `.madie` is vendored too: it names every case (patientId/title/series), and a deck without it
  // cannot be loaded at all. Copying case directories only produced a deck the reader could not open.
  assert.deepEqual(copied.map((entry) => entry.relativePath), [".madie", "case-b/MeasureReport-expected.json"]);

  const manifest = JSON.parse(await readFile(join(outRoot, "cms68", "manifest.json"), "utf8"));
  assert.equal(manifest.tests.count, 2, "the count covers the whole deck, .madie included");
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

/**
 * The vendored deck is anchored to the MODULE (`backend-ts/measures/official/<id>/tests`), not to
 * `--content-dir`, so these can no longer be driven by building a fake content directory — and that
 * is the point. The previous versions of these two tests hand-built a `contentDir` containing
 * `measures/official/cms68/`, a layout `vendor-official-measure.mjs` never produces, and passed while
 * the real loader resolved the vendored path against the content checkout, found nothing, and silently
 * fell back to the upstream deck for every real invocation. The guard was dead and its test agreed.
 *
 * So: the integrity check is exercised directly, and the wiring is exercised against the real deck.
 */
test("verifyVendoredTestsHash accepts the bytes it hashed and rejects any change to them", async (t) => {
  const { verifyVendoredTestsHash } = await import("../src/standards/official-cases.ts");
  const root = await mkdtemp(join(tmpdir(), "workwell-deck-hash-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const caseDir = join(root, "case-a");
  await mkdir(caseDir, { recursive: true });
  await writeFile(join(root, ".madie"), '[{"patientId":"case-a","title":"T","series":"S"}]', "utf8");
  await writeFile(join(caseDir, "Patient.json"), '{"resourceType":"Patient","id":"case-a"}', "utf8");

  const files = await sortedCaseFiles(root);
  const hash = createHash("sha256");
  for (const entry of files) {
    hash.update(`${entry.relativePath}\n`);
    hash.update(entry.bytes);
  }
  const manifestTests = { count: files.length, sha256: `sha256:${hash.digest("hex")}` };
  // The deck-root metadata is inside the hash: a swapped `.madie` renames every case while every
  // population vector still matches, which is exactly the change nobody would notice.
  assert.equal(files.length, 2);
  assert.doesNotThrow(() => verifyVendoredTestsHash(root, manifestTests, "CMS68"));

  await writeFile(join(caseDir, "Patient.json"), '{"resourceType":"Patient","id":"tampered"}', "utf8");
  assert.throws(() => verifyVendoredTestsHash(root, manifestTests, "CMS68"), /integrity check/);

  await writeFile(join(caseDir, "Patient.json"), '{"resourceType":"Patient","id":"case-a"}', "utf8");
  await writeFile(join(root, ".madie"), '[{"patientId":"case-a","title":"OTHER","series":"S"}]', "utf8");
  assert.throws(() => verifyVendoredTestsHash(root, manifestTests, "CMS68"), /integrity check/,
    "a swapped .madie must fail too — it names every case");
});

// Needs the upstream content checkout for the measure BUNDLE (the deck itself is committed). The
// default `pnpm test` job does not fetch `.official-content`, so this self-skips there and is listed
// explicitly in ci.yml's official-cases job, which does — the rule that job's own comment states: a
// test that needs the checkout must be added there or it is permanently skipped while reading as
// covered.
const CONTENT_DIR = fileURLToPath(new URL("../.official-content", import.meta.url));
const noContentCheckout = existsSync(join(CONTENT_DIR, "bundles"))
  ? false
  : "no .official-content checkout — run scripts/fetch-official-cases.ps1 (CI: the official-cases job)";

test("loadOfficialMeasureCases reads the deck committed in this repo, hash-verified", { skip: noContentCheckout }, async () => {
  const { loadOfficialMeasureCases } = await import("../src/standards/official-cases.ts");
  const contentDir = fileURLToPath(new URL("../.official-content", import.meta.url));
  const loaded = loadOfficialMeasureCases(contentDir, "cms68");
  // 19 is the committed deck size for cms68; it comes from measures/official/cms68/tests, and the
  // manifest hash was verified on the way in or this call would have thrown.
  assert.equal(loaded.cases.length, 19);
  assert.ok(loaded.cases.every((c) => c.loadError === undefined), "every case loaded");
  assert.ok(loaded.cases.every((c) => c.series && c.title), "metadata came from the vendored .madie");
});
