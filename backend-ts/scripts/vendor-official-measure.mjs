#!/usr/bin/env node
/**
 * Vendor an OFFICIAL published eCQM measure bundle (roadmap §7.4, PR-5).
 *
 *   node scripts/vendor-official-measure.mjs --measure CMS122FHIRDiabetesAssessGT9Pct --catalog-id cms122
 *
 * Fetches the measure bundle from `cqframework/dqm-content-qicore-2025` at a PINNED commit, reduces it
 * to the executable core, and writes `measures/official/<catalogId>/{bundle.json,manifest.json}`.
 *
 * ## What is kept, and why the rest is dropped
 *
 * The upstream bundle is ~16 MB because it carries the whole authoring package: CQL source, ELM XML,
 * narratives, every ValueSet with its full expansion, and all 55+ test-case patients. Execution needs
 * almost none of that.
 *
 * - **Kept:** the `Measure` and its `Library` resources, each reduced to `application/elm+json` — the
 *   pre-compiled ELM is what `fqm-execution` runs, and keeping only it is what makes the artifact
 *   deployable at all.
 * - **Dropped from `bundle.json`, but written beside it: ValueSet expansions.** Deliberate, and the most
 *   important rule here: 26 expansions per bundle carry thousands of AMA CPT and SNOMED CT codes, and
 *   this repo is public, so they must never be committed. They are instead written to
 *   `terminology.json` — **gitignored, fetched at build** — which is the artifact's OWN terminology at
 *   the same pinned commit, and therefore the only terminology that can honestly be called official.
 *
 *   The committed manifest records that file's SHA-256, so the bytes are pinned even though they are
 *   not stored: a regenerated sidecar either hashes identically or fails loudly at load. That is what
 *   lets a public repo carry a reproducible artifact without redistributing licensed code systems.
 *
 *   **This does NOT make the artifact free of licensed terminology, and we must not claim it does.**
 *   The official CQL declares direct-reference codes inline, so the compiled ELM still embeds a small
 *   number of them with their descriptions (CMS122: CPT 97802/97803/97804 plus 7 SNOMED codes). They
 *   cannot be stripped without changing the measure. The `Measure.copyright` notice is retained
 *   deliberately for that reason, and `measures/official/NOTICE.md` records the terms — including
 *   NCQA's commercial-use clause, which is an owner/legal question, not an engineering one.
 * - **Dropped: test-case resources** (Patient/Condition/Encounter/MeasureReport/…). Those are the MADiE
 *   deck, fetched separately and gitignored by `fetch-official-cases.ps1`; shipping them in the deploy
 *   image would be dead weight.
 * - **Dropped: narratives** (`resource.text`) — display-only.
 *
 * ## `--strip-elm-annotations` — proven, and now the default for vendored artifacts
 *
 * Removing ELM `annotation`/`locator`/`localId` takes a measure from ~16 MB raw to ~2.4 MB vendored
 * (**86% smaller**, vs 37% without it). It was held back until the official MADiE gate could prove it,
 * because `localId` is what fqm-execution uses for clause coverage and the deploy window has bitten this
 * project once already (PR #283). PR-6 made that gate real and it now says, on both vendored measures:
 * **121/121 cases pass and 0/55 + 0/66 cases changed population vector** in the reduction check, which
 * executes the stripped artifact against the full upstream bundle over the same deck.
 *
 * Lost: `clauseResults` (already empty — `calculateClauseCoverage`/`calculateHTML` are both off),
 * `locator`, which is what fqm error text uses to point at a position in the ELM, and per-statement
 * `localId` — **which costs more than it first appeared** (found in PR-7a review). fqm resolves a
 * statement's `raw` value BY `localId`, so with annotations stripped every `raw` is `undefined` and
 * `final` collapses to `NA | UNHIT | FALSE`: measured over six CMS122 MADiE cases, **0 of 96 root
 * statements ever read `TRUE`**, including for subjects the measure places in the numerator. Statement
 * NAMES and COUNT survive the strip (which is what the reduction check's per-measure count verifies —
 * that check is invariant under stripping and should not be read as proving more); statement VALUES do
 * not. PR-7a therefore persists population results as evidence, not statement results.
 *
 * Retained and load-bearing: `populationResults`, and population membership is what the reduction
 * check actually compares — 0/55 and 0/66 cases changed, which is the claim this flag rests on.
 *
 * The flag stays opt-in at the CLI so an unstripped artifact remains one command away if clause-level
 * debugging is ever needed; every measure vendored for production use passes it.
 *
 * ## `--complete-terminology` (was `--complete-capped-expansions`, still accepted)
 *
 * Completes every value set the measure DECLARES but cannot fully resolve from the bundle. Two
 * distinct conditions, and until ADR-053 only the first was modelled:
 *
 * **Capped (ADR-041).** Upstream caps every expansion it ships: *"The value sets in this repository are
 * limited to expansions of 1000"* (the content repo's own README — full expansions need an NLM
 * licence). That is upstream policy, not a defect, and nothing can be filed about it. It bites us
 * because `AdvancedIllness`
 * (…1003.110.12.1082) is **1000 of 1997 codes in both bundles** and feeds the 66+/advanced-illness
 * DENEX in each, so a capped set does not error — it silently narrows a population, leaving excluded
 * subjects in the denominator to be scored. `officialRoutingProblems` therefore refuses to route any
 * measure whose ELM retrieves a capped set, which is why cms122 and cms125 are not routable today.
 *
 * With this flag the shortfall is completed from VSAC at vendor time — the roadmap's own rule
 * (§7.3): *bundle-shipped expansions PRIMARY, VSAC-patched at VENDOR time, no runtime fallback.*
 * Only the OIDs upstream actually capped are re-expanded (today: one, two pages), pinned to the
 * release the upstream content itself names — `Library/ecqm-fhir-update-2025`, the same terminology
 * Cypress/CVU+ validates the 2026 reporting period against — so the same pin yields the same bytes and
 * CI's `git diff --exit-code measures/official` stays an honest reproducibility check.
 *
 * **Absent (ADR-053).** A value set the ELM DECLARES for which the bundle ships no ValueSet resource
 * at all. `collectTerminology` enumerates what the bundle SHIPS, so such a set produced nothing at
 * vendor time — no sidecar entry, no `truncated` row, no warning — and the artifact read as complete
 * while being unrunnable. Measured on CMS138: 32 value sets declared by its ELM, 31 shipped;
 * `2.16.840.1.113883.3.526.3.1278` ("Tobacco Use Screening") is absent, and all 47 MADiE cases error.
 * Upstream's own 2026-07-15 discrepancy report lists CMS138 under *no discrepancies* across 5826 cases,
 * so this is not a broken measure — their environment resolves the set from the NLM terminology package
 * their README names, and ours never asked for it. Upstream HEAD changes no bundle, so re-pinning is
 * not the remedy; sourcing it from VSAC is.
 *
 * **It fails closed, in the only direction that is safe.** No `WORKWELL_VSAC_API_KEY`, or VSAC
 * unreachable after retries, and the terminology is written exactly as upstream shipped it with its
 * `truncated` entry intact and its absent set still absent — so routing keeps refusing rather than a
 * half-expanded exclusion set quietly scoring people, or an empty set putting a whole roster
 * out-of-population (ADR-043). A shortfall that survives the completion stays recorded for the same
 * reason. It is not possible to emit a manifest that claims complete over a sidecar that is not:
 * `truncated` is derived from the codes actually present, after completion, by the same comparison as
 * before, and "absent" is recomputed at runtime from the artifact's own two files rather than trusted
 * from a manifest field.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_VSAC_BASE,
  DEFAULT_VSAC_MANIFEST,
  completeTerminology,
  declaredValueSets,
  flattenExpansion,
  oidFromValueSetUrl,
  sortValueSets,
} from "./vsac-expansion.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(HERE, "..");
const REPO = "cqframework/dqm-content-qicore-2025";
/** Same pin the official test-case harness uses — the bundle and its test deck must agree. */
const DEFAULT_REF = "ca4b49516de4cbed9f92bfb7c35d97b1bf1022ab";

