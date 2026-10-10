/**
 * Vendored official measure artifacts (roadmap §7.4, PR-5).
 *
 * Reads `measures/official/<catalogId>/{bundle.json,manifest.json}` — the output of
 * `scripts/vendor-official-measure.mjs`. This is the app-side half of the split the executor package
 * defines: the package executes a bundle it is handed, and knowing where bundles live on disk (and what
 * provenance they carry) is the app's business.
 *
 * The convention replaces the hardcoded `cms122v14/CMS122FHIR-v0.5.000-FHIR.json` path and its
 * `OFFICIAL_CMS122` constant. That hardcoding *was* the staleness bug: the vendored artifact sat at
 * v0.5.000 while upstream moved to v1.0.000, and nothing could notice because the version was spelled
 * into a filename and a literal. Promotion is now a file swap plus a manifest, per measure.
 */
import { readFileSync } from "node:fs";
import { isExecutableMeasureBundle, type MeasureBundle } from "@work-well/official-executor";

export interface OfficialManifest {
  catalogId: string;
  measureName: string;
  version: string;
  cmsId: string | null;
  url: string;
  status: string;
  effectivePeriod: { start?: string; end?: string } | null;
  scoring: string | null;
  populationBasis: string | null;
  /**
   * As DECLARED by the artifact — never normalized here.
   *
   * Note for PR-7: CMS122's artifact declares `increase` even though the measure is inverse (its
   * numerator is poor glycemic control, so a lower rate is better and eCQI describes it as
   * decrease-is-improvement). Recording the declared value keeps the discrepancy visible instead of
   * silently resolving it during vendoring; deciding what an exported report should claim — and
   * whether to raise it upstream — is PR-7's call.
   */
  improvementNotation: string | null;
  populations: string[];
  /**
   * Present only when the MADiE case deck was vendored into the tree (--tests-only or --with-tests).
   * sourcePath is upstream-relative provenance; sha256 is the integrity pin the case loader
   * verifies before reading any of the committed case bytes.
   */
  tests?: { count: number; sourcePath: string; sha256: string };
  source: { repo: string; ref: string; path: string; rawSha256: string };
  reduction: Record<string, unknown>;
  /**
   * The contract for the gitignored `terminology.json` sidecar (PR-8a). Optional in the TYPE because an
   * artifact vendored before PR-8a has no such block, and that must read as "unpinned, refuse to route"
   * rather than as a crash — `loadOfficialTerminology` turns its absence into exactly that sentence.
   */
  terminology?: {
    file: string;
    valueSets: number;
    codes: number;
    truncated: Array<{ oid: string; have: number; declaredTotal: number }>;
    /**
     * Present only when `vendor:official --complete-terminology` actually replaced a shortfall
     * upstream shipped (PR-9). Optional in the TYPE because an artifact vendored without the flag —
     * or one vendored before it existed — has no such block, and that must read as "nothing was
     * completed" rather than as a crash.
     *
     * The `manifest` field is the VSAC release the codes came from, and it is load-bearing rather
     * than decorative: re-expanding at a different release yields different codes, a different
     * terminology digest, and therefore a different `officialLogicVersion`. Recording it is what
     * makes the completion reproducible instead of merely repeatable.
     *
     * `reason` marks the WEAKER provenance, and is emitted only as `absent-upstream` (ADR-053). Its
     * absence means `capped`: a set checked against upstream's own declared total AND against
     * containment of the codes upstream shipped. An `absent-upstream` set had neither check available
     * — upstream shipped nothing to contain and declared no total — so it is held only to VSAC's own
     * `expansion.total`, and its `declaredTotal` here is `null` rather than VSAC's number, because
     * this field means "what the bundle declared" and the bundle declared nothing.
     *
     * It is NOT emitted for capped completions, and that is a reproducibility constraint rather than a
     * style choice: the committed cms122/cms125 manifests record exactly `{oid, had, now,
     * declaredTotal}`, and an extra key changes what a credentialed re-vendor writes — failing CI's
     * `git diff --exit-code measures/official` gate and blocking deploys. The first cut of ADR-053 did
     * exactly that. `scripts/vsac-expansion.test.mjs` pins the produced key set against the committed
     * one.
     */
    completion?: {
      source: string;
      manifest: string;
      valueSets: Array<{
        oid: string;
        /**
         * `release` is a WorkWell translation's completion (C3a): every declared set re-expanded at the
         * named VSAC release, where `had` is CMS's shipped count and `now` the release's. It is never
         * written into an official manifest, so the key-set pin on cms122/cms125 is unaffected.
         */
        reason?: "capped" | "absent-upstream" | "release";
        had: number;
        now: number;
        declaredTotal: number | null;
      }>;
    };
    sha256: string;
  };
  sha256: string;
  /**
   * Present ONLY on a WorkWell translation under `measures/derived/` (decision 3, 2026-10-02): the block
   * is what makes the artifact a translation, and each loader refuses the other kind's manifest.
   */
  derived?: DerivedManifestBlock;
}

