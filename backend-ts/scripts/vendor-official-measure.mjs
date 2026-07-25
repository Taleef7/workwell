#!/usr/bin/env node
/**
 * Vendor an OFFICIAL published eCQM measure bundle (roadmap §7.3, PR-5).
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
 * - **Dropped: ValueSets.** Deliberate, and the most important rule here. Their expansions embed
 *   **AMA CPT** and SNOMED CT content, which this repo is public and Apache-2.0 licensed and must not
 *   redistribute. Terminology comes from our own VSAC import at runtime (`buildValueSetCache`), under
 *   our UMLS licence. The pre-existing vendored bundle already followed this rule; the script now makes
 *   it explicit and enforced rather than incidental.
 * - **Dropped: test-case resources** (Patient/Condition/Encounter/MeasureReport/…). Those are the MADiE
 *   deck, fetched separately and gitignored by `fetch-official-cases.ps1`; shipping them in the deploy
 *   image would be dead weight.
 * - **Dropped: narratives** (`resource.text`) — display-only.
 *
 * ## The size lever we are NOT pulling yet
 *
 * `--strip-elm-annotations` removes ELM `annotation`/`locator`/`localId`, which measures **79% smaller**
 * (9.8 MB → 2.1 MB of ELM for CMS122). It is OFF by default on purpose: `localId` is what fqm-execution
 * uses for clause coverage and detailed results, so this must be proven by the official MADiE test-case
 * gate (PR-6) before it goes anywhere near the deploy image. The deploy window has bitten this project
 * once already (PR #283); an unproven size optimisation is not worth a second time.
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
          const elm = JSON.parse(Buffer.from(c.data, "base64").toString("utf8"));
          const data = Buffer.from(JSON.stringify(stripAnnotations(elm)), "utf8").toString("base64");
          return { ...c, data };
        });
      }
    }
    entry.push({ ...(original.fullUrl ? { fullUrl: original.fullUrl } : {}), resource });
  }
  return { resourceType: "Bundle", id: bundle.id, type: bundle.type ?? "transaction", entry };
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

/** cqfm puts scoring and improvementNotation in group extensions, not on the Measure root. */
function cqfmExtension(group, name) {
  const ext = (group?.extension ?? []).find((e) => String(e.url).endsWith(name));
  return ext?.valueCodeableConcept?.coding?.[0]?.code ?? ext?.valueCode ?? ext?.valueString ?? null;
}

function buildManifest(bundle, args, raw, bundleJson) {
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
      // Value sets are intentionally absent: their expansions carry AMA CPT / SNOMED content this
      // public repo must not redistribute. Terminology is supplied at runtime from our VSAC import.
      strippedValueSets: true,
      rawBytes: Buffer.byteLength(raw),
      vendoredBytes: Buffer.byteLength(bundleJson),
    },
    sha256: sha256(bundleJson),
  };
}

const args = parseArgs(process.argv.slice(2));
const url = `https://raw.githubusercontent.com/${REPO}/${args.ref}/bundles/measure/${args.measure}/${args.measure}-bundle.json`;

console.log(`fetching ${args.measure} @ ${args.ref.slice(0, 12)}`);
const response = await fetch(url);
if (!response.ok) throw new Error(`unable to fetch ${url}: HTTP ${response.status}`);
const raw = await response.text();

const reduced = reduceBundle(JSON.parse(raw), args);
assertExecutable(reduced, args.measure);

const bundleJson = `${JSON.stringify(reduced, null, 0)}\n`;
const manifest = buildManifest(reduced, args, raw, bundleJson);

const outDir = join(BACKEND_ROOT, "measures", "official", args.catalogId);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "bundle.json"), bundleJson);
writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
console.log(`  ${manifest.measureName} v${manifest.version} (${manifest.cmsId ?? "no cmsId"})`);
console.log(`  scoring=${manifest.scoring} improvementNotation=${manifest.improvementNotation}`);
console.log(`  ${mb(manifest.reduction.rawBytes)} → ${mb(manifest.reduction.vendoredBytes)}` +
  ` (${(100 - (100 * manifest.reduction.vendoredBytes) / manifest.reduction.rawBytes).toFixed(0)}% smaller)` +
  `${args.stripElmAnnotations ? " [ELM annotations stripped]" : ""}`);
console.log(`  wrote ${outDir.replace(BACKEND_ROOT, "backend-ts")}`);
if (!existsSync(join(outDir, "README.md"))) {
  console.log(`  NOTE: no README.md in ${args.catalogId}/ — add provenance notes if this is a new measure.`);
}