const KEPT_RESOURCE_TYPES = ["Measure", "Library"];
const KEPT_LIBRARY_CONTENT_TYPE = "application/elm+json";

function parseArgs(argv) {
  const args = {
    ref: DEFAULT_REF,
    testsOnly: false,
    withTests: false,
    contentDir: join(BACKEND_ROOT, ".official-content"),
    outputDir: join(BACKEND_ROOT, "measures", "official"),
    stripElmAnnotations: false,
    completeTerminology: false,
    vsacBase: DEFAULT_VSAC_BASE,
    vsacManifest: DEFAULT_VSAC_MANIFEST,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--measure") args.measure = argv[++i];
    else if (flag === "--catalog-id") args.catalogId = argv[++i];
    else if (flag === "--ref") args.ref = argv[++i];
    else if (flag === "--strip-elm-annotations") args.stripElmAnnotations = true;
    else if (flag === "--complete-terminology") args.completeTerminology = true;
    // ADR-041's name for the same flag, kept working rather than removed. It is printed in DEPLOY.md,
    // in `officialRoutingProblems`' remedy text and in three deploy workflows' history, and an operator
    // following a slightly stale runbook during an incident must not hit "unknown argument". It selects
    // the same behavior — which is now WIDER than the old name says, hence the warning.
    else if (flag === "--complete-capped-expansions") {
      console.warn(
        "  NOTE --complete-capped-expansions is the old name for --complete-terminology, which also" +
          " sources value sets upstream omits entirely (ADR-053). Proceeding.",
      );
      args.completeTerminology = true;
    } else if (flag === "--vsac-base") args.vsacBase = argv[++i];
    else if (flag === "--vsac-manifest") args.vsacManifest = argv[++i];
    else if (flag === "--tests-only") args.testsOnly = true;
    else if (flag === "--with-tests") args.withTests = true;
    else if (flag === "--content-dir") args.contentDir = resolve(argv[++i]);
    else if (flag === "--output-dir") args.outputDir = resolve(argv[++i]);
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (args.testsOnly && args.withTests) throw new Error("--tests-only and --with-tests are mutually exclusive");
  if (!args.measure || !args.catalogId) {
    throw new Error(
      "usage: --measure <UpstreamMeasureDir> --catalog-id <cms122> [--ref <sha>]" +
        " [--strip-elm-annotations] [--complete-terminology] [--vsac-manifest <canonical>]",
    );
  }
  // A branch name would produce an artifact nobody can reproduce; the manifest is only provenance if
  // the ref is immutable. Fail where the mistake is made rather than in a test later.
  if (!/^[0-9a-f]{40}$/.test(args.ref)) {
    throw new Error(`--ref must be a full 40-character commit sha (got "${args.ref}")`);
  }
  if (!/^[a-z0-9]+$/.test(args.catalogId)) {
    throw new Error(`--catalog-id must be lowercase alphanumeric (got "${args.catalogId}")`);
  }
  return args;
}

const sha256 = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/**
 * Copy the upstream MADiE case deck into the tree and hash it in a single sorted walk, so the manifest's
 * `tests.sha256` is over the exact bytes a CI gate later verifies: `relativePath + "\n" + bytes` per file.
 * JSON is validated before any copy rather than after, because a malformed upstream case file is a
 * checkout problem that must fail with the file named — not a hash mismatch discovered much later.
 */
function vendorTests(args) {
  const upstreamTestsDir = join(args.contentDir, "input", "tests", "measure", args.measure);
  const outDir = args.outputDir;
  const manifestPath = join(outDir, "manifest.json");
  const sourcePath = relative(args.contentDir, upstreamTestsDir).split(/[\\/]/).join("/");

  if (!existsSync(upstreamTestsDir)) throw new Error(`no upstream test deck at ${upstreamTestsDir}`);

  const hash = createHash("sha256");
  let count = 0;
  for (const entry of readdirSync(upstreamTestsDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const caseSource = join(upstreamTestsDir, entry.name);
    const caseDest = join(outDir, "tests", entry.name);
    mkdirSync(caseDest, { recursive: true });
    for (const file of readdirSync(caseSource, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!file.isFile()) continue;
      const sourcePath = join(caseSource, file.name);
      const bytes = readFileSync(sourcePath);
      if (file.name.toLowerCase().endsWith(".json")) {
        try {
          JSON.parse(bytes.toString("utf8"));
        } catch (error) {
          throw new Error(`malformed JSON in ${sourcePath}: ${error.message}`);
        }
      }
      const relativePath = `${entry.name}/${file.name}`;
      hash.update(`${relativePath}\n`);
      hash.update(bytes);
      writeFileSync(join(caseDest, file.name), bytes);
      count += 1;
    }
  }

  let manifest = {};
  if (existsSync(manifestPath)) manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.tests = { count, sourcePath, sha256: `sha256:${hash.digest("hex")}` };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { count, sourcePath, sha256: manifest.tests.sha256 };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fetch with a bounded retry on transport errors and 5xx; 4xx fails immediately (see the call site). */
async function fetchWithRetry(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.text();
      if (response.status < 500) throw new Error(`unable to fetch ${url}: HTTP ${response.status}`);
      lastError = new Error(`unable to fetch ${url}: HTTP ${response.status}`);
    } catch (err) {
      if (String(err.message).includes("HTTP 4")) throw err;
      lastError = err;
    }
    if (attempt < attempts) {
      const backoffMs = 1000 * 2 ** (attempt - 1);
      console.warn(`  fetch attempt ${attempt}/${attempts} failed (${lastError.message}); retrying in ${backoffMs}ms`);
      await sleep(backoffMs);
    }
  }
  throw lastError;
}

/** Recursively drop ELM debug/provenance keys. See the warning in the header before enabling. */
function stripAnnotations(node) {
  if (Array.isArray(node)) return node.map(stripAnnotations);
  if (node && typeof node === "object") {
    const out = {};
    for (const key of Object.keys(node)) {
      if (key === "annotation" || key === "locator" || key === "localId") continue;
      out[key] = stripAnnotations(node[key]);
    }
    return out;
  }
  return node;
}

function reduceBundle(bundle, { stripElmAnnotations }) {
  const entry = [];
  for (const original of bundle.entry ?? []) {
    const type = original?.resource?.resourceType;
    if (!KEPT_RESOURCE_TYPES.includes(type)) continue;
    const resource = structuredClone(original.resource);
    delete resource.text;
    if (type === "Library" && Array.isArray(resource.content)) {
      resource.content = resource.content.filter((c) => c.contentType === KEPT_LIBRARY_CONTENT_TYPE);
      if (stripElmAnnotations) {
        resource.content = resource.content.map((c) => {
          let elm;
          try {
            elm = JSON.parse(Buffer.from(c.data, "base64").toString("utf8"));
          } catch (err) {
            const name = resource.name ?? resource.id;
            throw new Error(`${name}: ELM payload will not parse, cannot strip annotations — ${err.message}`);
          }
          const data = Buffer.from(JSON.stringify(stripAnnotations(elm)), "utf8").toString("base64");
          return { ...c, data };
        });
      }
    }
    entry.push({ ...(original.fullUrl ? { fullUrl: original.fullUrl } : {}), resource });
  }
  // "collection", not the upstream "transaction": we drop `fullUrl` and `request`, so the artifact is
  // no longer a conformant transaction Bundle and must not pretend to be POSTable. fqm-execution reads
  // resources by resourceType and does not care.
  return { resourceType: "Bundle", id: bundle.id, type: "collection", entry };
}

/** Fail here, loudly, rather than deep inside fqm-execution at evaluation time. */
function assertExecutable(bundle, measureName) {
  const libraries = bundle.entry.filter((e) => e.resource.resourceType === "Library");
  const measure = bundle.entry.find((e) => e.resource.resourceType === "Measure");
  if (!measure) throw new Error(`${measureName}: reduced bundle has no Measure resource`);
  if (libraries.length === 0) throw new Error(`${measureName}: reduced bundle has no Library resources`);
  const missing = libraries.filter(
    (l) => !(l.resource.content ?? []).some((c) => c.contentType === KEPT_LIBRARY_CONTENT_TYPE && !!c.data),
  );
  if (missing.length > 0) {
    const names = missing.map((l) => l.resource.name ?? l.resource.id).join(", ");
    throw new Error(`${measureName}: these libraries ship no pre-compiled ELM, so the measure cannot run: ${names}`);
  }
}

/**
 * The artifact's own terminology, lifted out of the upstream bundle before the ValueSets are dropped.
 *
 * Keyed by bare OID because that is what `buildValueSetCache` asks an expander for. `declaredTotal`
 * is kept alongside the code count so a VSAC-capped expansion (`expansion.total` greater than the codes
 * actually present) is a recorded fact rather than a silent shortfall — an under-expanded value set
 * narrows a population without erroring anywhere.
 *
 * ## `absent`: what this function could not see until ADR-053
 *
 * The loop below enumerates the ValueSets the bundle SHIPS. A value set the measure's ELM *declares*
 * but upstream never shipped produced nothing here — no entry, no `truncated` row, no warning — so the
 * manifest read as terminology-complete while the artifact could not run. CMS138 is the live instance:
 * its libraries declare 32 value sets and the bundle carries 31.
 *
 * So the two lists are now diffed explicitly, against the REDUCED bundle — the same bytes
 * `requiredOids(artifact)` reads at runtime, so the record here and the routing refusal there are
 * computed from one input by one algorithm rather than kept in step by hand.
 *
 * A shipped-but-unretrieved value set is NOT a problem and is not reported: upstream bundles carry
 * dependency closures, and a set the ELM never asks for cannot narrow a population. The diff is
 * deliberately one-directional.
 */
function collectTerminology(upstreamBundle, reducedBundle, args) {
  const valueSets = [];
  for (const entry of upstreamBundle.entry ?? []) {
    const resource = entry?.resource;
    if (resource?.resourceType !== "ValueSet") continue;
    const url = resource.url ?? resource.id;
    const codes = flattenExpansion(resource.expansion?.contains);
    const declaredTotal =
      typeof resource.expansion?.total === "number" ? resource.expansion.total : codes.length;
    valueSets.push({
      url,
      oid: oidFromValueSetUrl(url),
      ...(resource.version ? { version: resource.version } : {}),
      declaredTotal,
      codes,
    });
  }
  // Compared on the bare OID — the same key everything downstream uses. `oidFromValueSetUrl` strips
  // both the canonical prefix and a `|version` suffix, so a versioned ELM canonical and the shipped
  // ValueSet's unversioned `url` land on one key (that suffix-stripping was missing until review of
  // #364; measured zero versioned canonicals across all six bundles, so it is latent, not live).
  const shipped = new Set(valueSets.map((v) => v.oid));
  const absent = declaredValueSets(reducedBundle)
    .map((v) => ({ oid: oidFromValueSetUrl(v.url), url: v.url, ...(v.name ? { name: v.name } : {}) }))
    .filter((v) => !shipped.has(v.oid));
  // Sorted so the sidecar is a deterministic function of the pinned commit: the manifest pins it by
  // hash, and a hash that depended on upstream entry order would be reproducible only by accident.
  // `absent` is sorted so the ORDER OF COMPLETION is deterministic: it is not itself committed
  // (ADR-053 decision 2), but it drives the order of `completion.valueSets`, which is.
  absent.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  return sortValueSets({
    catalogId: args.catalogId,
    source: { repo: REPO, ref: args.ref, measure: args.measure },
    valueSets,
    absent,
  });
}

/** cqfm puts scoring and improvementNotation in group extensions, not on the Measure root. */
function cqfmExtension(group, name) {
  const ext = (group?.extension ?? []).find((e) => String(e.url).endsWith(name));
  return ext?.valueCodeableConcept?.coding?.[0]?.code ?? ext?.valueCode ?? ext?.valueString ?? null;
}

function buildManifest(bundle, args, raw, bundleJson, terminology, terminologyJson, completed) {
  const truncated = terminology.valueSets
    .filter((v) => v.declaredTotal > v.codes.length)
    .map((v) => ({ oid: v.oid, have: v.codes.length, declaredTotal: v.declaredTotal }));
  const measure = bundle.entry.find((e) => e.resource.resourceType === "Measure").resource;
  const group = measure.group?.[0];
  const cmsId = (measure.identifier ?? []).find((i) => String(i.system).endsWith("/cmsId"))?.value ?? null;
  return {
    catalogId: args.catalogId,
    measureName: measure.name,
    version: measure.version,
    cmsId,
    url: measure.url,
    status: measure.status,
    effectivePeriod: measure.effectivePeriod ?? null,
    scoring: cqfmExtension(group, "cqfm-scoring"),
    populationBasis: cqfmExtension(group, "cqfm-populationBasis"),
    // Recorded exactly as the artifact declares it, never "corrected" here. PR-7 decides what the
    // exported report claims, and a mismatch against eCQI is a finding to raise upstream, not to
    // paper over during vendoring.
    improvementNotation: cqfmExtension(group, "cqfm-improvementNotation"),
    populations: (group?.population ?? []).map((p) => p.code?.coding?.[0]?.code).filter(Boolean),
    source: {
      repo: REPO,
      ref: args.ref,
      path: `bundles/measure/${args.measure}/${args.measure}-bundle.json`,
      rawSha256: sha256(raw),
    },
    reduction: {
      keptResourceTypes: KEPT_RESOURCE_TYPES,
      libraryContentTypes: [KEPT_LIBRARY_CONTENT_TYPE],
      strippedNarratives: true,
      strippedElmAnnotations: args.stripElmAnnotations,
      // Value sets are absent from bundle.json: their expansions carry AMA CPT / SNOMED content this
      // public repo must not redistribute. They are written to the gitignored terminology sidecar
      // instead — same commit, same codes, pinned below by hash.
      strippedValueSets: true,
      rawBytes: Buffer.byteLength(raw),
      vendoredBytes: Buffer.byteLength(bundleJson),
    },
    /**
     * The sidecar's contract. It is gitignored, so this block is the ONLY committed evidence of what
     * `terminology.json` must contain — the loader verifies the hash and refuses a mismatch, which is
     * what makes "fetched at build" as trustworthy as "vendored" without the redistribution.
     */
    terminology: {
      file: "terminology.json",
      valueSets: terminology.valueSets.length,
      codes: terminology.valueSets.reduce((n, v) => n + v.codes.length, 0),
      // A capped expansion is recorded, never quietly accepted. It cannot invent membership — an
      // under-expanded set only ever narrows a population — but it can hide a subject who belongs,
      // so a measure whose result depends on one of these must not be routed officially until the
      // set is completed from VSAC under our UMLS licence.
      //
      // Derived from the codes actually present AFTER `--complete-terminology` has run, so the two
      // facts cannot disagree: a manifest with an empty `truncated` is a manifest whose sidecar holds
      // every code the bundle declared.
      //
      // Note the exact scope of that sentence, because it is the gap ADR-053 closed: "every code the
      // bundle DECLARED" says nothing about a value set the bundle never declared at all. An empty
      // `truncated` is not, and never was, a claim that the artifact's terminology is COMPLETE — that
      // question is answered at runtime by `absentValueSets`, against the ELM.
      truncated,
      // Present only when something was actually completed, so an artifact vendored without the flag
      // is byte-identical to one vendored before it existed. The pin is recorded because it decides
      // the bytes: re-expanding at a different release is a different artifact, and the terminology
      // digest below — which feeds `officialLogicVersion` — is what makes that consequential.
      ...(completed.length > 0
        ? { completion: { source: "vsac", manifest: args.vsacManifest, valueSets: completed } }
        : {}),
      sha256: sha256(terminologyJson),
    },
    sha256: sha256(bundleJson),
  };
}

/**
 * Reuse the sparse clone `fetch-official-cases.ps1` already maintains, when it sits at the ref we were
 * asked for.
 *
 * Same repository, same pinned commit, same file — and in CI it is already restored from a cache, so
 * this turns two ~17 MB `raw.githubusercontent` downloads per run into zero. Reproducibility is
 * untouched: the reproducibility check's claim is "the committed artifact is what this immutable pin
 * produces", and a checkout OF that pin is those bytes.
 *
 * The ref comparison is what makes it safe. A detached checkout writes the sha straight into `.git/HEAD`,
 * so a clone parked on a different commit — or on a branch — simply does not match and we fetch. Every
 * failure here falls back to the network rather than guessing.
 */
function localUpstreamBundle(args) {
  const contentDir = join(BACKEND_ROOT, ".official-content");
  try {
    if (readFileSync(join(contentDir, ".git", "HEAD"), "utf8").trim() !== args.ref) return null;
    const path = join(contentDir, "bundles", "measure", args.measure, `${args.measure}-bundle.json`);
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv.slice(2));

const outDir = join(args.outputDir, args.catalogId);
if (args.testsOnly) {
  const tests = vendorTests({ ...args, outputDir: outDir });
  console.log(`  ${args.measure}: vendored ${tests.count} case files → ${outDir} (${tests.sha256})`);
  process.exit(0);
}

const cached = localUpstreamBundle(args);
let raw = cached;
if (raw) {
  console.log(`reading ${args.measure} @ ${args.ref.slice(0, 12)} from .official-content (no download)`);
} else {
  const url = `https://raw.githubusercontent.com/${REPO}/${args.ref}/bundles/measure/${args.measure}/${args.measure}-bundle.json`;
  console.log(`fetching ${args.measure} @ ${args.ref.slice(0, 12)}`);
  // Bounded retry. This runs on the DEPLOY path, and failing closed on a missing sidecar is right
  // while failing closed on a transient GitHub blip is not — an emergency rollback rebuilds the image,
  // so a 30-second outage would block the fix for an unrelated incident. A 404 is not retried: at a
  // pinned immutable ref it means the path is wrong, and retrying cannot change that.
  raw = await fetchWithRetry(url);
}

const upstream = JSON.parse(raw);
const reduced = reduceBundle(upstream, args);
assertExecutable(reduced, args.measure);

const terminology = collectTerminology(upstream, reduced, args);
// Before serialization, deliberately: the sidecar's bytes are what the manifest pins, so a completion
// that ran after the hash was taken would be a completion the loader refuses.
const completed = await completeTerminology(terminology, args);
// Re-sorted AFTER completion because sourcing an absent value set APPENDS one, and the sidecar's
// ordering is part of the artifact (the manifest pins its bytes by hash).
sortValueSets(terminology);
// The sidecar carries TERMINOLOGY, and `absent` is a finding about the artifact rather than terminology
// data — so it is written explicitly rather than by serializing whatever `collectTerminology` returned.
//
// That is not tidiness. The outstanding-absent list is RECOMPUTABLE at runtime (the ELM in bundle.json
// names what it retrieves; the sidecar names what we hold), so persisting it would create a second
// authority that can disagree with the artifact — the exact `truncated`-vs-sidecar drift
// `official-terminology.test.ts` guards against, in a field that never needed to exist. Keeping it out
// also means adding this check moved no committed byte: the five vendored sidecars and their pinned
// hashes are untouched. What IS recorded in the manifest is the COMPLETION (below), because a code that
// came from VSAC rather than from the bundle is provenance and cannot be recomputed from either file.
const terminologyJson = `${JSON.stringify(
  { catalogId: terminology.catalogId, source: terminology.source, valueSets: terminology.valueSets },
  null,
  0,
)}\n`;
const bundleJson = `${JSON.stringify(reduced, null, 0)}\n`;
const manifest = buildManifest(reduced, args, raw, bundleJson, terminology, terminologyJson, completed);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "bundle.json"), bundleJson);
writeFileSync(join(outDir, "terminology.json"), terminologyJson);
writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
// `--with-tests` writes the case deck after the artifact manifest, so a regenerated official tree
// can be compared whole instead of patched piecemeal.
if (args.withTests) {
  const tests = vendorTests({ ...args, outputDir: outDir });
  manifest.tests = tests;
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

// Decimal MB, matching the evidence report's own formatting — the two printed the same file at
// different sizes when this divided by 1048576 and the report divided by 1e6.
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
console.log(`  ${manifest.measureName} v${manifest.version} (${manifest.cmsId ?? "no cmsId"})`);
console.log(`  scoring=${manifest.scoring} improvementNotation=${manifest.improvementNotation}`);
console.log(`  ${mb(manifest.reduction.rawBytes)} → ${mb(manifest.reduction.vendoredBytes)}` +
  ` (${(100 - (100 * manifest.reduction.vendoredBytes) / manifest.reduction.rawBytes).toFixed(0)}% smaller)` +
  `${args.stripElmAnnotations ? " [ELM annotations stripped]" : ""}`);
console.log(
  `  terminology: ${manifest.terminology.valueSets} value sets, ${manifest.terminology.codes} codes` +
    ` → ${mb(Buffer.byteLength(terminologyJson))} (gitignored)`,
);
for (const done of completed) {
  console.log(
    done.reason === "absent-upstream"
      ? `  sourced ${done.oid} from VSAC: absent from the upstream bundle → ${done.now} codes` +
          ` @ ${args.vsacManifest}`
      : `  completed ${done.oid} from VSAC: ${done.had} → ${done.now} codes` +
          ` (declared ${done.declaredTotal}) @ ${args.vsacManifest}`,
  );
}
for (const cap of manifest.terminology.truncated) {
  console.warn(
    `  WARNING capped expansion ${cap.oid}: ${cap.have}/${cap.declaredTotal} codes present.` +
      " Complete it from VSAC before routing a measure whose result depends on this set" +
      " (pass --complete-terminology with WORKWELL_VSAC_API_KEY set).",
  );
}
// The warning that did not exist before ADR-053, and its absence is what made CMS138 look like an
// expansion bug. Loud and last, because it is the one condition under which the artifact
// written above CANNOT run at all — fqm resolves terminology from the Library's own
// `relatedArtifact`/`dataRequirement`, and this one has no source in the bundle.
for (const gap of terminology.absent) {
  console.warn(
    `  WARNING value set ${gap.oid}${gap.name ? ` ("${gap.name}")` : ""} is DECLARED by this measure's` +
      " ELM but the upstream bundle ships no ValueSet resource for it, so the artifact cannot run." +
      " Source it from VSAC (pass --complete-terminology with WORKWELL_VSAC_API_KEY set) — ADR-053.",
  );
}
console.log(`  wrote ${outDir.replace(BACKEND_ROOT, "backend-ts")}`);
if (!existsSync(join(outDir, "README.md"))) {
  console.log(`  NOTE: no README.md in ${args.catalogId}/ — add provenance notes if this is a new measure.`);
}