/**
 * What a WorkWell translation records about itself. It never carries a CMS measure identity (LOCKED
 * §4.3): `derivedFrom` names the CMS measure it was translated FROM, for provenance only.
 */
export interface DerivedManifestBlock {
  /** Shown wherever the logic is named, e.g. "WorkWell translation of CMS137v15". */
  label: string;
  derivedFrom: { ecqm: string; packageSha256: string };
  /** The official artifact it was built on, pinned so a re-vendor of the base cannot pass unnoticed. */
  base: { catalogId: string; manifestSha256: string };
  build: { translator: string; modelInfoSha256: string; signatureLevel: string; translationSha256: string };
  /** CMS libraries carried unchanged, each pinned by the hash of its ELM. */
  unchangedLibraries: Array<{ name: string; version: string; elmSha256: string }>;
  /**
   * CMS shared libraries WorkWell EDITED (#779), each under WorkWell's own name and `ww-` version, and the
   * CMS library it was edited from: `from.elmSha256` is CMS's committed ELM, checked against CMS's
   * artifact, and `translationSha256` hashes that library's edited CQL. Absent when no shared library was
   * edited, so a translation with none (CMS137) keeps its manifest byte for byte.
   */
  changedLibraries?: DerivedChangedLibrary[];
  /**
   * The libraries WorkWell compiled whose reads differ from CMS's (#782), so whose computed data
   * requirements — `dataRequirement`, the value-set and code-system `depends-on` entries and the
   * direct-reference codes — were edited to match their ELM rather than carried as MADiE wrote them. By
   * the name each carries in the bundle. Absent when none, so CMS130 and CMS137 keep their manifests.
   */
  recomputedDataRequirements?: string[];
  /** The checks it passed, each naming the exact artifact and terminology it ran against. */
  oracles: Array<{
    name: string;
    inputSha256: string;
    period: { start: string; end: string };
    agree: number;
    total: number;
    result: "pass" | "fail";
    ranAgainst: { artifactSha256: string; terminologySha256: string };
  }>;
}

/** One entry of `DerivedManifestBlock.changedLibraries`. */
export interface DerivedChangedLibrary {
  name: string;
  version: string;
  from: { name: string; version: string; elmSha256: string };
  translationSha256: string;
}

export type ArtifactKind = "official" | "derived";

export interface OfficialArtifact {
  /** Absent means `official`, so every artifact built before translations existed reads unchanged. */
  kind?: ArtifactKind;
  manifest: OfficialManifest;
  bundle: MeasureBundle;
}

export const artifactKind = (artifact: Pick<OfficialArtifact, "kind">): ArtifactKind => artifact.kind ?? "official";

/**
 * What a cache keys an artifact by. Never the measure id alone: a translation and CMS's artifact share
 * `cms137`, and a cache keyed by id would score 2027 with 2026 value sets, which for a value-sets-only
 * translation makes it silently identical to the draft it replaces.
 */
export const artifactKey = (artifact: Pick<OfficialArtifact, "kind" | "manifest">): string =>
  `${artifactKind(artifact)}:${artifact.manifest.catalogId}:${artifact.manifest.sha256}`;


