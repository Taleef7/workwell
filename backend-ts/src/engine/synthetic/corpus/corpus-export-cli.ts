#!/usr/bin/env -S node --import tsx
/**
 * `pnpm corpus:export --seed <seed> --size <n> --out <dir>` — the corpus as hash-pinned NDJSON.
 *
 * One file per resource type, plus `practitioners.ndjson`, `organizations.ndjson` and a `manifest.json`
 * carrying a SHA-256 of every stream. That manifest is what makes an exported corpus answerable: a
 * number computed from these files can be traced to the seed, the parameter table and the artifact
 * versions that produced them.
 *
 * STREAMING IS THE POINT, not an optimisation. 20,000 patients is roughly 200,000 resources; holding
 * their bundles in an array to write at the end costs gigabytes and would make the export the one part
 * of this system that cannot run at the size it exists for. Patients are generated in batches, written
 * as they are produced, and hashed incrementally — memory stays flat in the size of a batch.
 *
 * The output is deliberately NOT written into the repo (D3): it is derived data, reproducible from
 * (seed, size) at any time, and committing it would put 200,000 synthetic clinical resources in git.
 */
import { createHash, type Hash } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { corpusPatients, patientAt } from "./corpus-patient.ts";
import { bundleForPatient, organizationResources, practitionerResources } from "./corpus-bundle.ts";
import { buildManifest } from "./corpus-manifest.ts";
import { DEFAULT_CORPUS_SEED } from "./corpus-parameters.ts";

/** Generated in batches so memory stays flat; 500 is small enough to be cheap and large enough to amortise. */
const BATCH = 500;

export interface CorpusExportOptions {
  readonly seed: string;
  readonly size: number;
  readonly out: string;
  /** The date the bundles are built against; defaults to the corpus measurement year's end. */
  readonly evaluationDate?: string;
  readonly generatedAt?: string;
}

export interface CorpusExportResult {
  readonly out: string;
  readonly size: number;
  readonly resourceCounts: Record<string, number>;
  readonly ndjsonSha256: Record<string, string>;
}

/** One open NDJSON stream plus the running digest of exactly the bytes written to it. */
interface Sink {
  readonly stream: WriteStream;
  readonly hash: Hash;
  count: number;
}

function sinkFor(sinks: Map<string, Sink>, dir: string, name: string): Sink {
  const existing = sinks.get(name);
  if (existing) return existing;
  const sink: Sink = { stream: createWriteStream(join(dir, `${name}.ndjson`)), hash: createHash("sha256"), count: 0 };
  sinks.set(name, sink);
  return sink;
}

/**
 * Write one line, respecting backpressure.
 *
 * `stream.write` returning false means the buffer is full; ignoring that is how a 200,000-resource
 * export turns into unbounded memory growth despite being "streamed". The digest is updated from the
 * same string that is written, so the hash describes the file rather than an approximation of it.
 */
async function writeLine(sink: Sink, value: unknown): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  sink.hash.update(line);
  sink.count += 1;
  if (!sink.stream.write(line)) await once(sink.stream, "drain");
}

export async function runCorpusExport(options: CorpusExportOptions): Promise<CorpusExportResult> {
  const { seed, size } = options;
  if (!Number.isInteger(size) || size <= 0) throw new Error(`--size must be a positive integer, got ${size}`);
  const out = resolve(options.out);
  mkdirSync(out, { recursive: true });
  const evaluationDate = options.evaluationDate ?? "2027-12-31";

  const sinks = new Map<string, Sink>();

  // The directory resources are written once, not per patient: every bundle references them and
  // repeating them 20,000 times would be the same fact restated rather than more data.
  const practitioners = sinkFor(sinks, out, "practitioners");
  for (const p of practitionerResources()) await writeLine(practitioners, p);
  const organizations = sinkFor(sinks, out, "organizations");
  for (const o of organizationResources()) await writeLine(organizations, o);

  // `taken` threads identity across the whole run so name disambiguation matches a single
  // `corpusPatients(seed, size)` call exactly — batching must not change who anybody is.
  const taken = new Set<string>();
  for (let start = 0; start < size; start += BATCH) {
    const end = Math.min(start + BATCH, size);
    for (let index = start; index < end; index += 1) {
      const patient = patientAt(seed, index, taken);
      taken.add(`${patient.name}|${patient.dateOfBirth}`);
      for (const { resource } of bundleForPatient(patient, evaluationDate, seed).entry) {
        const type = (resource as { resourceType: string }).resourceType;
        await writeLine(sinkFor(sinks, out, type), resource);
      }
    }
  }

  const ndjsonSha256: Record<string, string> = {};
  const resourceCounts: Record<string, number> = {};
  for (const [name, sink] of sinks) {
    sink.stream.end();
    await once(sink.stream, "close");
    ndjsonSha256[name] = sink.hash.digest("hex");
    resourceCounts[name] = sink.count;
  }

  // The manifest is written LAST and describes what was actually written. Building it from a second
  // generation pass would be a different corpus if anything ever drifted; the counts above come from
  // the same traversal that produced the bytes.
  const manifest = buildManifest({
    seed,
    patients: corpusPatients(seed, size),
    ndjsonSha256,
    ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
  });
  await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return { out, size, resourceCounts, ndjsonSha256 };
}

export function parseArgs(argv: readonly string[]): CorpusExportOptions {
  let seed = DEFAULT_CORPUS_SEED;
  let size = 20000;
  let out = "";
  let evaluationDate: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--seed") seed = argv[++i]!;
    else if (arg === "--size") size = Number(argv[++i]);
    else if (arg === "--out") out = argv[++i]!;
    else if (arg === "--evaluation-date") evaluationDate = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out) throw new Error("--out is required");
  if (!Number.isInteger(size) || size <= 0) throw new Error(`--size must be a positive integer, got ${size}`);
  return { seed, size, out, ...(evaluationDate ? { evaluationDate } : {}) };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("corpus-export-cli.ts")) {
  const started = Date.now();
  runCorpusExport(parseArgs(process.argv.slice(2)))
    .then((result) => {
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`corpus:export: ${result.size} patients → ${result.out} in ${seconds}s`);
      for (const [name, count] of Object.entries(result.resourceCounts).sort()) {
        console.log(`  ${name.padEnd(20)} ${String(count).padStart(8)}  sha256:${result.ndjsonSha256[name]!.slice(0, 16)}…`);
      }
    })
    .catch((error) => {
      console.error(`corpus:export: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
