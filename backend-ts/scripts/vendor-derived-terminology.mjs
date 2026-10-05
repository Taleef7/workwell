#!/usr/bin/env node
/**
 * The terminology sidecar for a WorkWell TRANSLATION (`measures/derived/<id>/`, decision 3, PR #763).
 *
 *   node scripts/vendor-derived-terminology.mjs --catalog-id cms137 --verify-pin
 *   node scripts/vendor-derived-terminology.mjs --catalog-id cms137 --emit-block \
 *     --base-terminology measures/official/cms137/terminology.json \
 *     --vsac-manifest http://cts.nlm.nih.gov/fhir/Library/ecqm-update-2026-05-14
 *
 * ## Why this is not `vendor-official-measure.mjs --complete-terminology`
 *
 * An official artifact's terminology is CMS's own, shipped in its bundle, and VSAC only patches what
 * upstream capped or omitted. A translation has no such source: it exists because CMS publishes no FHIR
 * content for the year it covers, so EVERY value set its ELM declares is re-expanded at the VSAC release
 * its manifest pins. There is nothing to fall back to, so there is no fallback: each set goes through
 * `expandComplete`, which throws on anything not provably the whole set, and one refusal fails the run
 * with nothing written. A partial sidecar would hash differently from the pin anyway, but "refused at the
 * deploy step, naming the OID" is a far better failure than "refused at boot, naming a hash".
 *
 * ## Two modes
 *
 * - **verify** (the default, and what the deploy runs): the release is the one the COMMITTED manifest
 *   names (`terminology.completion.manifest`). `--vsac-manifest` is refused here, so no flag in a
 *   workflow can make the deploy expand at a release the manifest does not record. `--verify-pin` then
 *   exits 1 unless the written bytes hash to `terminology.sha256` and every declared set is present,
 *   non-empty and uncapped. That gate has to be HERE: the worker boots even when the router refuses a
 *   translation (it only logs), and then every evaluating route 500s, so the image must not be built.
 *   The file is written even on a mismatch, so an operator can diff it.
 * - **emit** (`--emit-block`, an operator once per release): writes the sidecar and prints the manifest
 *   `terminology` block to stdout as exactly one JSON document, so it can be piped into the manifest.
 *   `--base-terminology` is CMS's official sidecar for the same measure; it supplies only `had` — how
 *   many codes CMS's draft carried — so a reviewer can see how far the release moved each set.
 *
 * ## Plain `node`, no install
 *
 * The Maui deploy runs this with bare `node`, no install and no `.official-content`, exactly as it runs
 * `vendor-official-measure.mjs`. So it imports only `node:` built-ins and `./vsac-expansion.mjs`, and
 * `vendor-derived-terminology.test.mjs` pins that by reading this file's imports.
 *
 * ## The sidecar's shape is the official one
 *
 * `{ catalogId, source, valueSets: [{ url, oid, declaredTotal, codes }] }`, value sets by
 * `sortValueSets`, codes by `canonicalize`, serialized as `JSON.stringify(x, null, 0) + "\n"` — the same
 * functions and the same serialization as the official vendor script, because the runtime verifies both
 * with one `verifyTerminology`. `source.repo` names VSAC and `source.ref` the release, since VSAC at
 * that release is where every code came from. `declaredTotal` is VSAC's `expansion.total`, which
 * `expandComplete` has already proved equals the codes held.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_VSAC_BASE,
  declaredValueSets,
  expandComplete,
  oidFromValueSetUrl,
  sortValueSets,
} from "./vsac-expansion.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(HERE, "..");

/**
 * The canonical a sidecar records, whatever transport `--vsac-base` points at: the runtime keys every set
 * by `oidFromValueSetUrl(url)`, and the official sidecars all use this `http` form.
 */
const VSAC_VALUESET_CANONICAL = "http://cts.nlm.nih.gov/fhir/ValueSet/";
const SIDECAR = "terminology.json";

const USAGE =
  "usage: --catalog-id <id> [--verify-pin] [--vsac-base <url>] [--output-dir <dir>]\n" +
  "       --catalog-id <id> --emit-block --base-terminology <path> --vsac-manifest <canonical>" +
  " [--vsac-base <url>] [--output-dir <dir>]";

class UsageError extends Error {}

/** A refusal with a sentence an operator can act on; `main` prints it and exits 1. */
class Refusal extends Error {}