/**
 * The eMeasure identifiers QRDA III references a measure by (ADR-046, corrected after review of #357).
 *
 * `manifest.cmsId` is the **publisher** identifier — `"122FHIR"` for CMS122 — and QRDA III's
 * `externalDocument/id` is not that. The published Measure carries the two identifiers a receiver
 * actually resolves, typed by `artifact-identifier-type`:
 *
 *   - **version-specific** → `id/@extension` under root `2.16.840.1.113883.4.738` (the eMeasure
 *     Identifier OID). This names the exact published version whose logic produced the counts.
 *   - **version-independent** → `setId/@root`, the measure's identity across versions.
 *
 * Read from the vendored bundle rather than the manifest so no re-vendor (and no reproducibility-gate
 * churn) is needed: the bundle IS the published artifact, and these values are part of it.
 */
export interface OfficialMeasureIdentifiers {
  versionSpecific?: string;
  versionIndependent?: string;
}

/** Strip the `urn:uuid:` prefix MADiE writes — QRDA carries the bare GUID. */
const bareUuid = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.replace(/^urn:uuid:/i, "") : undefined;
};

export function officialMeasureIdentifiers(artifact: OfficialArtifact): OfficialMeasureIdentifiers {
  const entries = (artifact.bundle as { entry?: Array<{ resource?: Record<string, unknown> }> }).entry ?? [];
  const measure = entries.map((e) => e.resource).find((r) => r?.["resourceType"] === "Measure");
  const identifiers = (measure?.["identifier"] as Array<Record<string, unknown>> | undefined) ?? [];
  const byType = (code: string): string | undefined => {
    for (const id of identifiers) {
      const coding = ((id["type"] as { coding?: Array<{ code?: unknown }> } | undefined)?.coding ?? [])[0];
      if (coding?.code === code) return bareUuid(id["value"]);
    }
    return undefined;
  };
  const versionSpecific = byType("version-specific");
  const versionIndependent = byType("version-independent");
  return {
    ...(versionSpecific ? { versionSpecific } : {}),
    ...(versionIndependent ? { versionIndependent } : {}),
  };
}

const ARTIFACT_ROOT = new URL("../../measures/official/", import.meta.url);
const DERIVED_ROOT = new URL("../../measures/derived/", import.meta.url);

/**
 * `new URL()` normalizes `..`, so an unvalidated id escapes the artifact root ("../../etc/passwd"
 * resolves outside `measures/official/`). Harmless while every id is a literal, but PR-7 makes the id
 * set operator-supplied via `WORKWELL_OFFICIAL_MEASURES` — validate now, while it is cheap.
 */
const VALID_CATALOG_ID = /^[a-z0-9]+$/;

/** Parsed artifacts are cached: the files are committed and immutable for the life of the process. */
const cache = new Map<string, OfficialArtifact | null>();
const derivedCache = new Map<string, OfficialArtifact | null>();

/**
 * Load a vendored artifact, or `null` when it is absent or unusable — a missing artifact is a normal
 * state (only some measures are vendored), and the fidelity route degrades to a lower tier rather than
 * failing. A bundle that IS present but has no pre-compiled ELM is treated the same way: it cannot be
 * executed without translation, which is the thing this whole path exists to avoid.
 */
export function loadOfficialArtifact(catalogId: string): OfficialArtifact | null {
  return loadArtifactOfKind("official", catalogId);
}

/**
 * A WorkWell translation from `measures/derived/<catalogId>/`, or `null` when there is none — the normal
 * state for every measure until its translation lands. Loaded only for measures named in
 * `WORKWELL_DERIVED_MEASURES`, and chosen only for a period it covers (`selectArtifactForPeriod`).
 */
export function loadDerivedArtifact(catalogId: string): OfficialArtifact | null {
  return loadArtifactOfKind("derived", catalogId);
}

function loadArtifactOfKind(kind: ArtifactKind, catalogId: string): OfficialArtifact | null {
  const kindCache = kind === "official" ? cache : derivedCache;
  const cached = kindCache.get(catalogId);
  if (cached !== undefined) return cached;
  const { artifact, cacheable } = readArtifactDir(kind, catalogId, kind === "official" ? ARTIFACT_ROOT : DERIVED_ROOT);
  if (cacheable) kindCache.set(catalogId, artifact);
  return artifact;
}

