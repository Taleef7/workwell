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
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = resolve(HERE, "..");
const REPO = "cqframework/dqm-content-qicore-2025";
/** Same pin the official test-case harness uses — the bundle and its test deck must agree. */
const DEFAULT_REF = "ca4b49516de4cbed9f92bfb7c35d97b1bf1022ab";

const KEPT_RESOURCE_TYPES = ["Measure", "Library"];
const KEPT_LIBRARY_CONTENT_TYPE = "application/elm+json";

function parseArgs(argv) {
  const args = { ref: DEFAULT_REF, stripElmAnnotations: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--measure") args.measure = argv[++i];
    else if (flag === "--catalog-id") args.catalogId = argv[++i];
    else if (flag === "--ref") args.ref = argv[++i];
    else if (flag === "--strip-elm-annotations") args.stripElmAnnotations = true;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.measure || !args.catalogId) {
    throw new Error("usage: --measure <UpstreamMeasureDir> --catalog-id <cms122> [--ref <sha>] [--strip-elm-annotations]");
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

/** Flatten a FHIR expansion's `contains` tree. These two bundles are flat, but the field is recursive. */
function flattenExpansion(contains, out = []) {
  for (const item of contains ?? []) {
    if (typeof item.code === "string" && typeof item.system === "string") {
      out.push({ system: item.system, code: item.code });
    }
    flattenExpansion(item.contains, out);
  }
  return out;
}

/**
 * The artifact's own terminology, lifted out of the upstream bundle before the ValueSets are dropped.
 *
 * Keyed by bare OID because that is what `buildValueSetCache` asks an expander for. `declaredTotal`
 * is kept alongside the code count so a VSAC-capped expansion (`expansion.total` greater than the codes
 * actually present) is a recorded fact rather than a silent shortfall — an under-expanded value set
 * narrows a population without erroring anywhere.
 */
function collectTerminology(bundle, args) {
  const valueSets = [];
  for (const entry of bundle.entry ?? []) {
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
  // Sorted so the sidecar is a deterministic function of the pinned commit: the manifest pins it by
  // hash, and a hash that depended on upstream entry order would be reproducible only by accident.
  //
  // Code-point comparison, NOT `localeCompare`: this ordering decides the bytes that get hashed, and
  // ICU collation weights punctuation (`.` — every character in an OID that is not a digit) according
  // to locale and ICU build. It happens to agree with code-point order for these OIDs on this Node,
  // but a divergence between a dev machine and the CI runner would surface as a hash mismatch whose
  // remedy message says "re-vendor" — which would reproduce the same mismatch.
  valueSets.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  return {
    catalogId: args.catalogId,
    source: { repo: REPO, ref: args.ref, measure: args.measure },
    valueSets,
  };
}

/** `http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840...` → `2.16.840...`. Mirrors the executor package. */
function oidFromValueSetUrl(url) {
  const marker = "/ValueSet/";
  return url.includes(marker) ? url.slice(url.lastIndexOf(marker) + marker.length) : url;
}

/** cqfm puts scoring and improvementNotation in group extensions, not on the Measure root. */
function cqfmExtension(group, name) {
  const ext = (group?.extension ?? []).find((e) => String(e.url).endsWith(name));
  return ext?.valueCodeableConcept?.coding?.[0]?.code ?? ext?.valueCode ?? ext?.valueString ?? null;
}

function buildManifest(bundle, args, raw, bundleJson, terminology, terminologyJson) {
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
      truncated,
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

const cached = localUpstreamBundle(args);
let raw = cached;
if (raw) {
  console.log(`reading ${args.measure} @ ${args.ref.slice(0, 12)} from .official-content (no download)`);
} else {
  const url = `https://raw.githubusercontent.com/${REPO}/${args.ref}/bundles/measure/${args.measure}/${args.measure}-bundle.json`;
  console.log(`fetching ${args.measure} @ ${args.ref.slice(0, 12)}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`unable to fetch ${url}: HTTP ${response.status}`);
  raw = await response.text();
}

const upstream = JSON.parse(raw);
const reduced = reduceBundle(upstream, args);
assertExecutable(reduced, args.measure);

const terminology = collectTerminology(upstream, args);
const terminologyJson = `${JSON.stringify(terminology, null, 0)}\n`;
const bundleJson = `${JSON.stringify(reduced, null, 0)}\n`;
const manifest = buildManifest(reduced, args, raw, bundleJson, terminology, terminologyJson);

const outDir = join(BACKEND_ROOT, "measures", "official", args.catalogId);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "bundle.json"), bundleJson);
writeFileSync(join(outDir, "terminology.json"), terminologyJson);
writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

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
for (const cap of manifest.terminology.truncated) {
  console.warn(
    `  WARNING capped expansion ${cap.oid}: ${cap.have}/${cap.declaredTotal} codes present.` +
      " Complete it from VSAC before routing a measure whose result depends on this set.",
  );
}
console.log(`  wrote ${outDir.replace(BACKEND_ROOT, "backend-ts")}`);
if (!existsSync(join(outDir, "README.md"))) {
  console.log(`  NOTE: no README.md in ${args.catalogId}/ — add provenance notes if this is a new measure.`);
}
