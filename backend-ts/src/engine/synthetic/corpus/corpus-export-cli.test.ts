import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runCorpusExport, parseArgs } from "./corpus-export-cli.ts";
import { corpusPatients } from "./corpus-patient.ts";
import { DEFAULT_CORPUS_SEED, PCPS, CLINICS } from "./corpus-parameters.ts";

test("the export writes one NDJSON per resource type plus practitioners, organizations and the manifest", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "corpus-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  await runCorpusExport({ seed: DEFAULT_CORPUS_SEED, size: 60, out });

  const files = (await readdir(out)).sort();
  assert.ok(files.includes("manifest.json"));
  assert.ok(files.includes("practitioners.ndjson"));
  assert.ok(files.includes("organizations.ndjson"));
  assert.ok(files.includes("Patient.ndjson"));
  assert.ok(files.includes("Provenance.ndjson"));

  const patients = (await readFile(join(out, "Patient.ndjson"), "utf8")).trim().split("\n");
  assert.equal(patients.length, 60);
  for (const line of patients) assert.equal(JSON.parse(line).resourceType, "Patient");

  // The directory resources are written ONCE, not per patient.
  assert.equal((await readFile(join(out, "practitioners.ndjson"), "utf8")).trim().split("\n").length, PCPS.length);
  assert.equal((await readFile(join(out, "organizations.ndjson"), "utf8")).trim().split("\n").length, CLINICS.length);

  const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.size, 60);
  assert.match(manifest.ndjsonSha256.Patient, /^[0-9a-f]{64}$/);
});

test("the manifest's digest is of the bytes actually on disk, not of a second generation pass", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "corpus-hash-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  await runCorpusExport({ seed: DEFAULT_CORPUS_SEED, size: 40, out });
  const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));

  // Re-hash every stream from the file. A digest computed over anything other than the written bytes
  // is a digest of a claim rather than of the artifact, which is the whole point of pinning it.
  for (const [name, declared] of Object.entries(manifest.ndjsonSha256 as Record<string, string>)) {
    const bytes = await readFile(join(out, `${name}.ndjson`));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), declared, `${name}.ndjson does not match its manifest digest`);
  }
});

test("the same seed and size export byte-identical NDJSON", async (t) => {
  const a = await mkdtemp(join(tmpdir(), "corpus-a-"));
  const b = await mkdtemp(join(tmpdir(), "corpus-b-"));
  t.after(() => Promise.all([rm(a, { recursive: true, force: true }), rm(b, { recursive: true, force: true })]));
  await runCorpusExport({ seed: DEFAULT_CORPUS_SEED, size: 40, out: a });
  await runCorpusExport({ seed: DEFAULT_CORPUS_SEED, size: 40, out: b });
  assert.equal(await readFile(join(a, "Patient.ndjson"), "utf8"), await readFile(join(b, "Patient.ndjson"), "utf8"));
  assert.equal(await readFile(join(a, "Provenance.ndjson"), "utf8"), await readFile(join(b, "Provenance.ndjson"), "utf8"));
});

/**
 * The export generates in BATCHES while `corpusPatients` generates in one pass. Those must produce the
 * same people: name disambiguation depends on the identities already taken, so a batch boundary that
 * reset that state would rename whoever sat on it — a patient who exists under one name in the NDJSON
 * and another in the run pipeline. The batch is 500, so 1,200 crosses two boundaries.
 */
test("batching does not change identity — the export matches a single-pass generation across batch boundaries", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "corpus-batch-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const size = 1200;
  await runCorpusExport({ seed: DEFAULT_CORPUS_SEED, size, out });

  const exported = (await readFile(join(out, "Patient.ndjson"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const inMemory = corpusPatients(DEFAULT_CORPUS_SEED, size);
  assert.equal(exported.length, size);
  for (const [i, patient] of inMemory.entries()) {
    assert.equal(exported[i]!.id, patient.externalId, `index ${i}: id`);
    assert.equal(exported[i]!.name[0].text, patient.name, `index ${i}: name — a batch boundary renamed somebody`);
    assert.equal(exported[i]!.birthDate, patient.dateOfBirth, `index ${i}: dateOfBirth`);
  }
});

test("parseArgs requires --out, rejects a non-positive size, and defaults the seed", () => {
  assert.deepEqual(parseArgs(["--out", "/tmp/x"]), { seed: DEFAULT_CORPUS_SEED, size: 20000, out: "/tmp/x" });
  assert.equal(parseArgs(["--out", "/tmp/x", "--size", "50"]).size, 50);
  assert.throws(() => parseArgs([]), /--out is required/);
  assert.throws(() => parseArgs(["--out", "/tmp/x", "--size", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--out", "/tmp/x", "--size", "abc"]), /positive integer/);
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
});