/**
 * Read one artifact directory, uncached. `cacheable: false` marks a read that FAILED (rather than a file
 * that is absent), which must not be remembered — see the catch below. Exported so the kind refusal can
 * be tested against a temporary directory rather than files written into `measures/`.
 */
export function readArtifactDir(
  kind: ArtifactKind,
  catalogId: string,
  root: URL,
): { artifact: OfficialArtifact | null; cacheable: boolean } {
  if (!VALID_CATALOG_ID.test(catalogId)) return { artifact: null, cacheable: true };

  let artifact: OfficialArtifact | null = null;
  try {
    const manifest = JSON.parse(readFileSync(new URL(`${catalogId}/manifest.json`, root), "utf8")) as OfficialManifest;
    // Each loader refuses the other kind's manifest: a translation dropped into measures/official/ would
    // otherwise run as CMS's artifact for every year, and CMS's under measures/derived/ as a translation.
    if (kind === "official" ? manifest.derived !== undefined : manifest.derived === undefined) {
      console.error(
        `WORKWELL_ALERT ${JSON.stringify({ kind: "OFFICIAL_ARTIFACT_UNUSABLE", catalogId, artifactKind: kind, reason: "manifest is of the other kind" })}`,
      );
      return { artifact: null, cacheable: true };
    }
    const bundle = JSON.parse(readFileSync(new URL(`${catalogId}/bundle.json`, root), "utf8"));
    // An official artifact carries no `kind` field at all, so it is byte-for-byte what it was.
    artifact = isExecutableMeasureBundle(bundle) ? (kind === "official" ? { manifest, bundle } : { kind, manifest, bundle }) : null;
    if (!artifact) {
      console.error(
        `WORKWELL_ALERT ${JSON.stringify({ kind: "OFFICIAL_ARTIFACT_UNUSABLE", catalogId, reason: "bundle has no pre-compiled ELM" })}`,
      );
    }
  } catch (err) {
    // "Not vendored" and "the read failed" are different facts, and caching them the same way is how a
    // transient failure becomes permanent: PR-7 routes production measure execution through here, so a
    // cached null would silently fall back to the authored CQL for the life of the worker — two
    // containers could then report different results for the same measure with no signal anywhere.
    const absent = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    if (!absent) {
      console.error(
        `WORKWELL_ALERT ${JSON.stringify({
          kind: "OFFICIAL_ARTIFACT_LOAD_FAILED",
          catalogId,
          artifactKind: kind,
          message: err instanceof Error ? err.message : String(err),
        })}`,
      );
      return { artifact: null, cacheable: false }; // deliberately NOT cached — a retry may succeed.
    }
    artifact = null;
  }
  return { artifact, cacheable: true };
}

/** True when this measure has a vendored artifact that can actually be executed. */
export function officialArtifactAvailable(catalogId: string): boolean {
  return loadOfficialArtifact(catalogId) !== null;
}

const manifestCache = new Map<string, OfficialManifest | null>();

/**
 * The manifest alone, for read models that only label a measure (which logic runs, which year it was
 * written for). It never parses the multi-megabyte bundle, so `/api/measures` and `/api/programs` do not
 * pay for it. An absent file is cached as `null`; a failed read is not, for the reason
 * `loadOfficialArtifact` gives.
 */
export function loadOfficialManifest(catalogId: string): OfficialManifest | null {
  const fromArtifact = cache.get(catalogId);
  if (fromArtifact) return fromArtifact.manifest;
  const cached = manifestCache.get(catalogId);
  if (cached !== undefined) return cached;
  if (!VALID_CATALOG_ID.test(catalogId)) return null;
  try {
    const manifest = JSON.parse(readFileSync(new URL(`${catalogId}/manifest.json`, ARTIFACT_ROOT), "utf8")) as OfficialManifest;
    manifestCache.set(catalogId, manifest);
    return manifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") manifestCache.set(catalogId, null);
    return null;
  }
}

const derivedManifestCache = new Map<string, OfficialManifest | null>();

