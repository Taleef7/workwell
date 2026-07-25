/**
 * Vendored official measure artifacts (roadmap §7.3, PR-5).
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
import { isExecutableMeasureBundle, type MeasureBundle } from "@workwell/official-executor";

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
  source: { repo: string; ref: string; path: string; rawSha256: string };
  reduction: Record<string, unknown>;
  sha256: string;
}

export interface OfficialArtifact {
  manifest: OfficialManifest;
  bundle: MeasureBundle;
}

const ARTIFACT_ROOT = new URL("../../measures/official/", import.meta.url);

/** Parsed artifacts are cached: the files are committed and immutable for the life of the process. */
const cache = new Map<string, OfficialArtifact | null>();

/**
 * Load a vendored artifact, or `null` when it is absent or unusable — a missing artifact is a normal
 * state (only some measures are vendored), and the fidelity route degrades to a lower tier rather than
 * failing. A bundle that IS present but has no pre-compiled ELM is treated the same way: it cannot be
 * executed without translation, which is the thing this whole path exists to avoid.
 */
export function loadOfficialArtifact(catalogId: string): OfficialArtifact | null {
  const cached = cache.get(catalogId);
  if (cached !== undefined) return cached;

  let artifact: OfficialArtifact | null = null;
  try {
    const manifest = JSON.parse(
      readFileSync(new URL(`${catalogId}/manifest.json`, ARTIFACT_ROOT), "utf8"),
    ) as OfficialManifest;
    const bundle = JSON.parse(readFileSync(new URL(`${catalogId}/bundle.json`, ARTIFACT_ROOT), "utf8"));
    artifact = isExecutableMeasureBundle(bundle) ? { manifest, bundle } : null;
  } catch {
    artifact = null;
  }
  cache.set(catalogId, artifact);
  return artifact;
}

/** True when this measure has a vendored artifact that can actually be executed. */
export function officialArtifactAvailable(catalogId: string): boolean {
  return loadOfficialArtifact(catalogId) !== null;
}

/** @internal test hook */
export function __clearOfficialArtifactCache(): void {
  cache.clear();
}