const sha256 = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

function parseArgs(argv) {
  const args = { emitBlock: false, verifyPin: false, vsacBase: DEFAULT_VSAC_BASE };
  // A missing value must not swallow the next flag: `--vsac-manifest --verify-pin` would otherwise pin
  // the release to the string "--verify-pin" and turn the pin check off.
  const valueOf = (flag, value) => {
    if (value === undefined || value === "" || value.startsWith("--")) throw new UsageError(`${flag} needs a value\n${USAGE}`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--catalog-id") args.catalogId = valueOf(flag, argv[++i]);
    else if (flag === "--emit-block") args.emitBlock = true;
    else if (flag === "--verify-pin") args.verifyPin = true;
    else if (flag === "--base-terminology") args.baseTerminology = resolve(valueOf(flag, argv[++i]));
    else if (flag === "--vsac-manifest") args.vsacManifest = valueOf(flag, argv[++i]);
    else if (flag === "--vsac-base") args.vsacBase = valueOf(flag, argv[++i]);
    else if (flag === "--output-dir") args.outputDir = resolve(valueOf(flag, argv[++i]));
    else throw new UsageError(`unknown argument: ${flag}\n${USAGE}`);
  }
  if (!args.catalogId) throw new UsageError(USAGE);
  if (!/^[a-z0-9]+$/.test(args.catalogId)) {
    throw new UsageError(`--catalog-id must be lowercase alphanumeric (got "${args.catalogId}")`);
  }
  if (args.emitBlock) {
    if (args.verifyPin) {
      throw new UsageError("--verify-pin checks a committed pin and --emit-block produces one; run them separately");
    }
    if (!args.vsacManifest || !args.baseTerminology) {
      throw new UsageError(`--emit-block requires --vsac-manifest <canonical> and --base-terminology <path>\n${USAGE}`);
    }
  } else {
    // Verify mode reads the release from the committed manifest and nowhere else. Accepting the flag
    // here — even one that agreed today — is how a workflow line ends up expanding at a release the
    // manifest does not record.
    if (args.vsacManifest !== undefined) {
      throw new UsageError(
        "--vsac-manifest is refused without --emit-block: verify mode expands at the release the" +
          " translation's manifest.json records (terminology.completion.manifest), so nothing can drift from it",
      );
    }
    // Refused rather than ignored: a flag that silently does nothing reads as a check that ran.
    if (args.baseTerminology !== undefined) {
      throw new UsageError("--base-terminology is read only with --emit-block");
    }
  }
  args.outputDir ??= join(BACKEND_ROOT, "measures", "derived", args.catalogId);
  return args;
}

/**
 * Every value set the translation's ELM declares, as bare OIDs, de-duplicated (a versioned and an
 * unversioned canonical collapse to one) and in code-point order so the request sequence is stable.
 * `declaredValueSets` walks EVERY Library's `valueSets.def` — the runtime's `requiredOids` reads the
 * same field — so the sidecar covers exactly what the router will require.
 */
function requiredOids(bundle) {
  const oids = new Set(declaredValueSets(bundle).map((v) => oidFromValueSetUrl(v.url)));
  return [...oids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function readJson(fs, path, what) {
  if (!fs.existsSync(path)) throw new Refusal(`${what} not found at ${path}`);
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (err) {
    throw new Refusal(`${what} at ${path} is not valid JSON — ${err.message}`);
  }
}

/** `had` for the emitted block, keyed exactly as the runtime keys a sidecar (`verifyTerminology`). */
function baseCodeCounts(base, catalogId, path) {
  // A base sidecar for another measure would still parse and still produce a block — with every `had`
  // wrong, in a manifest a reviewer reads to see how far the release moved each set.
  if (base?.catalogId !== catalogId) {
    throw new Refusal(`--base-terminology ${path} is the sidecar for "${base?.catalogId}", not "${catalogId}"`);
  }
  if (!Array.isArray(base.valueSets)) throw new Refusal(`--base-terminology ${path} has no valueSets array`);
  const counts = new Map();
  for (const valueSet of base.valueSets) {
    if (!Array.isArray(valueSet?.codes)) continue;
    const oid = typeof valueSet.url === "string" ? oidFromValueSetUrl(valueSet.url) : valueSet.oid;
    if (typeof oid === "string") counts.set(oid, valueSet.codes.length);
  }
  return counts;
}

/**
 * What the router would refuse about these bytes, checked against the bytes themselves after they are
 * written: the hash the manifest pins (D5's sibling), and every declared set present, non-empty and not
 * short of its declared total (D8). Re-parsed and re-keyed with `oidFromValueSetUrl(url)` the way the
 * runtime keys them, so a serialization or keying slip fails here rather than at boot.
 */
function pinProblems(text, pinned, required) {
  const problems = [];
  const actual = sha256(text);
  if (actual !== pinned) {
    problems.push(
      `${SIDECAR} hashes to ${actual} but the manifest pins ${pinned ?? "nothing (no terminology.sha256)"}`,
    );
  }
  const byOid = new Map();
  for (const valueSet of JSON.parse(text).valueSets) {
    byOid.set(typeof valueSet.url === "string" ? oidFromValueSetUrl(valueSet.url) : valueSet.oid, valueSet);
  }
  const missing = required.filter((oid) => !byOid.has(oid));
  const empty = required.filter((oid) => byOid.has(oid) && byOid.get(oid).codes.length === 0);
  const short = required.filter((oid) => byOid.has(oid) && byOid.get(oid).codes.length < byOid.get(oid).declaredTotal);
  if (missing.length > 0) problems.push(`${missing.length} declared value set(s) missing: ${missing.join(", ")}`);
  if (empty.length > 0) problems.push(`${empty.length} declared value set(s) empty: ${empty.join(", ")}`);
  if (short.length > 0) problems.push(`${short.length} declared value set(s) short of their declared total: ${short.join(", ")}`);
  return problems;
}

async function run(args, { env, fs, fetchImpl, out, err }) {
  const apiKey = env.WORKWELL_VSAC_API_KEY;
  if (!apiKey) {
    // Never a silent skip. The official script may leave upstream's terminology in place without a key;
    // a translation has none to leave, and a deploy that carried on would build an image whose
    // translation the router refuses — booting fine and then answering 500 on every evaluation.
    throw new Refusal(
      `WORKWELL_VSAC_API_KEY is unset, so ${args.catalogId}'s translation terminology cannot be expanded.` +
        " Every value set a translation declares comes from VSAC at its pinned release and there is no" +
        " upstream copy to fall back to, so nothing was written and the router would refuse this" +
        " translation. Set the key and re-run.",
    );
  }

  const bundlePath = join(args.outputDir, "bundle.json");
  const bundle = readJson(fs, bundlePath, "the translation's bundle.json");
  const measureName = (bundle.entry ?? []).find((e) => e?.resource?.resourceType === "Measure")?.resource?.name;
  if (typeof measureName !== "string" || measureName === "") {
    throw new Refusal(`${bundlePath} carries no named Measure resource, so the sidecar's source.measure cannot be set`);
  }
  const required = requiredOids(bundle);
  // An ELM that declares nothing would yield an empty sidecar that passes every check below vacuously.
  if (required.length === 0) {
    throw new Refusal(`${bundlePath} declares no value sets in any Library's ELM — refusing to write an empty sidecar`);
  }

  let release;
  let manifest;
  let baseCounts;
  if (args.emitBlock) {
    release = args.vsacManifest;
    // Read before any VSAC call: a wrong path should cost nothing.
    baseCounts = baseCodeCounts(readJson(fs, args.baseTerminology, "--base-terminology"), args.catalogId, args.baseTerminology);
  } else {
    manifest = readJson(fs, join(args.outputDir, "manifest.json"), "the translation's manifest.json");
    release = manifest.terminology?.completion?.manifest;
    if (typeof release !== "string" || release === "") {
      throw new Refusal(
        "the translation's manifest names no VSAC release (terminology.completion.manifest), so there is no" +
          " pin to expand at. Generate the block with --emit-block and commit it first.",
      );
    }
  }

  const valueSets = [];
  for (const oid of required) {
    let expanded;
    try {
      expanded = await expandComplete(oid, { vsacBase: args.vsacBase, vsacManifest: release, apiKey, fetch: fetchImpl });
    } catch (cause) {
      // The whole run fails on one set, and nothing is written: a sidecar missing one set is a sidecar
      // the router refuses, and writing it would only move the failure from here to boot.
      throw new Refusal(`could not expand ${oid} at ${release}: ${cause.message}. Nothing was written.`);
    }
    valueSets.push({ url: `${VSAC_VALUESET_CANONICAL}${oid}`, oid, declaredTotal: expanded.total, codes: expanded.codes });
  }

  const terminology = sortValueSets({
    catalogId: args.catalogId,
    source: { repo: "cts.nlm.nih.gov/fhir", ref: release, measure: measureName },
    valueSets,
  });
  const text = `${JSON.stringify(
    { catalogId: terminology.catalogId, source: terminology.source, valueSets: terminology.valueSets },
    null,
    0,
  )}\n`;
  fs.writeFileSync(join(args.outputDir, SIDECAR), text);

  const digest = sha256(text);
  const codeCount = terminology.valueSets.reduce((n, v) => n + v.codes.length, 0);
  const summary =
    `  ${args.catalogId} translation terminology: ${terminology.valueSets.length} value sets,` +
    ` ${codeCount} codes at ${release} → ${SIDECAR} (gitignored)`;

  if (args.emitBlock) {
    const block = {
      file: SIDECAR,
      valueSets: terminology.valueSets.length,
      codes: codeCount,
      // Derived exactly as the official script derives it rather than written as `[]`, so the block can
      // never claim uncapped over a sidecar that is not. `expandComplete` makes it empty by construction.
      truncated: terminology.valueSets
        .filter((v) => v.declaredTotal > v.codes.length)
        .map((v) => ({ oid: v.oid, have: v.codes.length, declaredTotal: v.declaredTotal })),
      completion: {
        source: "vsac",
        manifest: release,
        // In OID order because `terminology.valueSets` already is (`sortValueSets`).
        valueSets: terminology.valueSets.map((v) => ({
          oid: v.oid,
          reason: "release",
          had: baseCounts.get(v.oid) ?? 0,
          now: v.codes.length,
          declaredTotal: v.declaredTotal,
        })),
      },
      sha256: digest,
    };
    // stdout carries the block and nothing else, so `> block.json` or a pipe gets one JSON document.
    out(`${JSON.stringify(block, null, 2)}\n`);
    err(`${summary}; ${digest}\n`);
    return 0;
  }

  const pinned = manifest.terminology?.sha256;
  if (!args.verifyPin) {
    out(`${summary}; ${digest === pinned ? "matches the manifest pin" : "does NOT match the manifest pin (pass --verify-pin to fail on it)"}\n`);
    return 0;
  }
  const problems = pinProblems(text, pinned, required);
  if (problems.length > 0) {
    out(`${summary}; does NOT match the manifest\n`);
    for (const problem of problems) err(`  ERROR ${args.catalogId}: ${problem}\n`);
    err(
      `  ${SIDECAR} was written anyway so it can be diffed. The router refuses this translation until the` +
        " sidecar matches its manifest, so this build must not ship.\n",
    );
    return 1;
  }
  out(`${summary}; matches the manifest pin\n`);
  return 0;
}

/**
 * Returns the exit code (0 ok, 1 refused, 2 usage) rather than exiting, so tests drive it in-process.
 * `deps` is `{ env, fetch, fs: { existsSync, readFileSync, writeFileSync }, stdout, stderr }`; each
 * defaults to the real one.
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const fs = deps.fs ?? { existsSync, readFileSync, writeFileSync };
  const out = deps.stdout ?? ((text) => process.stdout.write(text));
  const err = deps.stderr ?? ((text) => process.stderr.write(text));
  let args;
  try {
    args = parseArgs(argv);
  } catch (cause) {
    if (!(cause instanceof UsageError)) throw cause;
    err(`${cause.message}\n`);
    return 2;
  }
  try {
    return await run(args, { env, fs, fetchImpl: deps.fetch, out, err });
  } catch (cause) {
    // Anything unexpected (unparseable ELM, a write error) is still a refusal with exit 1, never a
    // stack trace that a deploy log truncates.
    err(`  ERROR ${args.catalogId}: ${cause.message}\n`);
    return 1;
  }
}

/**
 * Run only when invoked as a script, so the tests can import `main`. Compared against the REALPATH of
 * `argv[1]` because node loads the entry module by its realpath while `argv[1]` keeps any symlink — and
 * a guard that missed would make the deploy step exit 0 having written nothing.
 */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await main(process.argv.slice(2));
}