/**
 * A translation's manifest alone, for read models that only NAME the logic (a screen saying which year a
 * translation covers). Null when there is none, or when the manifest under measures/derived/ is not a
 * translation's — the same kind rule the full loader applies.
 */
export function loadDerivedManifest(catalogId: string): OfficialManifest | null {
  const fromArtifact = derivedCache.get(catalogId);
  if (fromArtifact) return fromArtifact.manifest;
  const cached = derivedManifestCache.get(catalogId);
  if (cached !== undefined) return cached;
  if (!VALID_CATALOG_ID.test(catalogId)) return null;
  try {
    const manifest = JSON.parse(readFileSync(new URL(`${catalogId}/manifest.json`, DERIVED_ROOT), "utf8")) as OfficialManifest;
    const usable = manifest.derived !== undefined ? manifest : null;
    derivedManifestCache.set(catalogId, usable);
    return usable;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") derivedManifestCache.set(catalogId, null);
    return null;
  }
}

/**
 * Whether an artifact's declared effectivePeriod covers a measurement period, or `null` when the
 * artifact declares none (absent means unknown, not stale). The one definition the run log's warning
 * (`effectivePeriodWarning`) and the measure page's vintage note (`officialLogicVintage`) share.
 */
export function effectivePeriodCovers(
  manifest: Pick<OfficialManifest, "effectivePeriod">,
  period: { start: string; end: string },
): boolean | null {
  const ep = manifest.effectivePeriod;
  if (!ep?.start || !ep?.end) return null;
  return ep.start.slice(0, 10) <= period.start.slice(0, 10) && ep.end.slice(0, 10) >= period.end.slice(0, 10);
}

/**
 * A year scored with logic written for another year. Every vendored artifact declares 2026 only, so from
 * 1 January 2027 the routed measures score PY2027 with 2026 logic until CMS publishes newer FHIR content
 * and it is re-vendored (ROADMAP MM-1d). The run log already says so; this is the same fact for a screen.
 */
export interface OfficialLogicVintage {
  /** The year (or `start–end` years) the artifact declares it was written for. */
  artifactYears: string;
  measurementYear: number;
  note: string;
}

export function officialLogicVintage(
  manifest: Pick<OfficialManifest, "effectivePeriod">,
  measurementYear: number,
): OfficialLogicVintage | null {
  const covered = effectivePeriodCovers(manifest, { start: `${measurementYear}-01-01`, end: `${measurementYear}-12-31` });
  if (covered !== false) return null;
  const startYear = manifest.effectivePeriod!.start!.slice(0, 4);
  const endYear = manifest.effectivePeriod!.end!.slice(0, 4);
  const artifactYears = startYear === endYear ? startYear : `${startYear}–${endYear}`;
  const note = measurementYear > Number(endYear)
    ? `Scored with the ${artifactYears} FHIR logic; ${measurementYear} logic not yet available`
    : `Scored with the ${artifactYears} FHIR logic, not the ${measurementYear} logic`;
  return { artifactYears, measurementYear, note };
}

/**
 * Which artifact scores a measurement period, given CMS's and (when routed) WorkWell's translation:
 *
 *   1. CMS's artifact, when it covers the period — CMS's logic always wins where it exists;
 *   2. otherwise the translation, when it covers the period (`=== true`: a translation that declares no
 *      period is never chosen, so it can never run outside the year it was checked for);
 *   3. otherwise CMS's artifact, with the "scored with prior-year logic" warning it carries today.
 *
 * Pure, so the year boundary is a table test rather than a property of the file system. `null` only when
 * there is no CMS artifact at all: a translation is never routed without the measure it translates.
 */
export function selectArtifactForPeriod(
  candidates: { official: OfficialArtifact | null; derived?: OfficialArtifact | null },
  period: { start: string; end: string },
): OfficialArtifact | null {
  const { official, derived } = candidates;
  if (!official) return null;
  if (effectivePeriodCovers(official.manifest, period) === true) return official;
  if (derived && effectivePeriodCovers(derived.manifest, period) === true) return derived;
  return official;
}

/** @internal test hook */
export function __clearOfficialArtifactCache(): void {
  cache.clear();
  derivedCache.clear();
  manifestCache.clear();
  derivedManifestCache.clear();
}
